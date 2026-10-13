package installplaywright

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func tgz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestExtractPackage(t *testing.T) {
	dir := t.TempDir()
	if err := extractPackage(tgz(t, map[string]string{"package/cli.js": "x"}), dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "package", "cli.js")); err != nil {
		t.Fatal(err)
	}

	for _, evil := range []string{"package/../../escape.js", "other/cli.js"} {
		if err := extractPackage(tgz(t, map[string]string{evil: "x"}), t.TempDir()); err == nil {
			t.Errorf("%q: expected an error", evil)
		}
	}
}
