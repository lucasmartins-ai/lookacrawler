package web_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coelhobugado/google-maps-scraper/web"
	websqlite "github.com/coelhobugado/google-maps-scraper/web/sqlite"
)

func TestHTTPPerimeterAndCampaignAPI(t *testing.T) {
	dir := t.TempDir()
	repo, err := websqlite.New(filepath.Join(dir, "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	svc := web.NewService(repo, dir)
	defer svc.Close()
	srv, err := web.New(svc, "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	h := srv.Handler()

	do := func(method, path, host string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost"+path, bytes.NewReader(body))
		r.Host = host
		r.RemoteAddr = "127.0.0.1:1234"
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := do("GET", "/healthz", "evil.example", nil, nil); w.Code != http.StatusMisdirectedRequest {
		t.Fatalf("host guard=%d", w.Code)
	}
	if w := do("GET", "/api/v1/jobs", "localhost", nil, nil); w.Code != http.StatusOK {
		t.Fatalf("local access=%d body=%s", w.Code, w.Body.String())
	}
	if w := do("GET", "/healthz", "localhost", nil, nil); w.Code != http.StatusOK || w.Header().Get("X-Request-ID") == "" {
		t.Fatalf("health=%d request-id=%q", w.Code, w.Header().Get("X-Request-ID"))
	}

	crossOrigin := map[string]string{"Content-Type": "application/json", "Origin": "http://evil.example"}
	if w := do("POST", "/api/v1/jobs", "localhost", []byte(`{"data":{"keywords":["cafe"]}}`), crossOrigin); w.Code != http.StatusForbidden {
		t.Fatalf("cross origin=%d body=%s", w.Code, w.Body.String())
	}
	headers := map[string]string{"Content-Type": "application/json", "Origin": "http://localhost", "Idempotency-Key": "test-key"}
	w := do("POST", "/api/v1/jobs", "localhost", []byte(`{"name":"Cafés","data":{"keywords":["café"]}}`), headers)
	if w.Code != http.StatusCreated {
		t.Fatalf("create=%d body=%s", w.Code, w.Body.String())
	}
	if w = do("POST", "/api/v1/jobs", "localhost", []byte(`{"name":"Outra","data":{"keywords":["café"]}}`), headers); w.Code != http.StatusOK {
		t.Fatalf("idempotency=%d body=%s", w.Code, w.Body.String())
	}
	if w = do("GET", "/api/v1/jobs?limit=10&offset=0", "localhost", nil, nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Cafés") {
		t.Fatalf("list=%d body=%s", w.Code, w.Body.String())
	}

	w = do("GET", "/api/v1/capabilities", "localhost", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("capabilities=%d", w.Code)
	}
	var capabilities map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &capabilities); err != nil {
		t.Fatal(err)
	}
	if capabilities["authentication"] != "none" {
		t.Fatalf("unexpected authentication mode: %v", capabilities["authentication"])
	}
}
