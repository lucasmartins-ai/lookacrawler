package webrunner

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/coelhobugado/google-maps-scraper/deduper"
	"github.com/coelhobugado/google-maps-scraper/exiter"
	"github.com/coelhobugado/google-maps-scraper/internal/csvsafe"
	"github.com/coelhobugado/google-maps-scraper/internal/redact"
	"github.com/coelhobugado/google-maps-scraper/internal/securefile"
	"github.com/coelhobugado/google-maps-scraper/runner"
	"github.com/coelhobugado/google-maps-scraper/web"
	"github.com/coelhobugado/google-maps-scraper/web/sqlite"
	"github.com/gosom/scrapemate"
	"github.com/gosom/scrapemate/adapters/writers/csvwriter"
	"github.com/gosom/scrapemate/scrapemateapp"
	"golang.org/x/sync/errgroup"
)

type webrunner struct {
	srv       *web.Server
	svc       *web.Service
	cfg       *runner.Config
	setupMate func(context.Context, io.Writer, *web.Job) (mateRunner, error)
}
type mateRunner interface {
	Start(context.Context, ...scrapemate.IJob) error
	Close() error
}

func New(cfg *runner.Config) (runner.Runner, error) {
	if cfg.DataFolder == "" {
		return nil, errors.New("data folder is required")
	}
	if err := securefile.EnsureDir(cfg.DataFolder); err != nil {
		return nil, err
	}
	if err := securefile.EnsureDir(filepath.Join(cfg.DataFolder, "results")); err != nil {
		return nil, err
	}
	if err := securefile.EnsureDir(filepath.Join(cfg.DataFolder, "exports")); err != nil {
		return nil, err
	}
	if err := validateBind(cfg); err != nil {
		return nil, err
	}
	repo, err := sqlite.New(filepath.Join(cfg.DataFolder, "jobs.db"))
	if err != nil {
		return nil, err
	}
	svc := web.NewService(repo, cfg.DataFolder)
	srv, err := web.New(svc, cfg.Addr, web.WithAllowedHosts(cfg.AllowedHosts), web.WithRetention(cfg.RetentionDays), web.WithMaxRequestBytes(cfg.MaxRequestBytes))
	if err != nil {
		svc.Close()
		return nil, err
	}
	return &webrunner{srv: srv, svc: svc, cfg: cfg, setupMate: defaultSetupMate(cfg)}, nil
}
func validateBind(cfg *runner.Config) error {
	host, _, err := net.SplitHostPort(cfg.Addr)
	if err != nil {
		return fmt.Errorf("invalid address: %w", err)
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	loopback := host == "localhost" || (ip != nil && ip.IsLoopback())
	if !loopback && !cfg.AllowNetwork {
		return errors.New("non-loopback binding requires -allow-network")
	}
	if !loopback && len(cfg.AllowedHosts) == 0 {
		return errors.New("network mode requires -allowed-hosts")
	}
	return nil
}
func (w *webrunner) BrowserURL() string { return w.srv.BaseURL() }
func (w *webrunner) Run(ctx context.Context) error {
	_, _ = w.svc.RecoverExpired(ctx, time.Now().UTC())
	group, gctx := errgroup.WithContext(ctx)
	workers := 4
	for i := 0; i < workers; i++ {
		group.Go(func() error { return w.work(gctx) })
	}
	group.Go(func() error { return w.srv.Start(gctx) })
	return group.Wait()
}
func (w *webrunner) Close(context.Context) error { return w.svc.Close() }

func (w *webrunner) work(ctx context.Context) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	recovery := time.NewTicker(30 * time.Second)
	defer recovery.Stop()
	worker := uuid.New().String()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-recovery.C:
			if n, err := w.svc.RecoverExpired(ctx, time.Now().UTC()); err == nil && n > 0 {
				slog.Warn("recovered expired campaigns", "count", n)
			}
		case <-ticker.C:
			job, err := w.svc.ClaimQueued(ctx, worker, 45*time.Second)
			if err != nil {
				if !errors.Is(err, web.ErrNotFound) {
					slog.Debug("claim skipped", "error", redact.String(err.Error()))
				}
				continue
			}
			w.execute(ctx, worker, &job)
		}
	}
}

