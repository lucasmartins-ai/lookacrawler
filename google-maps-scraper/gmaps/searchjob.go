package gmaps

import (
	"bytes"
	"context"
	"encoding/gob"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/coelhobugado/google-maps-scraper/exiter"
	"github.com/gosom/scrapemate"
)

type SearchJobOptions func(*SearchJob)

type MapLocation struct {
	Lat     float64
	Lon     float64
	ZoomLvl float64
	Radius  float64
}

type MapSearchParams struct {
	Location  MapLocation
	Query     string
	ViewportW int
	ViewportH int
	Hl        string
}

type SearchJob struct {
	scrapemate.Job

	params                  *MapSearchParams
	ExitMonitor             exiter.Exiter
	WriterManagedCompletion bool
}

func NewSearchJob(params *MapSearchParams, opts ...SearchJobOptions) *SearchJob {
	const (
		defaultPrio       = scrapemate.PriorityMedium
		defaultMaxRetries = 3
		baseURL           = "https://maps.google.com/search"
	)

	job := SearchJob{
		Job: scrapemate.Job{
			ID:         uuid.New().String(),
			Method:     http.MethodGet,
			URL:        baseURL,
			URLParams:  buildGoogleMapsParams(params),
			MaxRetries: defaultMaxRetries,
			Priority:   defaultPrio,
		},
	}

	job.params = params

	for _, opt := range opts {
		opt(&job)
	}

	return &job
}

func WithSearchJobExitMonitor(exitMonitor exiter.Exiter) SearchJobOptions {
	return func(j *SearchJob) {
		j.ExitMonitor = exitMonitor
	}
}

func WithSearchJobWriterManagedCompletion() SearchJobOptions {
	return func(j *SearchJob) {
		j.WriterManagedCompletion = true
	}
}

func (j *SearchJob) ProcessOnFetchError() bool {
	return true
}

func (j *SearchJob) Process(_ context.Context, resp *scrapemate.Response) (any, []scrapemate.IJob, error) {
	defer func() {
		resp.Document = nil
		resp.Body = nil
		resp.Meta = nil
	}()

	if resp.Error != nil {
		if j.ExitMonitor != nil {
			j.ExitMonitor.IncrSeedCompleted(1)
		}

		return nil, nil, resp.Error
	}

	body := removeFirstLine(resp.Body)
	if len(body) == 0 {
		if j.ExitMonitor != nil {
			j.ExitMonitor.IncrSeedCompleted(1)
		}

		return nil, nil, fmt.Errorf("empty response body")
	}

	entries, err := ParseSearchResults(body)
	if err != nil {
		if j.ExitMonitor != nil {
			j.ExitMonitor.IncrSeedCompleted(1)
		}

		return nil, nil, fmt.Errorf("failed to parse search results: %w", err)
	}

	entries = filterAndSortEntriesWithinRadius(entries,
		j.params.Location.Lat,
		j.params.Location.Lon,
		j.params.Location.Radius,
	)

	if j.ExitMonitor != nil {
		j.ExitMonitor.IncrPlacesFound(len(entries))
		j.ExitMonitor.IncrSeedCompleted(1)

		if !j.WriterManagedCompletion {
			j.ExitMonitor.IncrPlacesCompleted(len(entries))
		}
	}

	return entries, nil, nil
}

func removeFirstLine(data []byte) []byte {
	if len(data) == 0 {
		return data
	}

	index := bytes.IndexByte(data, '\n')
	if index == -1 {
		return []byte{}
	}

	return data[index+1:]
}

func buildGoogleMapsParams(params *MapSearchParams) map[string]string {
	params.ViewportH = 800
	params.ViewportW = 600

	ans := map[string]string{
		"tbm":      "map",
		"authuser": "0",
		"hl":       params.Hl,
		"q":        params.Query,
	}

	pb := fmt.Sprintf("!4m12!1m3!1d3826.902183192154!2d%.4f!3d%.4f!2m3!1f0!2f0!3f0!3m2!1i%d!2i%d!4f%.1f!7i20!8i0"+
		"!10b1!12m22!1m3!18b1!30b1!34e1!2m3!5m1!6e2!20e3!4b0!10b1!12b1!13b1!16b1!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0"+
		"!96b1!19m4!2m3!1i360!2i120!4i8",
		params.Location.Lon,
		params.Location.Lat,
		params.ViewportW,
		params.ViewportH,
		params.Location.ZoomLvl,
	)

	ans["pb"] = pb

	return ans
}

// GobEncode persists only the serializable state required by distributed workers.
func (j *SearchJob) GobEncode() ([]byte, error) {
	type snapshot struct {
		Job                     scrapemate.Job
		Params                  *MapSearchParams
		WriterManagedCompletion bool
	}
	var buf bytes.Buffer
	err := gob.NewEncoder(&buf).Encode(snapshot{Job: j.Job, Params: j.params, WriterManagedCompletion: j.WriterManagedCompletion})
	return buf.Bytes(), err
}

// GobDecode restores a distributed search job without process-local monitors.
func (j *SearchJob) GobDecode(data []byte) error {
	type snapshot struct {
		Job                     scrapemate.Job
		Params                  *MapSearchParams
		WriterManagedCompletion bool
	}
	var s snapshot
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&s); err != nil {
		return err
	}
	if s.Params == nil {
		return errors.New("search job payload is missing map parameters")
	}
	j.Job = s.Job
	j.params = s.Params
	j.WriterManagedCompletion = s.WriterManagedCompletion
	j.ExitMonitor = nil
	return nil
}
