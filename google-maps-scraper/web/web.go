package web

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/coelhobugado/google-maps-scraper/internal/metrics"
	"github.com/coelhobugado/google-maps-scraper/internal/redact"
	"github.com/coelhobugado/google-maps-scraper/internal/safehttp"
	"github.com/coelhobugado/google-maps-scraper/internal/version"
	"golang.org/x/time/rate"
)

//go:embed static
var staticFiles embed.FS

type Option func(*serverConfig)
type serverConfig struct {
	allowedHosts  []string
	retentionDays int
	maxBody       int64
}

func WithAllowedHosts(hosts []string) Option {
	return func(c *serverConfig) { c.allowedHosts = append([]string(nil), hosts...) }
}
func WithRetention(days int) Option      { return func(c *serverConfig) { c.retentionDays = days } }
func WithMaxRequestBytes(n int64) Option { return func(c *serverConfig) { c.maxBody = n } }

type Server struct {
	srv           *http.Server
	svc           *Service
	metrics       *metrics.Registry
	allowedHosts  map[string]bool
	maxBody       int64
	retentionDays int
	limiterMu     sync.Mutex
	limiters      map[string]*rate.Limiter
	geoMu         sync.Mutex
	geoCache      map[string]geoCacheEntry
}
type geoCacheEntry struct {
	expires time.Time
	data    []geoResult
}

type geoResult struct {
	DisplayName string `json:"display_name"`
	Lat         string `json:"lat"`
	Lon         string `json:"lon"`
	Type        string `json:"type,omitempty"`
	CountryCode string `json:"country_code,omitempty"`
}

type photonResponse struct {
	Features []struct {
		Properties struct {
			Name        string `json:"name"`
			Street      string `json:"street"`
			Housenumber string `json:"housenumber"`
			Locality    string `json:"locality"`
			District    string `json:"district"`
			City        string `json:"city"`
			County      string `json:"county"`
			State       string `json:"state"`
			Postcode    string `json:"postcode"`
			Country     string `json:"country"`
			Countrycode string `json:"countrycode"`
			OsmValue    string `json:"osm_value"`
			Type        string `json:"type"`
		} `json:"properties"`
		Geometry struct {
			Coordinates []float64 `json:"coordinates"`
		} `json:"geometry"`
	} `json:"features"`
}

type openMeteoResponse struct {
	Results []struct {
		Name        string  `json:"name"`
		Country     string  `json:"country"`
		CountryCode string  `json:"country_code"`
		Admin1      string  `json:"admin1"`
		Admin2      string  `json:"admin2"`
		Admin3      string  `json:"admin3"`
		Admin4      string  `json:"admin4"`
		FeatureCode string  `json:"feature_code"`
		Latitude    float64 `json:"latitude"`
		Longitude   float64 `json:"longitude"`
	} `json:"results"`
}

