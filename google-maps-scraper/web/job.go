package web

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	StatusQueued      = "queued"
	StatusRunning     = "running"
	StatusSucceeded   = "succeeded"
	StatusFailed      = "failed"
	StatusTimedOut    = "timed_out"
	StatusCanceled    = "canceled"
	StatusInterrupted = "interrupted"
	StatusWorkerLost  = "worker_lost"
)

var terminalStatuses = map[string]bool{StatusSucceeded: true, StatusFailed: true, StatusTimedOut: true, StatusCanceled: true, StatusInterrupted: true, StatusWorkerLost: true}

func IsTerminal(status string) bool { return terminalStatuses[status] }
func ValidStatus(status string) bool {
	return status == StatusQueued || status == StatusRunning || IsTerminal(status)
}

type SelectParams struct {
	Status string
	Limit  int
	Offset int
}

type JobRepository interface {
	Close() error
	Get(context.Context, string) (Job, error)
	Create(context.Context, *Job) error
	Delete(context.Context, string) error
	Select(context.Context, SelectParams) ([]Job, error)
	Count(context.Context, string) (int, error)
	ClaimQueued(context.Context, string, time.Duration) (Job, error)
	Heartbeat(context.Context, string, string, time.Duration) error
	UpdateProgress(context.Context, string, string, int, int) error
	Finish(context.Context, string, string, string, string, int, bool) error
	RequestCancel(context.Context, string) error
	CancelRequested(context.Context, string) (bool, error)
	RecoverExpired(context.Context, time.Time) (int, error)
	Retry(context.Context, string) error
	AppendEvent(context.Context, Event) error
	Events(context.Context, string, int) ([]Event, error)
	CreateExport(context.Context, Export) error
	Exports(context.Context, string) ([]Export, error)
	SaveTemplate(context.Context, Template) error
	Templates(context.Context) ([]Template, error)
	DeleteTemplate(context.Context, string) error
	PurgeBefore(context.Context, time.Time) ([]string, error)
}

type Job struct {
	ID                string     `json:"id"`
	Name              string     `json:"name"`
	Date              time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	Status            string     `json:"status"`
	Data              JobData    `json:"data"`
	IdempotencyKey    string     `json:"-"`
	Attempt           int        `json:"attempt"`
	MaxAttempts       int        `json:"max_attempts"`
	ClaimedAt         *time.Time `json:"claimed_at,omitempty"`
	LeaseExpiresAt    *time.Time `json:"lease_expires_at,omitempty"`
	HeartbeatAt       *time.Time `json:"heartbeat_at,omitempty"`
	ProgressCurrent   int        `json:"progress_current"`
	ProgressTotal     int        `json:"progress_total"`
	ResultsCount      int        `json:"results_count"`
	ErrorCode         string     `json:"error_code,omitempty"`
	ErrorMessage      string     `json:"error_message,omitempty"`
	PartialResults    bool       `json:"partial_results"`
	WorkerID          string     `json:"-"`
	CancelRequestedAt *time.Time `json:"cancel_requested_at,omitempty"`
}

func (j *Job) Validate() error {
	if strings.TrimSpace(j.ID) == "" {
		return errors.New("missing id")
	}
	if j.Date.IsZero() {
		j.Date = time.Now().UTC()
	}
	if j.UpdatedAt.IsZero() {
		j.UpdatedAt = j.Date
	}
	if strings.TrimSpace(j.Name) == "" {
		j.Name = "Campaign - " + j.Date.Format("2006-01-02 15:04")
	}
	if j.Status == "" {
		j.Status = StatusQueued
	}
	if !ValidStatus(j.Status) {
		return fmt.Errorf("invalid status %q", j.Status)
	}
	if j.MaxAttempts <= 0 {
		j.MaxAttempts = 3
	}
	if j.MaxAttempts > 10 {
		return errors.New("max_attempts cannot exceed 10")
	}
	return j.Data.Validate()
}

type JobData struct {
	Keywords     []string      `json:"keywords"`
	Location     string        `json:"location,omitempty"`
	Lang         string        `json:"lang"`
	Zoom         int           `json:"zoom"`
	Lat          string        `json:"lat,omitempty"`
	Lon          string        `json:"lon,omitempty"`
	FastMode     bool          `json:"fast_mode"`
	Radius       int           `json:"radius"`
	Depth        int           `json:"depth"`
	Email        bool          `json:"email"`
	ExtraReviews bool          `json:"extra_reviews"`
	MaxTime      time.Duration `json:"max_time"`
	Proxies      []string      `json:"proxies,omitempty"`
}

func (d *JobData) Validate() error {
	clean := make([]string, 0, len(d.Keywords))
	seen := map[string]struct{}{}
	for _, k := range d.Keywords {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		if len([]rune(k)) > 300 {
			return errors.New("keyword exceeds 300 characters")
		}
		lk := strings.ToLower(k)
		if _, ok := seen[lk]; ok {
			continue
		}
		seen[lk] = struct{}{}
		clean = append(clean, k)
	}
	d.Keywords = clean
	if len(d.Keywords) == 0 {
		return errors.New("missing keywords")
	}
	if len(d.Keywords) > 100 {
		return errors.New("too many keywords; maximum is 100")
	}
	d.Location = strings.TrimSpace(d.Location)
	if len([]rune(d.Location)) > 240 {
		return errors.New("location exceeds 240 characters")
	}
	if d.Lang == "" {
		d.Lang = "en"
	}
	if len(d.Lang) < 2 || len(d.Lang) > 12 {
		return errors.New("invalid language code")
	}
	if d.Depth == 0 {
		d.Depth = 10
	}
	if d.Depth < 1 || d.Depth > 100 {
		return errors.New("depth must be between 1 and 100")
	}
	if d.Zoom == 0 {
		d.Zoom = 15
	}
	if d.Zoom < 1 || d.Zoom > 21 {
		return errors.New("zoom must be between 1 and 21")
	}
	if d.Radius == 0 {
		d.Radius = 10000
	}
	if d.Radius < 0 || d.Radius > 500000 {
		return errors.New("radius must be between 0 and 500000")
	}
	if d.MaxTime == 0 {
		d.MaxTime = 30 * time.Minute
	}
	if d.MaxTime < time.Minute || d.MaxTime > 24*time.Hour {
		return errors.New("max_time must be between 1 minute and 24 hours")
	}
	if d.FastMode && (strings.TrimSpace(d.Lat) == "" || strings.TrimSpace(d.Lon) == "") {
		return errors.New("latitude and longitude are required in fast mode")
	}
	if len(d.Proxies) > 100 {
		return errors.New("too many proxies; maximum is 100")
	}
	for _, p := range d.Proxies {
		u, err := url.Parse(p)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5") {
			return errors.New("invalid proxy URL")
		}
	}
	return nil
}

type Event struct {
	ID        int64     `json:"id"`
	JobID     string    `json:"job_id"`
	Type      string    `json:"type"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"created_at"`
}
type Export struct {
	ID        string    `json:"id"`
	JobID     string    `json:"job_id"`
	Format    string    `json:"format"`
	Path      string    `json:"-"`
	SHA256    string    `json:"sha256"`
	RowCount  int       `json:"row_count"`
	Filter    string    `json:"filter,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}
type Template struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Data      JobData   `json:"data"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
