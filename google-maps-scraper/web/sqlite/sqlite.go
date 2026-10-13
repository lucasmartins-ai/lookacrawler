package sqlite

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/coelhobugado/google-maps-scraper/internal/securefile"
	"github.com/coelhobugado/google-maps-scraper/web"
)

const jobColumns = `id,name,status,data,created_at,updated_at,idempotency_key,attempt,max_attempts,claimed_at,lease_expires_at,heartbeat_at,progress_current,progress_total,results_count,error_code,error_message,partial_results,worker_id,cancel_requested_at`

type repo struct {
	db   *sql.DB
	aead cipher.AEAD
}

func New(path string) (web.JobRepository, error) {
	if err := securefile.EnsureDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(30 * time.Minute)
	for _, q := range []string{"PRAGMA busy_timeout=5000", "PRAGMA journal_mode=WAL", "PRAGMA synchronous=NORMAL", "PRAGMA foreign_keys=ON", "PRAGMA temp_store=MEMORY"} {
		if _, err = db.Exec(q); err != nil {
			db.Close()
			return nil, err
		}
	}
	if err = db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	if err = migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	aead, err := loadAEAD(filepath.Join(filepath.Dir(path), "encryption.key"))
	if err != nil {
		db.Close()
		return nil, err
	}
	return &repo{db: db, aead: aead}, nil
}
func (r *repo) Close() error { return r.db.Close() }

