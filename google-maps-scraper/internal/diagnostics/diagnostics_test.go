package diagnostics

import (
	"archive/zip"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiagnosticPackageRedactsSecrets(t *testing.T) {
	t.Setenv("LEADSDB_API_KEY", "super-secret-key")
	report := Run(context.Background(), t.TempDir(), "127.0.0.1:0", nil)
	report.Checks = append(report.Checks, Check{Name: "synthetic", Status: "warning", Detail: sanitize("super-secret-key")})
	path := filepath.Join(t.TempDir(), "diagnostics.zip")
	if err := WritePackage(path, report); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm()&0o077 != 0 {
		t.Fatalf("unsafe permissions: %o", st.Mode().Perm())
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(r)
		_ = r.Close()
		if strings.Contains(string(data), "super-secret-key") {
			t.Fatalf("secret leaked in %s", f.Name)
		}
	}
}
