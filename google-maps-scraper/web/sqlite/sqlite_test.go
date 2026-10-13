package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/coelhobugado/google-maps-scraper/web"
)

func TestMigrateLegacyAndLifecycle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,claimed_at INTEGER,lease_expires_at INTEGER,heartbeat_at INTEGER,progress_current INTEGER NOT NULL DEFAULT 0,progress_total INTEGER NOT NULL DEFAULT 0,results_count INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '',error_message TEXT NOT NULL DEFAULT '',partial_results INTEGER NOT NULL DEFAULT 0,worker_id TEXT NOT NULL DEFAULT '',cancel_requested_at INTEGER)`)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(web.JobData{Keywords: []string{"cafe"}, Lang: "pt-BR", Depth: 10, Zoom: 15, Radius: 10000, MaxTime: time.Minute})
	_, err = db.Exec(`INSERT INTO jobs(id,name,status,data,created_at,updated_at) VALUES(?,?,?,?,?,?)`, "legacy", "Legacy", "pending", string(raw), time.Now().Unix(), time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	r, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	ctx := context.Background()
	j, err := r.Get(ctx, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if j.Status != web.StatusQueued || len(j.Data.Keywords) != 1 {
		t.Fatalf("migrated job=%+v", j)
	}
	if err := r.Create(ctx, &web.Job{ID: "duplicate", Name: "One", Status: web.StatusQueued, Date: time.Now().UTC(), UpdatedAt: time.Now().UTC(), IdempotencyKey: "same", Data: web.JobData{Keywords: []string{"one"}}}); err != nil {
		t.Fatal(err)
	}
	if err := r.Create(ctx, &web.Job{ID: "duplicate2", Name: "Two", Status: web.StatusQueued, Date: time.Now().UTC(), UpdatedAt: time.Now().UTC(), IdempotencyKey: "same", Data: web.JobData{Keywords: []string{"two"}}}); !errors.Is(err, web.ErrAlreadyExists) {
		t.Fatalf("duplicate idempotency=%v", err)
	}
	claimed, err := r.ClaimQueued(ctx, "worker", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != web.StatusRunning {
		t.Fatalf("status=%s", claimed.Status)
	}
	if err := r.UpdateProgress(ctx, claimed.ID, "worker", 1, 2); err != nil {
		t.Fatal(err)
	}
	if err := r.Heartbeat(ctx, claimed.ID, "worker", time.Second); err != nil {
		t.Fatal(err)
	}
	if err := r.Finish(ctx, claimed.ID, web.StatusSucceeded, "", "", 2, false); err != nil {
		t.Fatal(err)
	}
	finished, err := r.Get(ctx, claimed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != web.StatusSucceeded || finished.ResultsCount != 2 || finished.ProgressCurrent != finished.ProgressTotal {
		t.Fatalf("finished=%+v", finished)
	}
}
