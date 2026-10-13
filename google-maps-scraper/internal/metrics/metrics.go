package metrics

import (
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type Registry struct {
	requests      atomic.Uint64
	errors        atomic.Uint64
	exports       atomic.Uint64
	results       atomic.Uint64
	durationNanos atomic.Uint64
	mu            sync.RWMutex
	jobStatus     map[string]int
	started       time.Time
}

func New() *Registry                    { return &Registry{jobStatus: map[string]int{}, started: time.Now().UTC()} }
func (r *Registry) IncRequest()         { r.requests.Add(1) }
func (r *Registry) IncError()           { r.errors.Add(1) }
func (r *Registry) IncExport()          { r.exports.Add(1) }
func (r *Registry) AddResults(n uint64) { r.results.Add(n) }
func (r *Registry) ObserveRequest(d time.Duration) {
	if d > 0 {
		r.durationNanos.Add(uint64(d))
	}
}
func (r *Registry) SetJobStatus(status string, n int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.jobStatus[status] = n
}
func (r *Registry) Snapshot() map[string]any {
	r.mu.RLock()
	defer r.mu.RUnlock()
	statuses := map[string]int{}
	for k, v := range r.jobStatus {
		statuses[k] = v
	}
	requests := r.requests.Load()
	avgMS := float64(0)
	if requests > 0 {
		avgMS = float64(r.durationNanos.Load()) / float64(requests) / float64(time.Millisecond)
	}
	return map[string]any{"started_at": r.started, "uptime_seconds": int64(time.Since(r.started).Seconds()), "http_requests_total": requests, "http_errors_total": r.errors.Load(), "http_request_duration_avg_ms": avgMS, "exports_total": r.exports.Load(), "results_total": r.results.Load(), "jobs": statuses}
}
func (r *Registry) Handler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(r.Snapshot())
}