func (w *webrunner) execute(parent context.Context, worker string, job *web.Job) {
	jobCtx, cancel := context.WithCancel(parent)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		poll := time.NewTicker(time.Second)
		defer ticker.Stop()
		defer poll.Stop()
		defer close(heartbeatDone)
		for {
			select {
			case <-jobCtx.Done():
				return
			case <-ticker.C:
				_ = w.svc.Heartbeat(jobCtx, job.ID, worker, 45*time.Second)
			case <-poll.C:
				requested, err := w.svc.CancelRequested(jobCtx, job.ID)
				if err == nil && requested {
					cancel()
					return
				}
			}
		}
	}()
	started := time.Now()
	count, partial, err := w.scrapeJob(jobCtx, worker, job)
	cancel()
	<-heartbeatDone
	status := web.StatusSucceeded
	code, message := "", ""
	if err != nil {
		message = redact.String(err.Error())
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			status = web.StatusTimedOut
			code = "timeout"
		case errors.Is(err, context.Canceled):
			requested, _ := w.svc.CancelRequested(context.Background(), job.ID)
			if count > 0 {
				status = web.StatusSucceeded
				code = ""
				message = ""
				err = nil
			} else if requested {
				status = web.StatusCanceled
				code = "canceled"
			} else {
				status = web.StatusInterrupted
				code = "interrupted"
			}
		default:
			status = web.StatusFailed
			code = "scrape_failed"
		}
	}
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer finishCancel()
	if finishErr := w.svc.Finish(finishCtx, job.ID, status, code, message, count, partial); finishErr != nil {
		slog.Error("finish campaign", "job_id", job.ID, "error", redact.String(finishErr.Error()))
	} else {
		slog.Info("campaign finished", "job_id", job.ID, "status", status, "results", count, "duration_ms", time.Since(started).Milliseconds())
	}
}

func (w *webrunner) scrapeJob(ctx context.Context, worker string, job *web.Job) (int, bool, error) {
	if len(job.Data.Keywords) == 0 {
		return 0, false, errors.New("missing keywords")
	}
	resultDir := filepath.Join(w.cfg.DataFolder, "results")
	rawPath := filepath.Join(resultDir, job.ID+".raw.tmp")
	safePath := filepath.Join(resultDir, job.ID+".tmp.csv")
	finalPath := filepath.Join(resultDir, job.ID+".csv")
	partialPath := filepath.Join(resultDir, job.ID+".partial.csv")
	_ = os.Remove(rawPath)
	_ = os.Remove(safePath)
	file, err := os.OpenFile(rawPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, false, err
	}
	setup := w.setupMate
	if setup == nil {
		setup = defaultSetupMate(w.cfg)
	}
	mate, err := setup(ctx, file, job)
	if err != nil {
		file.Close()
		os.Remove(rawPath)
		return 0, false, err
	}
	defer mate.Close()
	coords := ""
	if job.Data.Lat != "" && job.Data.Lon != "" {
		coords = job.Data.Lat + "," + job.Data.Lon
	}
	queries := append([]string(nil), job.Data.Keywords...)
	if !job.Data.FastMode && coords == "" && strings.TrimSpace(job.Data.Location) != "" {
		location := strings.TrimSpace(job.Data.Location)
		for i := range queries {
			query := strings.TrimSpace(queries[i])
			if !strings.Contains(strings.ToLower(query), strings.ToLower(location)) {
				query += " em " + location
			}
			queries[i] = query
		}
	}
	progressMonitor := exiter.New()
	seed, err := runner.CreateSeedJobs(job.Data.FastMode, job.Data.Lang, strings.NewReader(strings.Join(queries, "\n")), job.Data.Depth, job.Data.Email, coords, job.Data.Zoom, float64(job.Data.Radius), deduper.New(), progressMonitor, w.cfg.ExtraReviews || job.Data.ExtraReviews, &runner.RequestBudget{MaxGridCells: w.cfg.MaxGridCells, MaxSeedJobs: w.cfg.MaxSeedJobs})
	if err != nil {
		file.Close()
		os.Remove(rawPath)
		return 0, false, err
	}
	progressMonitor.SetSeedCount(len(seed))
	_ = w.svc.UpdateProgress(ctx, job.ID, worker, 0, len(seed))
	runCtx, cancel := context.WithTimeout(ctx, job.Data.MaxTime)
	defer cancel()
	progressMonitor.SetCancelFunc(cancel)
	go progressMonitor.Run(runCtx)
	progressDone := make(chan struct{})
	go w.reportProgress(runCtx, progressDone, job.ID, worker, progressMonitor)
	runErr := mate.Start(runCtx, seed...)
	close(progressDone)
	_ = file.Sync()
	_ = file.Close()
	count, sanitizeErr := sanitizeCSV(rawPath, safePath)
	os.Remove(rawPath)
	if errors.Is(runErr, context.Canceled) && count > 0 {
		runErr = nil
	}
	if runErr == nil {
		runErr = sanitizeErr
	}
	partial := false
	if runErr == nil {
		if err := atomicPublish(safePath, finalPath); err != nil {
			return count, false, err
		}
		_ = os.Remove(partialPath)
		_ = w.svc.UpdateProgress(context.Background(), job.ID, worker, len(seed), len(seed))
		return count, false, nil
	}
	if count > 0 && sanitizeErr == nil {
		if err := atomicPublish(safePath, partialPath); err == nil {
			partial = true
		}
	} else {
		_ = os.Remove(safePath)
	}
	return count, partial, runErr
}

