package runner

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/coelhobugado/google-maps-scraper/deduper"
	"github.com/coelhobugado/google-maps-scraper/exiter"
	"github.com/coelhobugado/google-maps-scraper/gmaps"
	"github.com/coelhobugado/google-maps-scraper/grid"
	"github.com/gosom/scrapemate"
)

func CreateSeedJobs(
	fastmode bool,
	langCode string,
	r io.Reader,
	maxDepth int,
	email bool,
	geoCoordinates string,
	zoom int,
	radius float64,
	dedup deduper.Deduper,
	exitMonitor exiter.Exiter,
	extraReviews bool,
	budget *RequestBudget,
) (jobs []scrapemate.IJob, err error) {
	var lat, lon float64

	if fastmode {
		if geoCoordinates == "" {
			return nil, fmt.Errorf("geo coordinates are required in fast mode")
		}

		parts := strings.Split(geoCoordinates, ",")
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid geo coordinates: %s", geoCoordinates)
		}

		lat, err = strconv.ParseFloat(parts[0], 64)
		if err != nil {
			return nil, fmt.Errorf("invalid latitude: %w", err)
		}

		lon, err = strconv.ParseFloat(parts[1], 64)
		if err != nil {
			return nil, fmt.Errorf("invalid longitude: %w", err)
		}

		if lat < -90 || lat > 90 {
			return nil, fmt.Errorf("invalid latitude: %f", lat)
		}

		if lon < -180 || lon > 180 {
			return nil, fmt.Errorf("invalid longitude: %f", lon)
		}

		if zoom < 1 || zoom > 21 {
			return nil, fmt.Errorf("invalid zoom level: %d", zoom)
		}

		if radius < 0 {
			return nil, fmt.Errorf("invalid radius: %f", radius)
		}
	}

	scanner := bufio.NewScanner(r)

	for scanner.Scan() {
		q, ok, parseErr := parseQueryLine(scanner.Text())
		if parseErr != nil {
			return nil, parseErr
		}

		if !ok {
			continue
		}

		query := q.text
		id := q.id

		var job scrapemate.IJob

		if !fastmode {
			opts := []gmaps.GmapJobOptions{}

			if dedup != nil {
				opts = append(opts, gmaps.WithDeduper(dedup))
			}

			if exitMonitor != nil {
				opts = append(opts, gmaps.WithExitMonitor(exitMonitor))
			}

			if extraReviews {
				opts = append(opts, gmaps.WithExtraReviews())
			}

			job = gmaps.NewGmapJob(id, langCode, query, maxDepth, email, geoCoordinates, zoom, opts...)
		} else {
			jparams := gmaps.MapSearchParams{
				Location: gmaps.MapLocation{
					Lat:     lat,
					Lon:     lon,
					ZoomLvl: float64(zoom),
					Radius:  radius,
				},
				Query:     query,
				ViewportW: 1920,
				ViewportH: 450,
				Hl:        langCode,
			}

			opts := []gmaps.SearchJobOptions{}

			if exitMonitor != nil {
				opts = append(opts, gmaps.WithSearchJobExitMonitor(exitMonitor))
			}

			job = gmaps.NewSearchJob(&jparams, opts...)
		}

		jobs = append(jobs, job)

		if budget != nil {
			if err := budget.CheckSeedJobs(len(jobs)); err != nil {
				return nil, err
			}
		}
	}

	return jobs, scanner.Err()
}

// CreateGridSeedJobs reads search queries from r and produces one GmapJob per
// (query, grid-cell) pair. Each cell covers approximately cellSizeKm × cellSizeKm
// on the ground. The zoom level controls how much of the map Google Maps renders
// per cell (use 14-16 for most cases).
//
// Deduplication across cells is handled automatically by the shared deduper.
func CreateGridSeedJobs(
	langCode string,
	r io.Reader,
	maxDepth int,
	email bool,
	bbox grid.BoundingBox,
	cellSizeKm float64,
	zoom int,
	dedup deduper.Deduper,
	exitMonitor exiter.Exiter,
	extraReviews bool,
	budget *RequestBudget,
) ([]scrapemate.IJob, error) {
	if zoom < 1 || zoom > 21 {
		return nil, fmt.Errorf("invalid zoom level: %d", zoom)
	}

	maxCells := 0
	if budget != nil {
		maxCells = budget.MaxGridCells
	}
	cells, gridErr := grid.GenerateCellsLimited(bbox, cellSizeKm, maxCells)
	if gridErr != nil {
		return nil, gridErr
	}
	if len(cells) == 0 {
		return nil, fmt.Errorf("grid produced 0 cells — check bounding box and cell size")
	}

	if budget != nil {
		if err := budget.CheckGridCells(len(cells)); err != nil {
			return nil, err
		}
	}

	queries, err := readQueries(r)
	if err != nil {
		return nil, err
	}

	if len(queries) == 0 {
		return nil, fmt.Errorf("no queries found in input")
	}

	if budget != nil {
		if err := budget.CheckSeedJobs(len(queries) * len(cells)); err != nil {
			return nil, err
		}
	}

	var jobs []scrapemate.IJob

	for _, q := range queries {
		queryText := q.text
		queryID := q.id

		for _, cell := range cells {
			// Each cell gets a unique ID derived from the query ID (or a new UUID).
			cellID := uuid.New().String()
			if queryID != "" {
				cellID = fmt.Sprintf("%s-%s", queryID, cellID)
			}

			opts := []gmaps.GmapJobOptions{}

			if dedup != nil {
				opts = append(opts, gmaps.WithDeduper(dedup))
			}

			if exitMonitor != nil {
				opts = append(opts, gmaps.WithExitMonitor(exitMonitor))
			}

			if extraReviews {
				opts = append(opts, gmaps.WithExtraReviews())
			}

			job := gmaps.NewGmapJob(
				cellID,
				langCode,
				queryText,
				maxDepth,
				email,
				cell.GeoCoordinates(),
				zoom,
				opts...,
			)

			jobs = append(jobs, job)
		}
	}

	return jobs, nil
}