func migrate(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,idempotency_key TEXT NOT NULL DEFAULT '',attempt INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,claimed_at INTEGER,lease_expires_at INTEGER,heartbeat_at INTEGER,progress_current INTEGER NOT NULL DEFAULT 0,progress_total INTEGER NOT NULL DEFAULT 0,results_count INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '',error_message TEXT NOT NULL DEFAULT '',partial_results INTEGER NOT NULL DEFAULT 0,worker_id TEXT NOT NULL DEFAULT '',cancel_requested_at INTEGER)`); err != nil {
		return err
	}
	columns := map[string]string{"updated_at": "INTEGER NOT NULL DEFAULT 0", "idempotency_key": "TEXT NOT NULL DEFAULT ''", "attempt": "INTEGER NOT NULL DEFAULT 0", "max_attempts": "INTEGER NOT NULL DEFAULT 3", "claimed_at": "INTEGER", "lease_expires_at": "INTEGER", "heartbeat_at": "INTEGER", "progress_current": "INTEGER NOT NULL DEFAULT 0", "progress_total": "INTEGER NOT NULL DEFAULT 0", "results_count": "INTEGER NOT NULL DEFAULT 0", "error_code": "TEXT NOT NULL DEFAULT ''", "error_message": "TEXT NOT NULL DEFAULT ''", "partial_results": "INTEGER NOT NULL DEFAULT 0", "worker_id": "TEXT NOT NULL DEFAULT ''", "cancel_requested_at": "INTEGER"}
	existing := map[string]bool{}
	rows, err := tx.Query(`PRAGMA table_info(jobs)`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt any
		if err = rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			rows.Close()
			return err
		}
		existing[name] = true
	}
	rows.Close()
	for name, def := range columns {
		if !existing[name] {
			if _, err = tx.Exec(`ALTER TABLE jobs ADD COLUMN ` + name + ` ` + def); err != nil {
				return fmt.Errorf("add jobs.%s: %w", name, err)
			}
		}
	}
	for _, q := range []string{
		`UPDATE jobs SET status='queued' WHERE status='pending'`,
		`UPDATE jobs SET status='running' WHERE status='working'`,
		`UPDATE jobs SET status='succeeded' WHERE status='ok'`,
		`UPDATE jobs SET updated_at=created_at WHERE updated_at=0`,
		`CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status,created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(status,lease_expires_at)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key) WHERE idempotency_key<>''`,
		`CREATE TABLE IF NOT EXISTS job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id,id)`,
		`CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,format TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,row_count INTEGER NOT NULL,filter TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
		`PRAGMA user_version=3`,
	} {
		if _, err = tx.Exec(q); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func loadAEAD(path string) (cipher.AEAD, error) {
	data, err := securefile.Read(path, 128)
	if errors.Is(err, os.ErrNotExist) {
		data = make([]byte, 32)
		if _, err = io.ReadFull(rand.Reader, data); err != nil {
			return nil, err
		}
		if err = securefile.Write(path, data); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if len(data) != 32 {
		return nil, errors.New("invalid encryption key length")
	}
	block, err := aes.NewCipher(data)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (r *repo) encrypt(data []byte) (string, error) {
	nonce := make([]byte, r.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := r.aead.Seal(nonce, nonce, data, nil)
	return "enc:v1:" + base64.RawStdEncoding.EncodeToString(sealed), nil
}
func (r *repo) decrypt(value string) ([]byte, error) {
	if !strings.HasPrefix(value, "enc:v1:") {
		return []byte(value), nil
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(value, "enc:v1:"))
	if err != nil {
		return nil, err
	}
	if len(raw) < r.aead.NonceSize() {
		return nil, errors.New("encrypted payload too short")
	}
	return r.aead.Open(nil, raw[:r.aead.NonceSize()], raw[r.aead.NonceSize():], nil)
}

func (r *repo) Get(ctx context.Context, id string) (web.Job, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM jobs WHERE id=?`, id)
	return r.scanJob(row)
}
func (r *repo) Create(ctx context.Context, j *web.Job) error {
	if err := j.Validate(); err != nil {
		return err
	}
	payload, err := json.Marshal(j.Data)
	if err != nil {
		return err
	}
	enc, err := r.encrypt(payload)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO jobs(`+jobColumns+`) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, j.ID, j.Name, j.Status, enc, j.Date.Unix(), j.UpdatedAt.Unix(), j.IdempotencyKey, j.Attempt, j.MaxAttempts, timePtr(j.ClaimedAt), timePtr(j.LeaseExpiresAt), timePtr(j.HeartbeatAt), j.ProgressCurrent, j.ProgressTotal, j.ResultsCount, j.ErrorCode, j.ErrorMessage, j.PartialResults, j.WorkerID, timePtr(j.CancelRequestedAt))
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unique") {
		return web.ErrAlreadyExists
	}
	if err == nil {
		_ = r.AppendEvent(ctx, web.Event{JobID: j.ID, Type: "created", Message: "campaign queued", CreatedAt: j.Date})
	}
	return err
}
func (r *repo) Delete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM jobs WHERE id=?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return web.ErrNotFound
	}
	return nil
}
func (r *repo) Select(ctx context.Context, p web.SelectParams) ([]web.Job, error) {
	q := `SELECT ` + jobColumns + ` FROM jobs`
	args := []any{}
	if p.Status != "" {
		q += ` WHERE status=?`
		args = append(args, p.Status)
	}
	q += ` ORDER BY created_at DESC`
	if p.Limit <= 0 || p.Limit > 200 {
		p.Limit = 50
	}
	q += ` LIMIT ? OFFSET ?`
	args = append(args, p.Limit, max(0, p.Offset))
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []web.Job{}
	for rows.Next() {
		j, err := r.scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}
func (r *repo) Count(ctx context.Context, status string) (int, error) {
	q := `SELECT COUNT(*) FROM jobs`
	args := []any{}
	if status != "" {
		q += ` WHERE status=?`
		args = append(args, status)
	}
	var n int
	err := r.db.QueryRowContext(ctx, q, args...).Scan(&n)
	return n, err
}

func (r *repo) ClaimQueued(ctx context.Context, worker string, lease time.Duration) (web.Job, error) {
	now := time.Now().UTC()
	if lease <= 0 {
		lease = 45 * time.Second
	}
	row := r.db.QueryRowContext(ctx, `UPDATE jobs SET status=?,worker_id=?,attempt=attempt+1,claimed_at=?,heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=(SELECT id FROM jobs WHERE status=? AND cancel_requested_at IS NULL AND attempt<max_attempts ORDER BY created_at LIMIT 1) RETURNING `+jobColumns, web.StatusRunning, worker, now.Unix(), now.Unix(), now.Add(lease).Unix(), now.Unix(), web.StatusQueued)
	j, err := r.scanJob(row)
	if err == nil {
		_ = r.AppendEvent(ctx, web.Event{JobID: j.ID, Type: "claimed", Message: "worker claimed campaign", CreatedAt: now})
	}
	return j, err
}
func (r *repo) Heartbeat(ctx context.Context, id, worker string, lease time.Duration) error {
	now := time.Now().UTC()
	if lease <= 0 {
		lease = 45 * time.Second
	}
	res, err := r.db.ExecContext(ctx, `UPDATE jobs SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND worker_id=? AND status=?`, now.Unix(), now.Add(lease).Unix(), now.Unix(), id, worker, web.StatusRunning)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return web.ErrNotFound
	}
	return nil
}
func (r *repo) UpdateProgress(ctx context.Context, id, worker string, current, total int) error {
	if current < 0 || total < 0 || current > total && total > 0 {
		return errors.New("invalid progress")
	}
	res, err := r.db.ExecContext(ctx, `UPDATE jobs SET progress_current=?,progress_total=?,updated_at=? WHERE id=? AND worker_id=? AND status=?`, current, total, time.Now().UTC().Unix(), id, worker, web.StatusRunning)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return web.ErrNotFound
	}
	return nil
}
func (r *repo) Finish(ctx context.Context, id, status, code, message string, count int, partial bool) error {
	if !web.IsTerminal(status) {
		return errors.New("finish requires a terminal status")
	}
	now := time.Now().UTC()
	res, err := r.db.ExecContext(ctx, `UPDATE jobs SET status=?,error_code=?,error_message=?,results_count=?,partial_results=?,progress_current=CASE WHEN progress_total>0 AND ?=? THEN progress_total ELSE progress_current END,worker_id='',lease_expires_at=NULL,heartbeat_at=NULL,updated_at=? WHERE id=? AND status=?`, status, code, truncate(message, 1000), max(0, count), partial, status, web.StatusSucceeded, now.Unix(), id, web.StatusRunning)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("job is not running")
	}
	return r.AppendEvent(ctx, web.Event{JobID: id, Type: "finished", Message: status, CreatedAt: now})
}
func (r *repo) RequestCancel(ctx context.Context, id string) error {
	now := time.Now().UTC()
	res, err := r.db.ExecContext(ctx, `UPDATE jobs SET status=CASE WHEN status=? THEN ? ELSE status END,cancel_requested_at=?,updated_at=? WHERE id=? AND status IN (?,?)`, web.StatusQueued, web.StatusCanceled, now.Unix(), now.Unix(), id, web.StatusQueued, web.StatusRunning)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("job cannot be canceled")
	}
	return r.AppendEvent(ctx, web.Event{JobID: id, Type: "cancel_requested", Message: "cancel requested", CreatedAt: now})
}
func (r *repo) CancelRequested(ctx context.Context, id string) (bool, error) {
	var value sql.NullInt64
	var status string
	err := r.db.QueryRowContext(ctx, `SELECT cancel_requested_at,status FROM jobs WHERE id=?`, id).Scan(&value, &status)
	return value.Valid || status == web.StatusCanceled, err
}
func (r *repo) RecoverExpired(ctx context.Context, before time.Time) (int, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,attempt,max_attempts FROM jobs WHERE status=? AND lease_expires_at IS NOT NULL AND lease_expires_at<?`, web.StatusRunning, before.Unix())
	if err != nil {
		return 0, err
	}
	type item struct {
		id           string
		attempt, max int
	}
	var items []item
	for rows.Next() {
		var x item
		if err = rows.Scan(&x.id, &x.attempt, &x.max); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, x)
	}
	rows.Close()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	for _, x := range items {
		status := web.StatusQueued
		code := ""
		msg := ""
		if x.attempt >= x.max {
			status = web.StatusWorkerLost
			code = "worker_lost"
			msg = "worker lease expired after maximum attempts"
		}
		if _, err = tx.ExecContext(ctx, `UPDATE jobs SET status=?,worker_id='',lease_expires_at=NULL,heartbeat_at=NULL,error_code=?,error_message=?,updated_at=? WHERE id=? AND status=?`, status, code, msg, time.Now().UTC().Unix(), x.id, web.StatusRunning); err != nil {
			return 0, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO job_events(job_id,type,message,created_at) VALUES(?,?,?,?)`, x.id, "recovered", status, time.Now().UTC().Unix()); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return len(items), nil
}
func (r *repo) Retry(ctx context.Context, id string) error {
	now := time.Now().UTC()
	res, err := r.db.ExecContext(ctx, `UPDATE jobs SET status=?,attempt=0,claimed_at=NULL,lease_expires_at=NULL,heartbeat_at=NULL,progress_current=0,progress_total=0,error_code='',error_message='',partial_results=0,worker_id='',cancel_requested_at=NULL,updated_at=? WHERE id=? AND status IN (?,?,?,?,?,?)`, web.StatusQueued, now.Unix(), id, web.StatusFailed, web.StatusTimedOut, web.StatusCanceled, web.StatusInterrupted, web.StatusWorkerLost, web.StatusSucceeded)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("job cannot be retried")
	}
	return r.AppendEvent(ctx, web.Event{JobID: id, Type: "retry", Message: "campaign requeued", CreatedAt: now})
}

func (r *repo) AppendEvent(ctx context.Context, e web.Event) error {
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now().UTC()
	}
	_, err := r.db.ExecContext(ctx, `INSERT INTO job_events(job_id,type,message,created_at) VALUES(?,?,?,?)`, e.JobID, e.Type, truncate(e.Message, 1000), e.CreatedAt.Unix())
	return err
}
func (r *repo) Events(ctx context.Context, id string, limit int) ([]web.Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := r.db.QueryContext(ctx, `SELECT id,job_id,type,message,created_at FROM job_events WHERE job_id=? ORDER BY id DESC LIMIT ?`, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []web.Event{}
	for rows.Next() {
		var e web.Event
		var ts int64
		if err = rows.Scan(&e.ID, &e.JobID, &e.Type, &e.Message, &ts); err != nil {
			return nil, err
		}
		e.CreatedAt = time.Unix(ts, 0).UTC()
		out = append(out, e)
	}
	return out, rows.Err()
}
func (r *repo) CreateExport(ctx context.Context, e web.Export) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO exports(id,job_id,format,path,sha256,row_count,filter,created_at) VALUES(?,?,?,?,?,?,?,?)`, e.ID, e.JobID, e.Format, e.Path, e.SHA256, e.RowCount, e.Filter, e.CreatedAt.Unix())
	return err
}
func (r *repo) Exports(ctx context.Context, id string) ([]web.Export, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,job_id,format,path,sha256,row_count,filter,created_at FROM exports WHERE job_id=? ORDER BY created_at DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []web.Export{}
	for rows.Next() {
		var e web.Export
		var ts int64
		if err = rows.Scan(&e.ID, &e.JobID, &e.Format, &e.Path, &e.SHA256, &e.RowCount, &e.Filter, &ts); err != nil {
			return nil, err
		}
		e.CreatedAt = time.Unix(ts, 0).UTC()
		out = append(out, e)
	}
	return out, rows.Err()
}
func (r *repo) SaveTemplate(ctx context.Context, t web.Template) error {
	if t.ID == "" || strings.TrimSpace(t.Name) == "" {
		return errors.New("template id and name are required")
	}
	if err := t.Data.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(t.Data)
	if err != nil {
		return err
	}
	enc, err := r.encrypt(raw)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if t.CreatedAt.IsZero() {
		t.CreatedAt = now
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO templates(id,name,data,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=excluded.updated_at`, t.ID, t.Name, enc, t.CreatedAt.Unix(), now.Unix())
	return err
}
func (r *repo) Templates(ctx context.Context) ([]web.Template, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,name,data,created_at,updated_at FROM templates ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []web.Template{}
	for rows.Next() {
		var t web.Template
		var data string
		var c, u int64
		if err = rows.Scan(&t.ID, &t.Name, &data, &c, &u); err != nil {
			return nil, err
		}
		raw, err := r.decrypt(data)
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &t.Data); err != nil {
			return nil, err
		}
		t.CreatedAt = time.Unix(c, 0).UTC()
		t.UpdatedAt = time.Unix(u, 0).UTC()
		out = append(out, t)
	}
	return out, rows.Err()
}
func (r *repo) DeleteTemplate(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM templates WHERE id=?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return web.ErrNotFound
	}
	return nil
}
func (r *repo) PurgeBefore(ctx context.Context, before time.Time) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id FROM jobs WHERE updated_at<? AND status IN (?,?,?,?,?,?)`, before.Unix(), web.StatusSucceeded, web.StatusFailed, web.StatusTimedOut, web.StatusCanceled, web.StatusInterrupted, web.StatusWorkerLost)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, id := range ids {
		if _, err = tx.ExecContext(ctx, `DELETE FROM jobs WHERE id=?`, id); err != nil {
			return nil, err
		}
	}
	return ids, tx.Commit()
}

type scanner interface{ Scan(...any) error }

func (r *repo) scanJob(s scanner) (web.Job, error) {
	var j web.Job
	var data string
	var created, updated int64
	var claimed, lease, hb, cancel sql.NullInt64
	err := s.Scan(&j.ID, &j.Name, &j.Status, &data, &created, &updated, &j.IdempotencyKey, &j.Attempt, &j.MaxAttempts, &claimed, &lease, &hb, &j.ProgressCurrent, &j.ProgressTotal, &j.ResultsCount, &j.ErrorCode, &j.ErrorMessage, &j.PartialResults, &j.WorkerID, &cancel)
	if errors.Is(err, sql.ErrNoRows) {
		return j, web.ErrNotFound
	}
	if err != nil {
		return j, err
	}
	raw, err := r.decrypt(data)
	if err != nil {
		return j, err
	}
	if err = json.Unmarshal(raw, &j.Data); err != nil {
		return j, err
	}
	j.Date = time.Unix(created, 0).UTC()
	j.UpdatedAt = time.Unix(updated, 0).UTC()
	j.ClaimedAt = fromNull(claimed)
	j.LeaseExpiresAt = fromNull(lease)
	j.HeartbeatAt = fromNull(hb)
	j.CancelRequestedAt = fromNull(cancel)
	return j, nil
}
func timePtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Unix()
}
func fromNull(n sql.NullInt64) *time.Time {
	if !n.Valid {
		return nil
	}
	t := time.Unix(n.Int64, 0).UTC()
	return &t
}
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
