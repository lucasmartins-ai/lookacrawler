package gmaps

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/google/uuid"
	"github.com/gosom/scrapemate"
	"github.com/mcnijman/go-emailaddress"

	"github.com/coelhobugado/google-maps-scraper/exiter"
	"github.com/coelhobugado/google-maps-scraper/internal/safehttp"
)

type EmailExtractJobOptions func(*EmailExtractJob)

type emailCacheValue struct {
	emails  []string
	expires time.Time
}

var emailCache = struct {
	sync.Mutex
	items map[string]emailCacheValue
}{items: make(map[string]emailCacheValue)}

type EmailExtractJob struct {
	scrapemate.Job

	Entry                   *Entry
	ExitMonitor             exiter.Exiter
	WriterManagedCompletion bool
}

func NewEmailJob(parentID string, entry *Entry, opts ...EmailExtractJobOptions) *EmailExtractJob {
	const (
		defaultPrio       = scrapemate.PriorityHigh
		defaultMaxRetries = 0
	)

	job := EmailExtractJob{
		Job: scrapemate.Job{
			ID:         uuid.New().String(),
			ParentID:   parentID,
			Method:     "GET",
			URL:        normalizeGoogleURL(entry.WebSite),
			MaxRetries: defaultMaxRetries,
			Priority:   defaultPrio,
		},
	}

	job.Entry = entry

	for _, opt := range opts {
		opt(&job)
	}

	return &job
}

func WithEmailJobExitMonitor(exitMonitor exiter.Exiter) EmailExtractJobOptions {
	return func(j *EmailExtractJob) {
		j.ExitMonitor = exitMonitor
	}
}

func WithEmailJobWriterManagedCompletion() EmailExtractJobOptions {
	return func(j *EmailExtractJob) {
		j.WriterManagedCompletion = true
	}
}

func (j *EmailExtractJob) Process(ctx context.Context, resp *scrapemate.Response) (any, []scrapemate.IJob, error) {
	defer func() {
		resp.Document = nil
		resp.Body = nil
	}()
	defer func() {
		if j.ExitMonitor != nil && !j.WriterManagedCompletion {
			j.ExitMonitor.IncrPlacesCompleted(1)
		}
	}()

	cacheKey := normalizeGoogleURL(j.URL)
	emailCache.Lock()
	if cached, ok := emailCache.items[cacheKey]; ok && time.Now().Before(cached.expires) {
		j.Entry.Emails = append([]string(nil), cached.emails...)
		emailCache.Unlock()
		return j.Entry, nil, nil
	}
	emailCache.Unlock()

	client := safehttp.NewClient()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cacheKey, nil)
	if err != nil {
		return j.Entry, nil, nil
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; GoogleMapsScraperLocal/2.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5")

	httpResp, err := client.Do(req)
	if err != nil {
		return j.Entry, nil, nil
	}
	defer httpResp.Body.Close()
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return j.Entry, nil, nil
	}
	contentType := strings.ToLower(httpResp.Header.Get("Content-Type"))
	if contentType != "" && !strings.Contains(contentType, "text/html") && !strings.Contains(contentType, "text/plain") && !strings.Contains(contentType, "application/xhtml") {
		return j.Entry, nil, nil
	}

	const maxBody = int64(2 << 20)
	bodyBytes, err := io.ReadAll(io.LimitReader(httpResp.Body, maxBody+1))
	if err != nil || int64(len(bodyBytes)) > maxBody {
		return j.Entry, nil, nil
	}

	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(bodyBytes))
	if err != nil {
		return j.Entry, nil, nil
	}
	emails := docEmailExtractor(doc)
	if len(emails) == 0 {
		emails = regexEmailExtractor(bodyBytes)
	}
	if len(emails) > 50 {
		emails = emails[:50]
	}
	j.Entry.Emails = emails

	emailCache.Lock()
	if len(emailCache.items) > 2048 {
		emailCache.items = make(map[string]emailCacheValue)
	}
	emailCache.items[cacheKey] = emailCacheValue{emails: append([]string(nil), emails...), expires: time.Now().Add(6 * time.Hour)}
	emailCache.Unlock()

	return j.Entry, nil, nil
}

func (j *EmailExtractJob) ProcessOnFetchError() bool {
	return true
}

func docEmailExtractor(doc *goquery.Document) []string {
	seen := map[string]bool{}

	var emails []string

	doc.Find("a[href^='mailto:']").Each(func(_ int, s *goquery.Selection) {
		mailto, exists := s.Attr("href")
		if exists {
			value := strings.TrimPrefix(mailto, "mailto:")
			if email, err := getValidEmail(value); err == nil {
				if !seen[email] {
					emails = append(emails, email)
					seen[email] = true
				}
			}
		}
	})

	return emails
}

func regexEmailExtractor(body []byte) []string {
	seen := map[string]bool{}

	var emails []string

	addresses := emailaddress.Find(body, false)
	for i := range addresses {
		if !seen[addresses[i].String()] {
			emails = append(emails, addresses[i].String())
			seen[addresses[i].String()] = true
		}
	}

	return emails
}

func getValidEmail(s string) (string, error) {
	email, err := emailaddress.Parse(strings.TrimSpace(s))
	if err != nil {
		return "", err
	}

	return email.String(), nil
}

// normalizeGoogleURL extracts the actual target URL from Google redirect URLs.
// Google Maps sometimes returns URLs like "/url?q=http://example.com/&opi=..."
// for external website links.
func normalizeGoogleURL(rawURL string) string {
	if rawURL == "" {
		return rawURL
	}

	if strings.HasPrefix(rawURL, "/url?q=") {
		fullURL := "https://www.google.com" + rawURL

		parsed, err := url.Parse(fullURL)
		if err != nil {
			return rawURL
		}

		if target := parsed.Query().Get("q"); target != "" {
			return target
		}
	}

	if strings.HasPrefix(rawURL, "/") {
		return "https://www.google.com" + rawURL
	}

	return rawURL
}

func (j *EmailExtractJob) IsEmailJob() bool { return true }