// query holds a parsed input line.
type query struct {
	text string
	id   string
}

// readQueries reads all non-empty lines from r and parses optional custom IDs
// using the "#!#" delimiter (same format as CreateSeedJobs).
func readQueries(r io.Reader) ([]query, error) {
	var queries []query

	scanner := bufio.NewScanner(r)

	for scanner.Scan() {
		q, ok, parseErr := parseQueryLine(scanner.Text())
		if parseErr != nil {
			return nil, parseErr
		}

		if !ok {
			continue
		}

		queries = append(queries, q)
	}

	return queries, scanner.Err()
}

func parseQueryLine(line string) (query, bool, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return query{}, false, nil
	}

	var q query

	if before, after, ok := strings.Cut(line, "#!#"); ok {
		q.text = strings.TrimSpace(before)
		q.id = strings.TrimSpace(after)
	} else {
		q.text = line
	}

	if q.text == "" {
		return query{}, false, fmt.Errorf("invalid query line %q: empty query text", line)
	}

	return q, true, nil
}

func LoadCustomWriter(pluginPath, _ string) (scrapemate.ResultWriter, error) {
	if filepath.Ext(pluginPath) == ".so" {
		return nil, errors.New("Go native plugins are disabled; use a standalone executable")
	}
	if !filepath.IsAbs(pluginPath) {
		return nil, errors.New("writer executable path must be absolute")
	}
	info, err := os.Stat(pluginPath)
	if err != nil {
		return nil, fmt.Errorf("inspect writer executable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return nil, errors.New("writer path must be an executable regular file")
	}
	data, err := os.ReadFile(pluginPath)
	if err != nil {
		return nil, fmt.Errorf("read writer executable: %w", err)
	}
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if expected := strings.TrimSpace(os.Getenv("GMAPS_WRITER_SHA256")); expected != "" && !strings.EqualFold(expected, got) {
		return nil, errors.New("writer executable checksum does not match GMAPS_WRITER_SHA256")
	}
	return &externalWriter{pluginPath: pluginPath, sha256: got}, nil
}

type externalWriter struct{ pluginPath, sha256 string }

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	original := len(p)
	if b.limit <= 0 {
		return original, nil
	}
	remaining := b.limit - b.Len()
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = b.Buffer.Write(p)
	}
	return original, nil
}

func (w *externalWriter) Run(ctx context.Context, in <-chan scrapemate.Result) error {
	tmpDir, err := os.MkdirTemp("", "gmaps-writer-*")
	if err != nil {
		return fmt.Errorf("create writer sandbox: %w", err)
	}
	defer os.RemoveAll(tmpDir)
	cmd := exec.CommandContext(ctx, w.pluginPath)
	cmd.Dir = tmpDir
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + tmpDir, "TMPDIR=" + tmpDir, "LANG=C.UTF-8", "GMAPS_WRITER_SHA256=" + w.sha256}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("open writer stdin: %w", err)
	}
	stderr := &limitedBuffer{limit: 64 << 10}
	cmd.Stdout = io.Discard
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start writer executable: %w", err)
	}
	enc := json.NewEncoder(stdin)
	for {
		select {
		case <-ctx.Done():
			_ = stdin.Close()
			_ = cmd.Wait()
			return ctx.Err()
		case result, ok := <-in:
			if !ok {
				if err := stdin.Close(); err != nil {
					return err
				}
				if err := cmd.Wait(); err != nil {
					return fmt.Errorf("writer failed: %w: %s", err, strings.TrimSpace(stderr.String()))
				}
				return nil
			}
			if err := enc.Encode(result.Data); err != nil {
				_ = stdin.Close()
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				return fmt.Errorf("encode result for writer: %w", err)
			}
		}
	}
}
