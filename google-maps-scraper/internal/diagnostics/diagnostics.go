package diagnostics

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Check struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

type Report struct {
	GeneratedAt time.Time `json:"generated_at"`
	GoVersion   string    `json:"go_version"`
	OS          string    `json:"os"`
	Arch        string    `json:"arch"`
	CPUs        int       `json:"cpus"`
	Checks      []Check   `json:"checks"`
}

func Run(ctx context.Context, dataDir, addr string, db *sql.DB) Report {
	r := Report{GeneratedAt: time.Now().UTC(), GoVersion: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH, CPUs: runtime.NumCPU()}
	add := func(name, status, detail string) {
		r.Checks = append(r.Checks, Check{Name: name, Status: status, Detail: sanitize(detail)})
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		add("data_directory", "failed", err.Error())
	} else {
		_ = os.Chmod(dataDir, 0o700)
		p := filepath.Join(dataDir, ".write-test")
		if err := os.WriteFile(p, []byte("ok"), 0o600); err != nil {
			add("data_directory", "failed", err.Error())
		} else {
			_ = os.Remove(p)
			add("data_directory", "ok", "")
		}
	}
	if db != nil {
		if err := db.PingContext(ctx); err != nil {
			add("database", "failed", err.Error())
		} else {
			add("database", "ok", "")
		}
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		add("port", "warning", "address is already in use or unavailable")
	} else {
		_ = ln.Close()
		add("port", "ok", "")
	}
	if browserInstalled() {
		add("browser", "ok", "")
	} else {
		add("browser", "warning", "Playwright browser cache not found; run install-browser")
	}
	if _, err := exec.LookPath("google-chrome"); err == nil {
		add("system_browser", "ok", "")
	} else {
		add("system_browser", "info", "system Chrome not found; bundled Playwright browser is preferred")
	}
	return r
}

func browserInstalled() bool {
	candidates := []string{os.Getenv("PLAYWRIGHT_BROWSERS_PATH"), filepath.Join(os.Getenv("HOME"), ".cache", "ms-playwright"), filepath.Join(os.Getenv("HOME"), ".cache", "ms-playwright-go")}
	for _, path := range candidates {
		if strings.TrimSpace(path) == "" {
			continue
		}
		entries, err := os.ReadDir(path)
		if err == nil && len(entries) > 0 {
			return true
		}
	}
	return false
}

func sanitize(value string) string {
	for _, key := range []string{"LEADSDB_API_KEY", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "GMAPS_DATABASE_URL"} {
		if secret := os.Getenv(key); secret != "" {
			value = strings.ReplaceAll(value, secret, "[REDACTED]")
		}
	}
	return value
}

func WritePackage(path string, r Report) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	w, err := zw.Create("diagnostics.json")
	if err != nil {
		return err
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(r); err != nil {
		return err
	}
	readme, err := zw.Create("README.txt")
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintln(readme, "Pacote de diagnóstico sem tokens, proxies, palavras-chave ou resultados."); err != nil {
		return err
	}
	return zw.Close()
}