func New(svc *Service, addr string, opts ...Option) (*Server, error) {
	if svc == nil {
		return nil, errors.New("service is required")
	}
	cfg := serverConfig{retentionDays: 30, maxBody: 1 << 20}
	for _, opt := range opts {
		opt(&cfg)
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("invalid listen address: %w", err)
	}
	allowed := map[string]bool{"localhost": true, "127.0.0.1": true, "[::1]": true, "::1": true}
	if host != "" {
		allowed[strings.ToLower(strings.Trim(host, "[]"))] = true
	}
	for _, h := range cfg.allowedHosts {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" {
			allowed[h] = true
		}
	}
	s := &Server{svc: svc, metrics: metrics.New(), allowedHosts: allowed, maxBody: cfg.maxBody, retentionDays: cfg.retentionDays, limiters: map[string]*rate.Limiter{}, geoCache: map[string]geoCacheEntry{}}
	mux := http.NewServeMux()
	s.routes(mux)
	handler := s.recoverMiddleware(s.requestMetrics(s.securityHeaders(s.hostGuard(s.rateLimit(s.sameOriginGuard(mux))))))
	s.srv = &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 2 * time.Minute, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 1 << 20}
	return s, nil
}
func (s *Server) Handler() http.Handler { return s.srv.Handler }
func (s *Server) BaseURL() string       { return "http://" + s.srv.Addr }
func (s *Server) Start(ctx context.Context) error {
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.srv.Shutdown(shutdownCtx)
	}()
	fmt.Fprintf(os.Stderr, "Interface local: %s\n", s.BaseURL())
	err := s.srv.ListenAndServe()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) routes(mux *http.ServeMux) {
	staticFS, _ := fs.Sub(staticFiles, "static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /", s.app)
	mux.HandleFunc("GET /api/docs", s.docs)
	mux.HandleFunc("GET /api/openapi.yaml", s.openapi)
	mux.HandleFunc("GET /api/v1/capabilities", s.capabilities)
	mux.HandleFunc("POST /api/v1/estimate", s.estimate)
	mux.HandleFunc("GET /api/v1/jobs", s.listJobs)
	mux.HandleFunc("POST /api/v1/jobs", s.createJob)
	mux.HandleFunc("GET /api/v1/jobs/{id}", s.getJob)
	mux.HandleFunc("DELETE /api/v1/jobs/{id}", s.deleteJob)
	mux.HandleFunc("POST /api/v1/jobs/{id}/cancel", s.cancelJob)
	mux.HandleFunc("POST /api/v1/jobs/{id}/retry", s.retryJob)
	mux.HandleFunc("POST /api/v1/jobs/{id}/clone", s.cloneJob)
	mux.HandleFunc("GET /api/v1/jobs/{id}/events", s.jobEvents)
	mux.HandleFunc("GET /api/v1/jobs/{id}/results", s.jobResults)
	mux.HandleFunc("GET /api/v1/jobs/{id}/stats", s.jobStats)
	mux.HandleFunc("GET /api/v1/jobs/{id}/recommendations", s.jobRecommendations)
	mux.HandleFunc("GET /api/v1/jobs/{id}/download", s.downloadResults)
	mux.HandleFunc("GET /api/v1/jobs/{id}/exports", s.listExports)
	mux.HandleFunc("POST /api/v1/jobs/{id}/exports", s.createExport)
	mux.HandleFunc("GET /api/v1/jobs/{id}/exports/{exportID}/download", s.downloadExport)
	mux.HandleFunc("GET /api/v1/templates", s.listTemplates)
	mux.HandleFunc("POST /api/v1/templates", s.saveTemplate)
	mux.HandleFunc("DELETE /api/v1/templates/{id}", s.deleteTemplate)
	mux.HandleFunc("POST /api/v1/retention/run", s.runRetention)
	mux.HandleFunc("GET /api/v1/metrics", s.metrics.Handler)
	mux.HandleFunc("GET /api/v1/geocode", s.geocode)
	mux.HandleFunc("POST /api/v1/proxies/test", s.testProxy)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	jsonResponse(w, http.StatusOK, map[string]any{"status": "ok", "version": version.Version})
}
func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if _, err := s.svc.Count(r.Context(), ""); err != nil {
		jsonError(w, http.StatusServiceUnavailable, "not_ready", "database unavailable")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]string{"status": "ready"})
}
func (s *Server) app(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	data, err := staticFiles.ReadFile("static/app.html")
	if err != nil {
		jsonError(w, 500, "asset_error", "interface unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}
func (s *Server) docs(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>API local</title><body><main><h1>API local</h1><p>A API acompanha a instalação local e permanece limitada ao endereço configurado no aplicativo.</p><p><a href="/api/openapi.yaml">Baixar contrato OpenAPI</a></p></main></body></html>`)
}
func (s *Server) openapi(w http.ResponseWriter, _ *http.Request) {
	data, err := staticFiles.ReadFile("static/openapi.yaml")
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	w.Header().Set("Content-Type", "application/yaml")
	_, _ = w.Write(data)
}
func (s *Server) capabilities(w http.ResponseWriter, _ *http.Request) {
	jsonResponse(w, 200, map[string]any{"local_only": true, "authentication": "none", "formats": []string{"csv", "json"}, "features": []string{"campaigns", "cancellation", "leases", "events", "results", "direct_download", "filtered_exports", "templates", "retention", "geocoding"}})
}

type jobDataRequest struct {
	Keywords       []string      `json:"keywords"`
	Location       string        `json:"location,omitempty"`
	Lang           string        `json:"lang"`
	Zoom           int           `json:"zoom"`
	Lat            string        `json:"lat,omitempty"`
	Lon            string        `json:"lon,omitempty"`
	FastMode       bool          `json:"fast_mode"`
	Radius         int           `json:"radius"`
	Depth          int           `json:"depth"`
	Email          bool          `json:"email"`
	ExtraReviews   bool          `json:"extra_reviews"`
	MaxTimeMinutes int           `json:"max_time_minutes,omitempty"`
	LegacyMaxTime  time.Duration `json:"max_time,omitempty"`
	Proxies        []string      `json:"proxies,omitempty"`
}

func (r jobDataRequest) domain() (JobData, error) {
	maxTime := r.LegacyMaxTime
	if r.MaxTimeMinutes != 0 {
		if r.MaxTimeMinutes < 1 || r.MaxTimeMinutes > 24*60 {
			return JobData{}, errors.New("max_time_minutes must be between 1 and 1440")
		}
		maxTime = time.Duration(r.MaxTimeMinutes) * time.Minute
	}
	d := JobData{Keywords: r.Keywords, Location: r.Location, Lang: r.Lang, Zoom: r.Zoom, Lat: r.Lat, Lon: r.Lon, FastMode: r.FastMode, Radius: r.Radius, Depth: r.Depth, Email: r.Email, ExtraReviews: r.ExtraReviews, MaxTime: maxTime, Proxies: r.Proxies}
	if err := d.Validate(); err != nil {
		return JobData{}, err
	}
	return d, nil
}

func (s *Server) estimate(w http.ResponseWriter, r *http.Request) {
	var input jobDataRequest
	if !decodeJSON(w, r, s.maxBody, &input) {
		return
	}
	d, err := input.domain()
	if err != nil {
		jsonError(w, 400, "invalid_job", err.Error())
		return
	}
	seed := len(d.Keywords)
	requests := seed * max(1, d.Depth) * 3
	if d.Email {
		requests += seed
	}
	mins := max(1, (requests+29)/30)
	jsonResponse(w, 200, map[string]int{"seed_jobs": seed, "estimated_requests": requests, "estimated_minutes": mins})
}

type createRequest struct {
	Name string         `json:"name"`
	Data jobDataRequest `json:"data"`
}

func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if !decodeJSON(w, r, s.maxBody, &req) {
		return
	}
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	id := uuid.New().String()
	if key != "" {
		if len(key) > 200 {
			jsonError(w, 400, "invalid_idempotency_key", "idempotency key is too long")
			return
		}
		id = uuid.NewSHA1(uuid.NameSpaceURL, []byte(key)).String()
	}
	data, err := req.Data.domain()
	if err != nil {
		jsonError(w, 400, "invalid_job", err.Error())
		return
	}
	now := time.Now().UTC()
	job := Job{ID: id, Name: req.Name, Date: now, UpdatedAt: now, Status: StatusQueued, Data: data, IdempotencyKey: key, MaxAttempts: 3}
	if err := job.Validate(); err != nil {
		jsonError(w, 400, "invalid_job", err.Error())
		return
	}
	if err := s.svc.Create(r.Context(), &job); err != nil {
		if errors.Is(err, ErrAlreadyExists) {
			existing, getErr := s.svc.Get(r.Context(), id)
			if getErr == nil {
				jsonResponse(w, 200, existing)
				return
			}
			jsonError(w, 409, "duplicate", "request already exists")
			return
		}
		jsonError(w, 500, "create_failed", "could not create campaign")
		return
	}
	jsonResponse(w, 201, job)
}
func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 50, 1, 200)
	offset := queryInt(r, "offset", 0, 0, 1_000_000)
	status := r.URL.Query().Get("status")
	if status != "" && !ValidStatus(status) {
		jsonError(w, 400, "invalid_status", "invalid status")
		return
	}
	items, err := s.svc.Select(r.Context(), SelectParams{Status: status, Limit: limit, Offset: offset})
	if err != nil {
		jsonError(w, 500, "list_failed", "could not list campaigns")
		return
	}
	total, _ := s.svc.Count(r.Context(), status)
	summary := map[string]int{}
	for _, st := range []string{StatusQueued, StatusRunning, StatusSucceeded, StatusFailed, StatusTimedOut, StatusCanceled, StatusInterrupted, StatusWorkerLost} {
		summary[st], _ = s.svc.Count(r.Context(), st)
		s.metrics.SetJobStatus(st, summary[st])
	}
	jsonResponse(w, 200, map[string]any{"items": items, "total": total, "limit": limit, "offset": offset, "summary": summary})
}
func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.mustJob(w, r)
	if !ok {
		return
	}
	jsonResponse(w, 200, job)
}
func (s *Server) deleteJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.mustJob(w, r)
	if !ok {
		return
	}
	if job.Status == StatusRunning {
		jsonError(w, 409, "running", "cancel the running campaign before deleting it")
		return
	}
	if err := s.svc.Delete(r.Context(), job.ID); err != nil {
		jsonError(w, 500, "delete_failed", "could not delete campaign")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.svc.Cancel(r.Context(), id); err != nil {
		jsonError(w, 409, "cancel_failed", err.Error())
		return
	}
	jsonResponse(w, 202, map[string]bool{"accepted": true})
}
func (s *Server) retryJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.svc.Retry(r.Context(), id); err != nil {
		jsonError(w, 409, "retry_failed", err.Error())
		return
	}
	job, _ := s.svc.Get(r.Context(), id)
	jsonResponse(w, 200, job)
}
func (s *Server) cloneJob(w http.ResponseWriter, r *http.Request) {
	original, ok := s.mustJob(w, r)
	if !ok {
		return
	}
	now := time.Now().UTC()
	copy := Job{ID: uuid.New().String(), Name: original.Name + " (cópia)", Date: now, UpdatedAt: now, Status: StatusQueued, Data: original.Data, MaxAttempts: original.MaxAttempts}
	if err := s.svc.Create(r.Context(), &copy); err != nil {
		jsonError(w, 500, "clone_failed", "could not clone campaign")
		return
	}
	jsonResponse(w, 201, copy)
}

func (s *Server) jobEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		s.streamEvents(w, r, id)
		return
	}
	events, err := s.svc.Events(r.Context(), id, queryInt(r, "limit", 100, 1, 500))
	if err != nil {
		jsonError(w, 500, "events_failed", "could not load events")
		return
	}
	jsonResponse(w, 200, map[string]any{"items": events})
}
func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request, id string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, 500, "stream_unavailable", "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	last := int64(0)
	send := func() bool {
		events, err := s.svc.Events(r.Context(), id, 100)
		if err != nil {
			return false
		}
		for i := len(events) - 1; i >= 0; i-- {
			e := events[i]
			if e.ID <= last {
				continue
			}
			raw, _ := json.Marshal(e)
			fmt.Fprintf(w, "id: %d\nevent: job\ndata: %s\n\n", e.ID, raw)
			last = e.ID
		}
		flusher.Flush()
		return true
	}
	if !send() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !send() {
				return
			}
		}
	}
}

func (s *Server) jobResults(w http.ResponseWriter, r *http.Request) {
	job, ok := s.mustJob(w, r)
	if !ok {
		return
	}
	path, err := s.resultPath(job)
	if err != nil {
		jsonError(w, 404, "results_not_found", "results are not available")
		return
	}
	filter := parseFilter(r)
	limit := queryInt(r, "limit", 100, 1, 500)
	offset := queryInt(r, "offset", 0, 0, 10_000_000)
	rows, header, total, err := ReadResultPage(path, filter, limit, offset)
	if err != nil {
		jsonError(w, 500, "results_failed", "could not read results")
		return
	}
	jsonResponse(w, 200, map[string]any{"header": header, "rows": rows, "total": total, "limit": limit, "offset": offset, "partial": job.PartialResults})
}
func (s *Server) jobStats(w http.ResponseWriter, r *http.Request) {
	job, ok := s.mustJob(w, r)
	if !ok {
		return
	}
	path, err := s.resultPath(job)
	if err != nil {
		jsonError(w, 404, "results_not_found", "results are not available")
		return
	}
	rows, header, total, err := ReadResultPage(path, ResultFilter{}, 0, 0)
	if err != nil {
		jsonError(w, 500, "stats_failed", "could not calculate statistics")
		return
	}
	idx := headerIndex(header)
	withPhone, withWebsite, withInstagram, withEmail := 0, 0, 0, 0
	ratings, totalRating := 0, 0.0
	categories := map[string]int{}
	for _, row := range rows {
		record := resultRecord{row: row, idx: idx}
		if value(row, idx, "phone", "phone_number") != "" {
			withPhone++
		}
		website, instagram := record.contacts()
		if website != "" {
			withWebsite++
		}
		if instagram != "" {
			withInstagram++
		}
		if value(row, idx, "email", "emails") != "" {
			withEmail++
		}
		if v := value(row, idx, "review_rating", "rating"); v != "" {
			if n, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", "."), 64); err == nil {
				ratings++
				totalRating += n
			}
		}
		if c := record.category(); c != "" {
			categories[c]++
		}
	}
	avg := 0.0
	if ratings > 0 {
		avg = totalRating / float64(ratings)
	}
	jsonResponse(w, 200, map[string]any{"total": total, "with_phone": withPhone, "with_website": withWebsite, "with_instagram": withInstagram, "with_email": withEmail, "average_rating": avg, "categories": categories})
}
func (s *Server) jobRecommendations(w http.ResponseWriter, r *http.Request) {
	job, ok := s.mustJob(w, r)
	if !ok {
		return
	}
	recommendations := []string{}
	if job.ResultsCount == 0 {
		recommendations = append(recommendations, "Revise termos, localização e profundidade antes de executar novamente.")
	}
	if job.PartialResults {
		recommendations = append(recommendations, "Há resultados parciais; aumente o tempo máximo ou reduza o escopo.")
	}
	if job.Data.Email {
		recommendations = append(recommendations, "Revise os e-mails enriquecidos antes de qualquer contato e respeite a legislação aplicável.")
	}
	if job.Status == StatusSucceeded && job.ResultsCount > 0 {
		recommendations = append(recommendations, "Crie uma exportação filtrada para trabalhar apenas com os contatos relevantes.")
	}
	jsonResponse(w, 200, map[string]any{"items": recommendations})
}
func (s *Server) downloadResults(w http.ResponseWriter, r *http.Request) {
	job, ok := s.mustJob(w, r)
	if !ok {
		return
	}
	path, err := s.resultPath(job)
	if err != nil {
		jsonError(w, 404, "results_not_found", "results are not available")
		return
	}
	shortID := job.ID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	serveFriendlyDownload(w, path, "resultados-"+shortID+".csv")
}
func (s *Server) listExports(w http.ResponseWriter, r *http.Request) {
	items, err := s.svc.Exports(r.Context(), r.PathValue("id"))
	if err != nil {
		jsonError(w, 500, "exports_failed", "could not list exports")
		return
	}
	jsonResponse(w, 200, map[string]any{"items": items})
}
func (s *Server) createExport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Search       string  `json:"search"`
		Category     string  `json:"category"`
		MinRating    float64 `json:"min_rating"`
		HasPhone     *bool   `json:"has_phone"`
		HasWebsite   *bool   `json:"has_website"`
		HasInstagram *bool   `json:"has_instagram"`
		HasEmail     *bool   `json:"has_email"`
	}
	if !decodeJSON(w, r, s.maxBody, &body) {
		return
	}
	x, err := s.svc.CreateExport(r.Context(), r.PathValue("id"), ResultFilter{Search: body.Search, Category: body.Category, MinRating: body.MinRating, HasPhone: body.HasPhone, HasWebsite: body.HasWebsite, HasInstagram: body.HasInstagram, HasEmail: body.HasEmail})
	if err != nil {
		jsonError(w, 500, "export_failed", "could not create export")
		return
	}
	s.metrics.IncExport()
	jsonResponse(w, 201, x)
}
func (s *Server) downloadExport(w http.ResponseWriter, r *http.Request) {
	items, err := s.svc.Exports(r.Context(), r.PathValue("id"))
	if err != nil {
		jsonError(w, 500, "exports_failed", "could not list exports")
		return
	}
	for _, x := range items {
		if x.ID == r.PathValue("exportID") {
			shortID := r.PathValue("id")
			if len(shortID) > 8 {
				shortID = shortID[:8]
			}
			serveDownload(w, r, x.Path, "resultados-filtrados-"+shortID+".csv")
			return
		}
	}
	jsonError(w, 404, "export_not_found", "export not found")
}

func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	items, err := s.svc.Templates(r.Context())
	if err != nil {
		jsonError(w, 500, "templates_failed", "could not list templates")
		return
	}
	jsonResponse(w, 200, map[string]any{"items": items})
}
func (s *Server) saveTemplate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID   string         `json:"id"`
		Name string         `json:"name"`
		Data jobDataRequest `json:"data"`
	}
	if !decodeJSON(w, r, s.maxBody, &input) {
		return
	}
	data, err := input.Data.domain()
	if err != nil {
		jsonError(w, 400, "template_invalid", err.Error())
		return
	}
	t := Template{ID: input.ID, Name: input.Name, Data: data}
	if t.ID == "" {
		t.ID = uuid.New().String()
	}
	if err := s.svc.SaveTemplate(r.Context(), t); err != nil {
		jsonError(w, 400, "template_invalid", err.Error())
		return
	}
	jsonResponse(w, 201, t)
}
func (s *Server) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.DeleteTemplate(r.Context(), r.PathValue("id")); err != nil {
		jsonError(w, 404, "template_not_found", "template not found")
		return
	}
	w.WriteHeader(204)
}
func (s *Server) runRetention(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Days int `json:"days"`
	}
	if !decodeJSON(w, r, s.maxBody, &body) {
		return
	}
	days := body.Days
	if days == 0 {
		days = s.retentionDays
	}
	if days < 1 || days > 3650 {
		jsonError(w, 400, "invalid_retention", "days must be between 1 and 3650")
		return
	}
	n, err := s.svc.Purge(r.Context(), time.Now().UTC().AddDate(0, 0, -days))
	if err != nil {
		jsonError(w, 500, "retention_failed", "retention failed")
		return
	}
	jsonResponse(w, 200, map[string]int{"deleted": n})
}

func (s *Server) geocode(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) < 3 || len(query) > 200 {
		jsonError(w, 400, "invalid_query", "query must contain 3 to 200 characters")
		return
	}
	key := strings.ToLower(query)
	s.geoMu.Lock()
	if c, ok := s.geoCache[key]; ok && time.Now().Before(c.expires) {
		s.geoMu.Unlock()
		jsonResponse(w, 200, c.data)
		return
	}
	s.geoMu.Unlock()
	broadFirst := strings.IndexAny(query, "0123456789") >= 0
	results, err := photonSearch(r.Context(), query, broadFirst)
	if err == nil && len(results) == 0 && !broadFirst {
		results, err = photonSearch(r.Context(), query, true)
	}
	if err != nil || len(results) == 0 {
		fallback, fallbackErr := openMeteoSearch(r.Context(), query)
		if fallbackErr == nil {
			results, err = fallback, nil
		} else if err == nil {
			err = fallbackErr
		} else {
			err = errors.Join(err, fallbackErr)
		}
	}
	if err != nil {
		slog.Warn("geocode request failed", "error", redact.String(err.Error()))
		jsonError(w, 502, "geocode_failed", "geocoding service unavailable")
		return
	}
	s.geoMu.Lock()
	if len(s.geoCache) > 500 {
		s.geoCache = map[string]geoCacheEntry{}
	}
	s.geoCache[key] = geoCacheEntry{expires: time.Now().Add(24 * time.Hour), data: results}
	s.geoMu.Unlock()
	jsonResponse(w, 200, results)
}

func photonSearch(ctx context.Context, query string, broad bool) ([]geoResult, error) {
	params := photonQueryParams(query, broad)
	raw, status, err := geocodingGet(ctx, "https://photon.komoot.io/api/?"+params.Encode())
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("photon returned HTTP %d", status)
	}
	var response photonResponse
	if err = json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("decode photon response: %w", err)
	}
	results := make([]geoResult, 0, len(response.Features))
	seen := map[string]bool{}
	for _, f := range response.Features {
		if len(f.Geometry.Coordinates) < 2 {
			continue
		}
		street := strings.TrimSpace(strings.TrimSpace(f.Properties.Street) + " " + strings.TrimSpace(f.Properties.Housenumber))
		parts := []string{}
		for _, p := range []string{f.Properties.Name, street, f.Properties.Locality, f.Properties.District, f.Properties.City, f.Properties.County, f.Properties.State, f.Properties.Postcode, f.Properties.Country} {
			p = strings.TrimSpace(p)
			if p != "" && (len(parts) == 0 || parts[len(parts)-1] != p) {
				parts = append(parts, p)
			}
		}
		display := strings.Join(parts, ", ")
		lat := strconv.FormatFloat(f.Geometry.Coordinates[1], 'f', 6, 64)
		lon := strconv.FormatFloat(f.Geometry.Coordinates[0], 'f', 6, 64)
		dedupeKey := strings.ToLower(display + "|" + lat + "|" + lon)
		if display == "" || seen[dedupeKey] {
			continue
		}
		seen[dedupeKey] = true
		placeType := f.Properties.Type
		if placeType == "" {
			placeType = f.Properties.OsmValue
		}
		results = append(results, geoResult{DisplayName: display, Lat: lat, Lon: lon, Type: geoTypeLabel(placeType), CountryCode: strings.ToUpper(f.Properties.Countrycode)})
	}
	return results, nil
}

func photonQueryParams(query string, broad bool) url.Values {
	params := url.Values{}
	params.Set("q", query)
	params.Set("limit", "8")
	// O endpoint público do Photon aceita apenas um conjunto limitado de
	// idiomas. Sem "lang", ele devolve o nome nativo — português no Brasil.
	// A preferência geográfica melhora a ordem para o público brasileiro sem
	// impedir que uma busca explícita por outro país funcione.
	params.Set("lat", "-14.2350")
	params.Set("lon", "-51.9253")
	params.Set("zoom", "3")
	params.Set("location_bias_scale", "0.35")
	if !broad {
		for _, layer := range []string{"city", "district", "locality", "state", "country"} {
			params.Add("layer", layer)
		}
	}
	return params
}

func geoTypeLabel(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "city", "town", "municipality":
		return "Cidade"
	case "village", "hamlet":
		return "Localidade"
	case "suburb", "neighbourhood", "quarter", "district":
		return "Bairro ou distrito"
	case "state", "region":
		return "Estado ou região"
	case "country":
		return "País"
	case "postcode":
		return "CEP"
	case "street", "residential", "road":
		return "Endereço"
	default:
		return "Local"
	}
}

func openMeteoSearch(ctx context.Context, query string) ([]geoResult, error) {
	for _, candidate := range openMeteoQueryCandidates(query) {
		results, err := openMeteoRequest(ctx, candidate)
		if err != nil {
			return nil, err
		}
		if len(results) > 0 {
			return results, nil
		}
	}
	return nil, nil
}

func openMeteoQueryCandidates(query string) []string {
	query = strings.TrimSpace(query)
	candidates := []string{query}
	if comma := strings.Index(query, ","); comma > 0 {
		candidates = append(candidates, strings.TrimSpace(query[:comma]))
	}
	fields := strings.Fields(query)
	if len(fields) > 1 && len([]rune(fields[len(fields)-1])) == 2 {
		candidates = append(candidates, strings.Join(fields[:len(fields)-1], " "))
	}
	result := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate != "" && !slices.Contains(result, candidate) {
			result = append(result, candidate)
		}
	}
	return result
}

func openMeteoRequest(ctx context.Context, query string) ([]geoResult, error) {
	params := url.Values{}
	params.Set("name", query)
	params.Set("count", "8")
	params.Set("language", "pt")
	params.Set("format", "json")
	raw, status, err := geocodingGet(ctx, "https://geocoding-api.open-meteo.com/v1/search?"+params.Encode())
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("open-meteo returned HTTP %d", status)
	}
	var response openMeteoResponse
	if err = json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("decode open-meteo response: %w", err)
	}
	results := make([]geoResult, 0, len(response.Results))
	seen := map[string]bool{}
	for _, item := range response.Results {
		parts := make([]string, 0, 6)
		partsSeen := map[string]bool{}
		for _, value := range []string{item.Name, item.Admin4, item.Admin3, item.Admin2, item.Admin1, item.Country} {
			value = strings.TrimSpace(value)
			key := strings.ToLower(value)
			if value != "" && !partsSeen[key] {
				partsSeen[key] = true
				parts = append(parts, value)
			}
		}
		display := strings.Join(parts, ", ")
		lat := strconv.FormatFloat(item.Latitude, 'f', 6, 64)
		lon := strconv.FormatFloat(item.Longitude, 'f', 6, 64)
		key := strings.ToLower(display + "|" + lat + "|" + lon)
		if display == "" || seen[key] {
			continue
		}
		seen[key] = true
		results = append(results, geoResult{DisplayName: display, Lat: lat, Lon: lon, Type: openMeteoTypeLabel(item.FeatureCode), CountryCode: strings.ToUpper(item.CountryCode)})
	}
	return results, nil
}

func openMeteoTypeLabel(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	switch {
	case strings.HasPrefix(value, "PPL"):
		return "Cidade ou localidade"
	case value == "ADM1":
		return "Estado ou região"
	case strings.HasPrefix(value, "ADM"):
		return "Região ou distrito"
	case value == "ZIP":
		return "CEP"
	default:
		return "Local"
	}
}

func geocodingGet(ctx context.Context, rawURL string) ([]byte, int, error) {
	allowedHosts := map[string]bool{
		"photon.komoot.io":             true,
		"geocoding-api.open-meteo.com": true,
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || !allowedHosts[strings.ToLower(u.Hostname())] {
		return nil, 0, errors.New("geocoding host is not allowed")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 12
	transport.MaxIdleConnsPerHost = 4
	transport.IdleConnTimeout = 30 * time.Second
	transport.TLSHandshakeTimeout = 6 * time.Second
	transport.ResponseHeaderTimeout = 10 * time.Second
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 || req.URL.Scheme != "https" || !allowedHosts[strings.ToLower(req.URL.Hostname())] {
			return errors.New("geocoding redirect is not allowed")
		}
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "MapsLeads/"+version.Version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	const limit = int64(1 << 20)
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if int64(len(body)) > limit {
		return nil, resp.StatusCode, errors.New("geocoding response is too large")
	}
	return body, resp.StatusCode, nil
}
func (s *Server) testProxy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if !decodeJSON(w, r, 16<<10, &body) {
		return
	}
	u, err := url.Parse(body.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5") {
		jsonError(w, 400, "invalid_proxy", "invalid proxy URL")
		return
	}
	if err = safehttp.ValidateURL(r.Context(), &url.URL{Scheme: "https", Host: u.Host}, nil, map[string]bool{"80": true, "443": true, u.Port(): true}); err != nil {
		jsonError(w, 400, "unsafe_proxy", "proxy host is not public")
		return
	}
	allowedPorts := map[string]bool{"80": true, "443": true}
	if u.Port() != "" {
		allowedPorts[u.Port()] = true
	}
	transport := &http.Transport{Proxy: http.ProxyURL(u), DialContext: safehttp.DialContext(safehttp.Config{AllowedPorts: allowedPorts}), TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 8 * time.Second}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodHead, "https://www.google.com/generate_204", nil)
	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		jsonError(w, 502, "proxy_failed", "proxy connection failed")
		return
	}
	resp.Body.Close()
	jsonResponse(w, 200, map[string]any{"ok": resp.StatusCode >= 200 && resp.StatusCode < 400, "status": resp.StatusCode, "latency_ms": time.Since(started).Milliseconds()})
}

func (s *Server) mustJob(w http.ResponseWriter, r *http.Request) (Job, bool) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		jsonError(w, 400, "invalid_id", "invalid campaign id")
		return Job{}, false
	}
	job, err := s.svc.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			jsonError(w, 404, "not_found", "campaign not found")
			return Job{}, false
		}
		jsonError(w, 500, "read_failed", "could not read campaign")
		return Job{}, false
	}
	return job, true
}
func (s *Server) resultPath(job Job) (string, error) {
	if p, err := s.svc.ResultPath(job.ID); err == nil {
		return p, nil
	}
	if p, err := s.svc.PartialPath(job.ID); err == nil {
		return p, nil
	}
	return s.svc.RawPath(job.ID)
}
func serveDownload(w http.ResponseWriter, r *http.Request, path, name string) {
	f, err := os.Open(path)
	if err != nil {
		jsonError(w, 404, "file_not_found", "file not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		jsonError(w, 500, "file_error", "could not inspect file")
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, st.ModTime(), f)
}
func serveFriendlyDownload(w http.ResponseWriter, path, name string) {
	f, err := os.Open(path)
	if err != nil {
		jsonError(w, 404, "file_not_found", "file not found")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := streamFriendlyCSV(w, f); err != nil {
		slog.Warn("CSV download conversion failed", "error", redact.String(err.Error()))
	}
}
func parseFilter(r *http.Request) ResultFilter {
	return ResultFilter{Search: strings.TrimSpace(r.URL.Query().Get("search")), Category: strings.TrimSpace(r.URL.Query().Get("category")), MinRating: queryFloat(r, "min_rating", 0), HasPhone: queryBoolPtr(r, "has_phone"), HasWebsite: queryBoolPtr(r, "has_website"), HasInstagram: queryBoolPtr(r, "has_instagram"), HasEmail: queryBoolPtr(r, "has_email")}
}
func headerIndex(header []string) map[string]int {
	m := map[string]int{}
	for i, h := range header {
		m[strings.ToLower(strings.TrimSpace(h))] = i
	}
	return m
}
func value(row []string, idx map[string]int, names ...string) string {
	for _, name := range names {
		if i, ok := idx[name]; ok && i < len(row) {
			return strings.TrimSpace(row[i])
		}
	}
	return ""
}

func (s *Server) sameOriginGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions && !sameOrigin(r) {
			jsonError(w, 403, "invalid_origin", "a solicitação não pertence a esta instalação local")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Server) hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := strings.ToLower(r.Host)
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
		if !s.allowedHosts[host] && !s.allowedHosts[strings.ToLower(r.Host)] {
			jsonError(w, 421, "invalid_host", "host is not allowed")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip == "" {
			ip = r.RemoteAddr
		}
		s.limiterMu.Lock()
		lim := s.limiters[ip]
		if lim == nil {
			lim = rate.NewLimiter(rate.Limit(20), 40)
			s.limiters[ip] = lim
			if len(s.limiters) > 5000 {
				s.limiters = map[string]*rate.Limiter{ip: lim}
			}
		}
		allowed := lim.Allow()
		s.limiterMu.Unlock()
		if !allowed {
			jsonError(w, 429, "rate_limited", "too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(code int) { w.status = code; w.ResponseWriter.WriteHeader(code) }
func (w *statusRecorder) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (s *Server) requestMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.metrics.IncRequest()
		started := time.Now()
		rw := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)
		s.metrics.ObserveRequest(time.Since(started))
		if rw.status >= 400 {
			s.metrics.IncError()
		}
	})
}
func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				slog.Error("request panic", "request_id", r.Header.Get("X-Request-ID"))
				jsonError(w, 500, "internal_error", "internal error")
			}
		}()
		requestID := uuid.New().String()
		r.Header.Set("X-Request-ID", requestID)
		w.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(w, r)
	})
}
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		if ref := r.Header.Get("Referer"); ref != "" {
			u, err := url.Parse(ref)
			return err == nil && strings.EqualFold(u.Host, r.Host)
		}
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && strings.EqualFold(u.Host, r.Host)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		jsonError(w, 400, "invalid_json", "invalid JSON request")
		return false
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		jsonError(w, 400, "invalid_json", "request must contain one JSON object")
		return false
	}
	return true
}

type apiError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

func jsonError(w http.ResponseWriter, status int, code, message string) {
	jsonResponse(w, status, apiError{Code: code, Message: redact.String(message), RequestID: w.Header().Get("X-Request-ID")})
}
func jsonResponse(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
func queryInt(r *http.Request, key string, def, minValue, maxValue int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return def
	}
	if v < minValue {
		return minValue
	}
	if v > maxValue {
		return maxValue
	}
	return v
}
func queryFloat(r *http.Request, key string, def float64) float64 {
	v, err := strconv.ParseFloat(r.URL.Query().Get(key), 64)
	if err != nil {
		return def
	}
	return v
}
func queryBoolPtr(r *http.Request, key string) *bool {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return nil
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return nil
	}
	return &v
}
func fileSHA(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", h.Sum(nil)), nil
}

var _ = csv.ErrFieldCount
var _ = fileSHA
