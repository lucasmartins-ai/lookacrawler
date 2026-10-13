package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/gosom/scrapemate"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/coelhobugado/google-maps-scraper/gmaps"
)

const (
	statusQueued    = "queued"
	statusRunning   = "running"
	statusSucceeded = "succeeded"
	statusFailed    = "failed"
	defaultBatch    = 10
)

type LifecycleProvider interface {
	scrapemate.JobProvider
	Acknowledge(context.Context, string) error
	Fail(context.Context, string, string) error
	Heartbeat(context.Context, string) error
}

type provider struct {
	db        *sql.DB
	mu        sync.Mutex
	jobc      chan scrapemate.IJob
	errc      chan error
	started   bool
	batchSize int
	workerID  string
	lease     time.Duration
	claimed   sync.Map
}

var _ LifecycleProvider = (*provider)(nil)

type ProviderOption func(*provider)

func WithBatchSize(size int) ProviderOption {
	return func(p *provider) {
		if size > 0 {
			p.batchSize = size
		}
	}
}
func WithLease(d time.Duration) ProviderOption {
	return func(p *provider) {
		if d >= 15*time.Second {
			p.lease = d
		}
	}
}

func NewProvider(db *sql.DB, opts ...ProviderOption) LifecycleProvider {
	host, _ := os.Hostname()
	p := &provider{db: db, batchSize: defaultBatch, workerID: fmt.Sprintf("%s-%d", host, time.Now().UnixNano()), lease: 2 * time.Minute, errc: make(chan error, 1)}
	for _, opt := range opts {
		opt(p)
	}
	p.jobc = make(chan scrapemate.IJob, 2*p.batchSize)
	return p
}