func (w *webrunner) reportProgress(ctx context.Context, done <-chan struct{}, jobID, worker string, monitor exiter.Exiter) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			seedTotal, seedDone, placesFound, placesDone := monitor.Snapshot()
			current, total := seedDone, seedTotal
			if placesFound > 0 {
				current += placesDone
				total += placesFound
			}
			if total > 0 {
				_ = w.svc.UpdateProgress(ctx, jobID, worker, min(current, total), total)
			}
		}
	}
}

func sanitizeCSV(source, dest string) (int, error) {
	in, err := os.Open(source)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	r := csv.NewReader(in)
	r.FieldsPerRecord = -1
	w := csv.NewWriter(out)
	count := -1
	for {
		record, readErr := r.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			out.Close()
			os.Remove(dest)
			return max(0, count), readErr
		}
		if err := w.Write(csvsafe.Record(record)); err != nil {
			out.Close()
			os.Remove(dest)
			return max(0, count), err
		}
		count++
	}
	w.Flush()
	err = w.Error()
	if err == nil {
		err = out.Sync()
	}
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(dest)
		return max(0, count), err
	}
	return max(0, count), nil
}
func atomicPublish(tmp, final string) error {
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, final); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(final))
	if err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func defaultSetupMate(cfg *runner.Config) func(context.Context, io.Writer, *web.Job) (mateRunner, error) {
	return func(_ context.Context, writer io.Writer, job *web.Job) (mateRunner, error) {
		exitDuration := cfg.ExitOnInactivityDuration
		if exitDuration <= 0 {
			exitDuration = 5 * time.Second
		}
		opts := []func(*scrapemateapp.Config) error{scrapemateapp.WithConcurrency(cfg.Concurrency), scrapemateapp.WithExitOnInactivity(exitDuration)}
		if !job.Data.FastMode {
			if cfg.Debug {
				opts = append(opts, scrapemateapp.WithJS(scrapemateapp.Headfull(), scrapemateapp.DisableImages()))
			} else {
				opts = append(opts, scrapemateapp.WithJS(scrapemateapp.DisableImages()))
			}
		} else {
			opts = append(opts, scrapemateapp.WithStealth("firefox"))
		}
		opts = runner.AppendBrowserCapacityOptions(opts, cfg)
		proxies := cfg.Proxies
		if len(proxies) == 0 {
			proxies = job.Data.Proxies
		}
		if len(proxies) > 0 {
			opts = append(opts, scrapemateapp.WithProxies(proxies))
		}
		if !cfg.DisablePageReuse {
			opts = append(opts, scrapemateapp.WithPageReuseLimit(2), scrapemateapp.WithBrowserReuseLimit(200))
		}
		writers := []scrapemate.ResultWriter{runner.NewDriftDetectorWriter(csvwriter.NewCsvWriter(csv.NewWriter(writer)))}
		mateCfg, err := scrapemateapp.NewConfig(writers, opts...)
		if err != nil {
			return nil, err
		}
		return scrapemateapp.NewScrapeMateApp(mateCfg)
	}
}
