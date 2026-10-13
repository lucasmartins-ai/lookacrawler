package web

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coelhobugado/google-maps-scraper/internal/securefile"
)

type Service struct {
	repo       JobRepository
	dataFolder string
}

func NewService(repo JobRepository, dataFolder string) *Service {
	return &Service{repo: repo, dataFolder: dataFolder}
}
func (s *Service) Close() error                               { return s.repo.Close() }
func (s *Service) Create(ctx context.Context, job *Job) error { return s.repo.Create(ctx, job) }
func (s *Service) Select(ctx context.Context, p SelectParams) ([]Job, error) {
	return s.repo.Select(ctx, p)
}
func (s *Service) All(ctx context.Context) ([]Job, error) {
	return s.repo.Select(ctx, SelectParams{Limit: 100})
}
func (s *Service) Count(ctx context.Context, status string) (int, error) {
	return s.repo.Count(ctx, status)
}
func (s *Service) Get(ctx context.Context, id string) (Job, error) { return s.repo.Get(ctx, id) }
func (s *Service) Update(ctx context.Context, job *Job) error {
	return errors.New("direct job update is not supported")
}
func (s *Service) ClaimQueued(ctx context.Context, worker string, lease time.Duration) (Job, error) {
	return s.repo.ClaimQueued(ctx, worker, lease)
}
func (s *Service) Heartbeat(ctx context.Context, id, worker string, lease time.Duration) error {
	return s.repo.Heartbeat(ctx, id, worker, lease)
}
func (s *Service) UpdateProgress(ctx context.Context, id, worker string, current, total int) error {
	return s.repo.UpdateProgress(ctx, id, worker, current, total)
}
func (s *Service) Finish(ctx context.Context, id, status, code, message string, count int, partial bool) error {
	return s.repo.Finish(ctx, id, status, code, message, count, partial)
}
func (s *Service) Cancel(ctx context.Context, id string) error { return s.repo.RequestCancel(ctx, id) }
func (s *Service) CancelRequested(ctx context.Context, id string) (bool, error) {
	return s.repo.CancelRequested(ctx, id)
}
func (s *Service) RecoverExpired(ctx context.Context, before time.Time) (int, error) {
	return s.repo.RecoverExpired(ctx, before)
}
func (s *Service) Retry(ctx context.Context, id string) error     { return s.repo.Retry(ctx, id) }
func (s *Service) AppendEvent(ctx context.Context, e Event) error { return s.repo.AppendEvent(ctx, e) }
func (s *Service) Events(ctx context.Context, id string, limit int) ([]Event, error) {
	return s.repo.Events(ctx, id, limit)
}
func (s *Service) Exports(ctx context.Context, id string) ([]Export, error) {
	return s.repo.Exports(ctx, id)
}
func (s *Service) SaveTemplate(ctx context.Context, t Template) error {
	return s.repo.SaveTemplate(ctx, t)
}
func (s *Service) Templates(ctx context.Context) ([]Template, error) { return s.repo.Templates(ctx) }
func (s *Service) DeleteTemplate(ctx context.Context, id string) error {
	return s.repo.DeleteTemplate(ctx, id)
}

func safeID(id string) error {
	if id == "" || strings.ContainsAny(id, "/\\") || strings.Contains(id, "..") {
		return errors.New("invalid id")
	}
	return nil
}
func (s *Service) ResultPath(id string) (string, error) {
	if err := safeID(id); err != nil {
		return "", err
	}
	path := filepath.Join(s.dataFolder, "results", id+".csv")
	if _, err := os.Stat(path); err != nil {
		return "", err
	}
	return path, nil
}
func (s *Service) PartialPath(id string) (string, error) {
	if err := safeID(id); err != nil {
		return "", err
	}
	path := filepath.Join(s.dataFolder, "results", id+".partial.csv")
	if _, err := os.Stat(path); err != nil {
		return "", err
	}
	return path, nil
}
func (s *Service) RawPath(id string) (string, error) {
	if err := safeID(id); err != nil {
		return "", err
	}
	path := filepath.Join(s.dataFolder, "results", id+".raw.tmp")
	if _, err := os.Stat(path); err != nil {
		return "", err
	}
	return path, nil
}
func (s *Service) Delete(ctx context.Context, id string) error {
	if err := safeID(id); err != nil {
		return err
	}
	if _, err := s.repo.Get(ctx, id); err != nil {
		return err
	}
	for _, p := range []string{filepath.Join(s.dataFolder, "results", id+".csv"), filepath.Join(s.dataFolder, "results", id+".partial.csv"), filepath.Join(s.dataFolder, "results", id+".tmp.csv"), filepath.Join(s.dataFolder, "exports", id)} {
		_ = os.RemoveAll(p)
	}
	return s.repo.Delete(ctx, id)
}