func (p *provider) Jobs(ctx context.Context) (<-chan scrapemate.IJob, <-chan error) {
	out := make(chan scrapemate.IJob)
	errs := make(chan error, 1)
	p.mu.Lock()
	if !p.started {
		p.started = true
		go p.fetchJobs(ctx)
		go p.heartbeatLoop(ctx)
	}
	p.mu.Unlock()
	go func() {
		defer close(out)
		defer close(errs)
		for {
			select {
			case <-ctx.Done():
				return
			case err, ok := <-p.errc:
				if ok && err != nil {
					errs <- err
				}
				return
			case j, ok := <-p.jobc:
				if !ok {
					return
				}
				if j == nil || j.GetID() == "" {
					continue
				}
				select {
				case out <- j:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, errs
}

type payloadEnvelope struct {
	Version  int    `json:"version"`
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	SHA256   string `json:"sha256"`
	Data     []byte `json:"data"`
}

func encodeJob(job scrapemate.IJob) (string, []byte, error) {
	var typ string
	switch job.(type) {
	case *gmaps.GmapJob:
		typ = "search"
	case *gmaps.PlaceJob:
		typ = "place"
	case *gmaps.EmailExtractJob:
		typ = "email"
	case *gmaps.SearchJob:
		typ = "fast_search"
	default:
		return "", nil, fmt.Errorf("invalid job type %T", job)
	}
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(job); err != nil {
		return "", nil, fmt.Errorf("encode %s job: %w", typ, err)
	}
	sum := sha256.Sum256(buf.Bytes())
	payload, err := json.Marshal(payloadEnvelope{Version: 1, Type: typ, Encoding: "gob", SHA256: hex.EncodeToString(sum[:]), Data: buf.Bytes()})
	if err != nil {
		return "", nil, err
	}
	return typ, payload, nil
}

func (p *provider) Push(ctx context.Context, job scrapemate.IJob) error {
	typ, payload, err := encodeJob(job)
	if err != nil {
		return err
	}
	_, err = p.db.ExecContext(ctx, `INSERT INTO gmaps_jobs(id,priority,payload_type,payload,created_at,updated_at,status,attempts,max_attempts) VALUES($1,$2,$3,$4,NOW(),NOW(),$5,0,$6) ON CONFLICT(id) DO NOTHING`, job.GetID(), job.GetPriority(), typ, payload, statusQueued, 3)
	if err == nil {
		_, _ = p.db.ExecContext(ctx, `SELECT pg_notify('gmaps_jobs_new','')`)
	}
	return err
}

func (p *provider) fetchJobs(ctx context.Context) {
	defer close(p.jobc)
	defer close(p.errc)
	notify := make(chan struct{}, 1)
	go p.listen(ctx, notify)
	backoff := 100 * time.Millisecond
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		jobs, err := p.claimBatch(ctx)
		if err != nil {
			select {
			case p.errc <- err:
			default:
			}
			return
		}
		if len(jobs) > 0 {
			backoff = 100 * time.Millisecond
			for _, j := range jobs {
				p.claimed.Store(j.GetID(), struct{}{})
				select {
				case p.jobc <- j:
				case <-ctx.Done():
					return
				}
			}
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-notify:
			backoff = 100 * time.Millisecond
		case <-time.After(backoff):
			if backoff < 3*time.Second {
				backoff *= 2
			}
		}
	}
}

func (p *provider) claimBatch(ctx context.Context) ([]scrapemate.IJob, error) {
	q := `WITH dead AS (
		UPDATE gmaps_jobs SET status=$1,updated_at=NOW(),worker_id='',lease_expires_at=NULL
		WHERE status=$2 AND lease_expires_at<NOW() AND attempts>=max_attempts
	), picked AS (
		SELECT id FROM gmaps_jobs WHERE status=$3 OR (status=$2 AND lease_expires_at<NOW() AND attempts<max_attempts)
		ORDER BY priority ASC,created_at ASC FOR UPDATE SKIP LOCKED LIMIT $4
	), claimed AS (
		UPDATE gmaps_jobs j SET status=$2,updated_at=NOW(),worker_id=$5,attempts=attempts+1,heartbeat_at=NOW(),lease_expires_at=NOW()+($6 * INTERVAL '1 second')
		FROM picked WHERE j.id=picked.id RETURNING j.payload_type,j.payload
	) SELECT payload_type,payload FROM claimed`
	rows, err := p.db.QueryContext(ctx, q, statusFailed, statusRunning, statusQueued, p.batchSize, p.workerID, int(p.lease.Seconds()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]scrapemate.IJob, 0, p.batchSize)
	for rows.Next() {
		var typ string
		var payload []byte
		if err := rows.Scan(&typ, &payload); err != nil {
			return nil, err
		}
		j, err := decodeJob(typ, payload)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func (p *provider) listen(ctx context.Context, notify chan<- struct{}) {
	delay := time.Second
	for ctx.Err() == nil {
		conn, err := p.db.Conn(ctx)
		if err != nil {
			if !sleepContext(ctx, delay) {
				return
			}
			continue
		}
		err = conn.Raw(func(raw any) error {
			std, ok := raw.(*stdlib.Conn)
			if !ok {
				return errors.New("pgx stdlib connection required for LISTEN")
			}
			pg := std.Conn()
			if _, err := pg.Exec(ctx, "LISTEN gmaps_jobs_new"); err != nil {
				return err
			}
			for ctx.Err() == nil {
				if _, err := pg.WaitForNotification(ctx); err != nil {
					return err
				}
				select {
				case notify <- struct{}{}:
				default:
				}
			}
			return ctx.Err()
		})
		_ = conn.Close()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			if !sleepContext(ctx, delay) {
				return
			}
			if delay < 30*time.Second {
				delay *= 2
			}
		} else {
			delay = time.Second
		}
	}
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func (p *provider) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(p.lease / 3)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.claimed.Range(func(k, _ any) bool { _ = p.Heartbeat(ctx, k.(string)); return true })
		}
	}
}

func (p *provider) Heartbeat(ctx context.Context, id string) error {
	res, err := p.db.ExecContext(ctx, `UPDATE gmaps_jobs SET heartbeat_at=NOW(),lease_expires_at=NOW()+($1*INTERVAL '1 second'),updated_at=NOW() WHERE id=$2 AND worker_id=$3 AND status=$4`, int(p.lease.Seconds()), id, p.workerID, statusRunning)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		p.claimed.Delete(id)
		return sql.ErrNoRows
	}
	return nil
}
func (p *provider) Acknowledge(ctx context.Context, id string) error {
	defer p.claimed.Delete(id)
	_, err := p.db.ExecContext(ctx, `UPDATE gmaps_jobs SET status=$1,updated_at=NOW(),worker_id='',heartbeat_at=NULL,lease_expires_at=NULL,last_error='' WHERE id=$2 AND worker_id=$3 AND status=$4`, statusSucceeded, id, p.workerID, statusRunning)
	return err
}
func (p *provider) Fail(ctx context.Context, id, message string) error {
	defer p.claimed.Delete(id)
	if len(message) > 1000 {
		message = message[:1000]
	}
	_, err := p.db.ExecContext(ctx, `UPDATE gmaps_jobs SET status=CASE WHEN attempts<max_attempts THEN $1 ELSE $2 END,updated_at=NOW(),worker_id='',heartbeat_at=NULL,lease_expires_at=NULL,last_error=$3 WHERE id=$4 AND worker_id=$5 AND status=$6`, statusQueued, statusFailed, message, id, p.workerID, statusRunning)
	return err
}

func decodeJob(payloadType string, payload []byte) (scrapemate.IJob, error) {
	var env payloadEnvelope
	if json.Unmarshal(payload, &env) == nil && env.Version > 0 {
		if env.Version != 1 || env.Encoding != "gob" || env.Type != payloadType {
			return nil, errors.New("unsupported or inconsistent job payload envelope")
		}
		sum := sha256.Sum256(env.Data)
		if !equalHex(env.SHA256, sum[:]) {
			return nil, errors.New("job payload checksum mismatch")
		}
		payload = env.Data
	}
	dec := gob.NewDecoder(bytes.NewReader(payload))
	var target scrapemate.IJob
	switch payloadType {
	case "search":
		target = new(gmaps.GmapJob)
	case "place":
		target = new(gmaps.PlaceJob)
	case "email":
		target = new(gmaps.EmailExtractJob)
	case "fast_search":
		target = new(gmaps.SearchJob)
	default:
		return nil, fmt.Errorf("invalid payload type %q", payloadType)
	}
	if err := dec.Decode(target); err != nil {
		return nil, fmt.Errorf("decode %s job: %w", payloadType, err)
	}
	return target, nil
}
func equalHex(value string, sum []byte) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && bytes.Equal(decoded, sum)
}
