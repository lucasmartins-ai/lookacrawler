package runner

import (
	"strings"
	"testing"
)

func TestParseConfigRejectsProxyCredentialsOnCommandLine(t *testing.T) {
	_, err := ParseConfigArgs([]string{"-proxies", "http://user:password@example.com:8080"})
	if err == nil || !strings.Contains(err.Error(), "GMAPS_PROXIES_FILE") {
		t.Fatalf("expected safe proxy credential error, got %v", err)
	}
}

func TestConfigValidationBoundaries(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Concurrency = 0
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected invalid concurrency")
	}
	cfg = DefaultConfig()
	cfg.FastMode = true
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected missing coordinates")
	}
	cfg = DefaultConfig()
	cfg.MaxGridCells = 100001
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected grid limit error")
	}
}
