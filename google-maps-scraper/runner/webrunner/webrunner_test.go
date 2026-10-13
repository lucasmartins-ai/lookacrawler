package webrunner

import (
	"encoding/csv"
	"os"
	"path/filepath"
	"testing"

	"github.com/coelhobugado/google-maps-scraper/runner"
)

func TestSanitizeCSVAndCount(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "raw.csv")
	dest := filepath.Join(dir, "safe.csv")
	if err := os.WriteFile(source, []byte("name,phone\n=cmd,123\nnormal,456\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	count, err := sanitizeCSV(source, dest)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("count=%d want 2", count)
	}
	f, err := os.Open(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if rows[1][0] != "'=cmd" {
		t.Fatalf("unsafe cell not escaped: %q", rows[1][0])
	}
}

func TestValidateBind(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  runner.Config
		ok   bool
	}{
		{"loopback", runner.Config{Addr: "127.0.0.1:8080"}, true},
		{"public denied", runner.Config{Addr: "0.0.0.0:8080"}, false},
		{"public no hosts", runner.Config{Addr: "0.0.0.0:8080", AllowNetwork: true}, false},
		{"public explicit", runner.Config{Addr: "0.0.0.0:8080", AllowNetwork: true, AllowedHosts: []string{"app.local"}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateBind(&tc.cfg)
			if (err == nil) != tc.ok {
				t.Fatalf("err=%v ok=%v", err, tc.ok)
			}
		})
	}
}