func (s *Service) CreateExport(ctx context.Context, jobID string, filter ResultFilter) (Export, error) {
	var out Export
	if err := safeID(jobID); err != nil {
		return out, err
	}
	source, err := s.ResultPath(jobID)
	if err != nil {
		return out, err
	}
	rows, header, _, err := ReadResultPage(source, filter, 0, 0)
	if err != nil {
		return out, err
	}
	out = Export{ID: fmt.Sprintf("%d", time.Now().UTC().UnixNano()), JobID: jobID, Format: "csv", RowCount: len(rows), Filter: filter.String(), CreatedAt: time.Now().UTC()}
	dir := filepath.Join(s.dataFolder, "exports", jobID)
	if err := securefile.EnsureDir(dir); err != nil {
		return Export{}, err
	}
	out.Path = filepath.Join(dir, out.ID+".csv")
	tmp := out.Path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return Export{}, err
	}
	err = writeFriendlyCSV(f, header, rows)
	if syncErr := f.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(tmp)
		return Export{}, err
	}
	data, err := os.ReadFile(tmp)
	if err != nil {
		os.Remove(tmp)
		return Export{}, err
	}
	sum := sha256.Sum256(data)
	out.SHA256 = hex.EncodeToString(sum[:])
	if err = os.Rename(tmp, out.Path); err != nil {
		os.Remove(tmp)
		return Export{}, err
	}
	if err = s.repo.CreateExport(ctx, out); err != nil {
		os.Remove(out.Path)
		return Export{}, err
	}
	return out, nil
}

func (s *Service) Purge(ctx context.Context, before time.Time) (int, error) {
	ids, err := s.repo.PurgeBefore(ctx, before)
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		_ = os.Remove(filepath.Join(s.dataFolder, "results", id+".csv"))
		_ = os.Remove(filepath.Join(s.dataFolder, "results", id+".partial.csv"))
		_ = os.RemoveAll(filepath.Join(s.dataFolder, "exports", id))
	}
	return len(ids), nil
}

type ResultFilter struct {
	Search       string
	Category     string
	MinRating    float64
	HasPhone     *bool
	HasWebsite   *bool
	HasInstagram *bool
	HasEmail     *bool
}

func (f ResultFilter) String() string {
	return fmt.Sprintf("search=%s;category=%s;min_rating=%g;phone=%v;website=%v;instagram=%v;email=%v", f.Search, f.Category, f.MinRating, f.HasPhone, f.HasWebsite, f.HasInstagram, f.HasEmail)
}

func ReadResultPage(path string, filter ResultFilter, limit, offset int) ([][]string, []string, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, 0, err
	}
	defer f.Close()
	r := csv.NewReader(io.LimitReader(f, 512<<20))
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return nil, nil, 0, err
	}
	indexes := map[string]int{}
	for i, h := range header {
		indexes[strings.ToLower(strings.TrimSpace(h))] = i
	}
	var out [][]string
	total := 0
	for {
		row, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, 0, err
		}
		if !matchRow(row, indexes, filter) {
			continue
		}
		if total >= offset && (limit <= 0 || len(out) < limit) {
			out = append(out, row)
		}
		total++
	}
	return out, header, total, nil
}
func matchRow(row []string, idx map[string]int, f ResultFilter) bool {
	get := func(names ...string) string {
		for _, n := range names {
			if i, ok := idx[n]; ok && i < len(row) {
				return row[i]
			}
		}
		return ""
	}
	all := strings.ToLower(strings.Join(row, " "))
	if f.Search != "" && !strings.Contains(all, strings.ToLower(f.Search)) {
		return false
	}
	record := resultRecord{row: row, idx: idx}
	if f.Category != "" && !strings.Contains(strings.ToLower(strings.Join(record.categories(), " ")), strings.ToLower(f.Category)) {
		return false
	}
	if f.MinRating > 0 {
		var rating float64
		fmt.Sscanf(get("review_rating", "rating"), "%f", &rating)
		if rating < f.MinRating {
			return false
		}
	}
	for value, names := range map[*bool][]string{f.HasPhone: {"phone", "phone_number"}, f.HasEmail: {"email", "emails"}} {
		if value == nil {
			continue
		}
		present := strings.TrimSpace(get(names...)) != ""
		if present != *value {
			return false
		}
	}
	website, instagram := record.contacts()
	if f.HasWebsite != nil && (website != "") != *f.HasWebsite {
		return false
	}
	if f.HasInstagram != nil && (instagram != "") != *f.HasInstagram {
		return false
	}
	return true
}
