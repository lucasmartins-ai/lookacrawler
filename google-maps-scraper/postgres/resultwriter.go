package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gosom/scrapemate"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/coelhobugado/google-maps-scraper/gmaps"
	"github.com/coelhobugado/google-maps-scraper/internal/jsonbsanitize"
	"github.com/coelhobugado/google-maps-scraper/log"
)

func NewResultWriter(db *sql.DB) scrapemate.ResultWriter {
	return NewResultWriterWithLifecycle(db, nil)
}

func NewResultWriterWithLifecycle(db *sql.DB, lifecycle LifecycleProvider) scrapemate.ResultWriter {
	return &resultWriter{db: db, lifecycle: lifecycle, now: time.Now, saveInterval: time.Minute}
}

type resultWriter struct {
	db           *sql.DB
	lifecycle    LifecycleProvider
	now          func() time.Time
	saveInterval time.Duration
}

func (r *resultWriter) Run(ctx context.Context, in <-chan scrapemate.Result) error {
	const maxBatchSize = 50
	buff := make([]*gmaps.Entry, 0, maxBatchSize)
	jobIDs := make(map[string]struct{})
	lastSave := r.currentTime()

	failTracked := func(cause error) {
		if r.lifecycle == nil {
			return
		}
		for id := range jobIDs {
			_ = r.lifecycle.Fail(context.Background(), id, cause.Error())
		}
	}
	flush := func() error {
		if len(buff) == 0 {
			return nil
		}
		if err := r.batchSave(ctx, buff); err != nil {
			return err
		}
		buff = buff[:0]
		lastSave = r.currentTime()
		return nil
	}

	for {
		select {
		case <-ctx.Done():
			failTracked(ctx.Err())
			return ctx.Err()
		case result, ok := <-in:
			if !ok {
				if err := flush(); err != nil {
					failTracked(err)
					return err
				}
				if r.lifecycle != nil {
					for id := range jobIDs {
						if err := r.lifecycle.Acknowledge(ctx, id); err != nil {
							return fmt.Errorf("acknowledge job %s: %w", id, err)
						}
					}
				}
				return nil
			}
			entry, ok := result.Data.(*gmaps.Entry)
			if !ok {
				err := fmt.Errorf("invalid data type %T", result.Data)
				failTracked(err)
				return err
			}
			buff = append(buff, entry)
			if result.Job != nil && result.Job.GetID() != "" {
				jobIDs[result.Job.GetID()] = struct{}{}
			}
			if len(buff) >= maxBatchSize || r.currentTime().Sub(lastSave) >= r.saveEvery() {
				if err := flush(); err != nil {
					failTracked(err)
					return err
				}
			}
		}
	}
}

func (r *resultWriter) currentTime() time.Time {
	if r.now == nil {
		return time.Now()
	}

	return r.now()
}

func (r *resultWriter) saveEvery() time.Duration {
	if r.saveInterval == 0 {
		return time.Minute
	}

	return r.saveInterval
}

func (r *resultWriter) batchSave(ctx context.Context, entries []*gmaps.Entry) error {
	if len(entries) == 0 {
		return nil
	}

	q := `INSERT INTO results
		(data)
		VALUES
		`
	elements := make([]string, 0, len(entries))
	args := make([]interface{}, 0, len(entries))

	for i, entry := range entries {
		data, err := marshalEntry(entry)
		if err != nil {
			return err
		}

		elements = append(elements, fmt.Sprintf("($%d)", i+1))
		args = append(args, data)
	}

	q += strings.Join(elements, ", ")
	q += " ON CONFLICT DO NOTHING"

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	_, err = tx.ExecContext(ctx, q, args...)
	if err != nil {
		if isJSONBNULByteError(err) {
			_ = tx.Rollback()
			return r.saveRowsOneByOne(ctx, entries)
		}

		return err
	}

	err = tx.Commit()
	if err == nil {
		committed = true
	}

	return err
}

func marshalEntry(entry *gmaps.Entry) ([]byte, error) {
	jsonbsanitize.StripNULFromEntry(entry)

	return json.Marshal(entry)
}

func (r *resultWriter) saveRowsOneByOne(ctx context.Context, entries []*gmaps.Entry) error {
	const q = `INSERT INTO results
		(data)
		VALUES
		($1) ON CONFLICT DO NOTHING`

	skipped := 0

	for _, entry := range entries {
		data, err := marshalEntry(entry)
		if err != nil {
			return err
		}

		_, err = r.db.ExecContext(ctx, q, data)
		if err == nil {
			continue
		}

		if isJSONBNULByteError(err) {
			skipped++

			log.Warn("skipping invalid result row during database insert",
				"id", entry.ID,
				"error_code", "invalid_jsonb",
			)

			continue
		}

		return err
	}

	if skipped > 0 {
		log.Warn("skipped result rows due to invalid jsonb payload",
			"count", skipped,
		)
	}

	return nil
}

func isJSONBNULByteError(err error) bool {
	if err == nil {
		return false
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if pgErr.Code != "22P05" {
			return false
		}

		msg := strings.ToLower(pgErr.Message)
		detail := strings.ToLower(pgErr.Detail)

		return strings.Contains(msg, "unsupported unicode escape sequence") &&
			strings.Contains(detail, "cannot be converted to text")
	}

	return false
}
