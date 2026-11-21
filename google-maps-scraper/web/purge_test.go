package web_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coelhobugado/google-maps-scraper/web"
	websqlite "github.com/coelhobugado/google-maps-scraper/web/sqlite"
)

// A worker that crashed leaves <id>.raw.tmp and <id>.tmp.csv; purging its job must remove them too,
// or every crashed campaign keeps its scratch files on the server forever.
func TestPurgeRemovesEveryFileOfTheJob(t *testing.T) {
	dir := t.TempDir()
	repo, err := websqlite.New(filepath.Join(dir, "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	svc := web.NewService(repo, dir)
	defer svc.Close()
	old := time.Now().UTC().Add(-40 * 24 * time.Hour)
	job := &web.Job{ID: "job1", Status: web.StatusWorkerLost, Date: old, UpdatedAt: old, Data: web.JobData{Keywords: []string{"cafe"}, MaxTime: time.Minute}}
	if err := repo.Create(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	files := []string{"results/job1.csv", "results/job1.partial.csv", "results/job1.tmp.csv", "results/job1.raw.tmp", "exports/job1/a.csv"}
	for _, f := range files {
		p := filepath.Join(dir, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	keep := filepath.Join(dir, "results", "job2.csv")
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	n, err := svc.Purge(context.Background(), time.Now().UTC().Add(-30*24*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("purge: n=%d err=%v", n, err)
	}
	for _, f := range files {
		if _, err := os.Stat(filepath.Join(dir, f)); !os.IsNotExist(err) {
			t.Errorf("%s still on disk", f)
		}
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("another job's results were removed: %v", err)
	}
}
