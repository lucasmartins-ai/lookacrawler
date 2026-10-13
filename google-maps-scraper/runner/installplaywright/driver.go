package installplaywright

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/playwright-community/playwright-go"
)

// ensureDriver provisions the playwright-go driver from npm when it is missing.
//
// playwright-go v0.5700 downloads its driver zip from playwright.azureedge.net
// mirrors that no longer exist (404 for every version), so a fresh install
// fails. The driver is just Node.js plus the playwright-core package, laid out
// as <dir>/node and <dir>/package/cli.js; build that layout ourselves and
// playwright-go finds it up to date and skips the dead download.
// ponytail: drop this once scrapemate releases on mxschmitt/playwright-go,
// which installs from npm itself.
func ensureDriver() error {
	d, err := playwright.NewDriver()
	if err != nil {
		return err
	}
	dir, err := driverDir(d.Version)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, "package", "cli.js")); err == nil {
		return nil
	}

	node, err := nodePath()
	if err != nil {
		return err
	}

	tgz, err := fetchPlaywrightCore(d.Version)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := extractPackage(tgz, dir); err != nil {
		return err
	}

	if os.Getenv("PLAYWRIGHT_NODEJS_PATH") != "" {
		return nil // playwright-go uses that node directly.
	}
	return linkNode(node, filepath.Join(dir, nodeName()))
}

// driverDir mirrors playwright-go's own default (PLAYWRIGHT_DRIVER_PATH, else
// <cache>/ms-playwright-go/<version>).
func driverDir(version string) (string, error) {
	if p := os.Getenv("PLAYWRIGHT_DRIVER_PATH"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	var cache string
	switch runtime.GOOS {
	case "windows":
		cache = filepath.Join(home, "AppData", "Local")
	case "darwin":
		cache = filepath.Join(home, "Library", "Caches")
	default:
		cache = filepath.Join(home, ".cache")
	}
	return filepath.Join(cache, "ms-playwright-go", version), nil
}

func nodeName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func nodePath() (string, error) {
	if p := os.Getenv("PLAYWRIGHT_NODEJS_PATH"); p != "" {
		return p, nil
	}
	p, err := exec.LookPath("node")
	if err != nil {
		return "", errors.New("the browser driver needs Node.js 18+: install it (https://nodejs.org) or set PLAYWRIGHT_NODEJS_PATH")
	}
	return filepath.Abs(p)
}

// fetchPlaywrightCore downloads the exact playwright-core release and checks it
// against the sha512 integrity the npm registry publishes for it.
func fetchPlaywrightCore(version string) ([]byte, error) {
	client := &http.Client{Timeout: 2 * time.Minute}
	get := func(url string) ([]byte, error) {
		res, err := client.Get(url)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GET %s: %s", url, res.Status)
		}
		return io.ReadAll(io.LimitReader(res.Body, 64<<20))
	}

	meta, err := get("https://registry.npmjs.org/playwright-core/" + version)
	if err != nil {
		return nil, err
	}
	var m struct {
		Dist struct {
			Tarball   string `json:"tarball"`
			Integrity string `json:"integrity"`
		} `json:"dist"`
	}
	if err := json.Unmarshal(meta, &m); err != nil {
		return nil, fmt.Errorf("playwright-core %s metadata: %w", version, err)
	}
	if !strings.HasPrefix(m.Dist.Tarball, "https://registry.npmjs.org/") || !strings.HasPrefix(m.Dist.Integrity, "sha512-") {
		return nil, fmt.Errorf("playwright-core %s: unexpected registry metadata", version)
	}

	tgz, err := get(m.Dist.Tarball)
	if err != nil {
		return nil, err
	}
	sum := sha512.Sum512(tgz)
	if "sha512-"+base64.StdEncoding.EncodeToString(sum[:]) != m.Dist.Integrity {
		return nil, fmt.Errorf("playwright-core %s: integrity check failed", version)
	}
	return tgz, nil
}

// extractPackage unpacks an npm tarball (entries under "package/") into dir.
func extractPackage(tgz []byte, dir string) error {
	gz, err := gzip.NewReader(strings.NewReader(string(tgz)))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	root := filepath.Clean(dir) + string(os.PathSeparator)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.FromSlash(h.Name))
		if !strings.HasPrefix(h.Name, "package/") || !strings.HasPrefix(target, root) {
			return fmt.Errorf("unexpected tar entry %q", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode)&0o755|0o644)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		}
	}
}

// linkNode points <dir>/node at the system Node.js; copies where symlinks are
// not allowed (Windows without developer mode).
func linkNode(node, dst string) error {
	_ = os.Remove(dst)
	if err := os.Symlink(node, dst); err == nil {
		return nil
	}
	src, err := os.Open(node)
	if err != nil {
		return err
	}
	defer src.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
