// Package leadsdb provides an optional ResultWriter for LeadsDB.
package leadsdb

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	leadsapi "github.com/gosom/go-leadsdb"
	"github.com/gosom/scrapemate"

	"github.com/coelhobugado/google-maps-scraper/gmaps"
	"github.com/coelhobugado/google-maps-scraper/internal/csvsafe"
	"github.com/coelhobugado/google-maps-scraper/internal/retry"
	"github.com/coelhobugado/google-maps-scraper/internal/securefile"
)

type Config struct {
	APIKey         string
	PreviewMode    bool
	DeadLetterPath string
}
type PartialTransferError struct{ Accepted, Rejected int }

func (e PartialTransferError) Error() string {
	return fmt.Sprintf("LeadsDB transfer partial: %d accepted, %d rejected", e.Accepted, e.Rejected)
}
func NewWithConfig(cfg Config) scrapemate.ResultWriter {
	if cfg.APIKey == "" {
		cfg.APIKey = os.Getenv("LEADSDB_API_KEY")
	}
	if cfg.DeadLetterPath == "" {
		cfg.DeadLetterPath = filepath.Join("webdata", "dead-letter", "leadsdb.csv")
	}
	w := &writer{preview: cfg.PreviewMode, deadLetterPath: cfg.DeadLetterPath}
	if cfg.APIKey == "" && !cfg.PreviewMode {
		w.configErr = errors.New("LEADSDB_API_KEY is required unless preview mode is enabled")
	} else {
		w.client = leadsapi.New(cfg.APIKey)
	}
	return w
}
func New(apiKey string) scrapemate.ResultWriter { return NewWithConfig(Config{APIKey: apiKey}) }

type writer struct {
	client             *leadsapi.Client
	preview            bool
	deadLetterPath     string
	configErr          error
	accepted, rejected int
}

func (w *writer) Run(ctx context.Context, in <-chan scrapemate.Result) error {
	if w.configErr != nil {
		return w.configErr
	}
	const batchSize = 100
	batch := make([]*leadsapi.Lead, 0, batchSize)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		err := w.save(ctx, batch)
		batch = batch[:0]
		return err
	}
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case result, ok := <-in:
			if !ok {
				if err := flush(); err != nil {
					return err
				}
				if w.rejected > 0 {
					return PartialTransferError{w.accepted, w.rejected}
				}
				return nil
			}
			entry, ok := result.Data.(*gmaps.Entry)
			if !ok {
				return errors.New("LeadsDB writer received unexpected result type")
			}
			lead, err := convertToLead(entry)
			if err != nil {
				w.rejected++
				continue
			}
			batch = append(batch, lead)
			if len(batch) >= batchSize {
				if err := flush(); err != nil {
					return err
				}
			}
		case <-timer.C:
			if err := flush(); err != nil {
				return err
			}
		}
	}
}
func (w *writer) save(ctx context.Context, items []*leadsapi.Lead) error {
	if w.preview {
		w.accepted += len(items)
		slog.Info("LeadsDB preview batch", "count", len(items))
		return nil
	}
	var result *leadsapi.BulkCreateResult
	err := retry.Do(ctx, retry.Config{Attempts: 3, BaseDelay: 500 * time.Millisecond, MaxDelay: 4 * time.Second}, func(error) bool { return true }, func(callCtx context.Context) error {
		var callErr error
		result, callErr = w.client.BulkCreate(callCtx, items)
		return callErr
	})
	if err != nil {
		w.rejected += len(items)
		if dlqErr := w.writeDLQ(items, "transport_error"); dlqErr != nil {
			return errors.Join(err, dlqErr)
		}
		return fmt.Errorf("LeadsDB batch failed after retries: %w", err)
	}
	w.accepted += result.Success
	w.rejected += result.Failed
	if result.Failed > 0 {
		failed := make([]*leadsapi.Lead, 0, result.Failed)
		for _, item := range result.Errors {
			if item.Index >= 0 && item.Index < len(items) {
				failed = append(failed, items[item.Index])
			}
		}
		if len(failed) > 0 {
			if err := w.writeDLQ(failed, "provider_rejected"); err != nil {
				return err
			}
		}
	}
	slog.Info("LeadsDB batch completed", "accepted", result.Success, "rejected", result.Failed)
	return nil
}
func (w *writer) writeDLQ(items []*leadsapi.Lead, reason string) error {
	if err := securefile.EnsureDir(filepath.Dir(w.deadLetterPath)); err != nil {
		return err
	}
	f, err := os.OpenFile(w.deadLetterPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = f.Chmod(0o600); err != nil {
		return err
	}
	cw := csv.NewWriter(f)
	for _, lead := range items {
		if err = cw.Write(csvsafe.Record([]string{lead.Name, lead.Address, lead.City, lead.State, lead.Country, lead.PostalCode, lead.Phone, lead.Email, lead.Website, reason})); err != nil {
			return err
		}
	}
	cw.Flush()
	if err = cw.Error(); err != nil {
		return err
	}
	return f.Sync()
}

func convertToLead(entry *gmaps.Entry) (*leadsapi.Lead, error) {
	if entry == nil {
		return nil, errors.New("entry is nil")
	}

	if entry.Title == "" {
		return nil, errors.New("entry title is empty")
	}

	lead := &leadsapi.Lead{
		Name:        entry.Title,
		Source:      "google_maps",
		Description: entry.Description,
		Address:     entry.CompleteAddress.Street,
		City:        entry.CompleteAddress.City,
		State:       entry.CompleteAddress.State,
		Country:     entry.CompleteAddress.Country,
		PostalCode:  entry.CompleteAddress.PostalCode,
		Phone:       entry.Phone,
		Website:     entry.WebSite,
		Category:    entry.Category,
		SourceID:    entry.DataID,
		LogoURL:     entry.Thumbnail,
	}

	// Set coordinates if available
	if entry.Latitude != 0 || entry.Longitude != 0 {
		lead.Latitude = leadsapi.Ptr(entry.Latitude)
		lead.Longitude = leadsapi.Ptr(entry.Longitude)
	}

	// Set rating if available
	if entry.ReviewRating > 0 {
		lead.Rating = leadsapi.Ptr(entry.ReviewRating)
	}

	// Set review count if available
	if entry.ReviewCount > 0 {
		lead.ReviewCount = leadsapi.Ptr(entry.ReviewCount)
	}

	// Set email if available (take the first one)
	if len(entry.Emails) > 0 {
		lead.Email = entry.Emails[0]
	}

	// Set categories as tags
	if len(entry.Categories) > 0 {
		lead.Tags = entry.Categories
	}

	// Add additional data as attributes
	var attrs []leadsapi.Attribute

	if entry.Link != "" {
		attrs = append(attrs, leadsapi.TextAttr("google_maps_link", entry.Link))
	}

	if entry.PlusCode != "" {
		attrs = append(attrs, leadsapi.TextAttr("plus_code", entry.PlusCode))
	}

	if entry.Status != "" {
		attrs = append(attrs, leadsapi.TextAttr("status", entry.Status))
	}

	if entry.PriceRange != "" {
		attrs = append(attrs, leadsapi.TextAttr("price_range", entry.PriceRange))
	}

	if entry.Timezone != "" {
		attrs = append(attrs, leadsapi.TextAttr("timezone", entry.Timezone))
	}

	// Add full address as attribute if the street address is empty but full address exists
	if entry.Address != "" && lead.Address == "" {
		attrs = append(attrs, leadsapi.TextAttr("full_address", entry.Address))
	}

	// Add borough if available
	if entry.CompleteAddress.Borough != "" {
		attrs = append(attrs, leadsapi.TextAttr("borough", entry.CompleteAddress.Borough))
	}

	// Add reviews link
	if entry.ReviewsLink != "" {
		attrs = append(attrs, leadsapi.TextAttr("reviews_link", entry.ReviewsLink))
	}

	// Add owner info if available
	if entry.Owner.Name != "" {
		attrs = append(attrs, leadsapi.TextAttr("owner_name", entry.Owner.Name))
	}

	if entry.Owner.Link != "" {
		attrs = append(attrs, leadsapi.TextAttr("owner_link", entry.Owner.Link))
	}

	// Add menu link if available
	if entry.Menu.Link != "" {
		attrs = append(attrs, leadsapi.TextAttr("menu_link", entry.Menu.Link))
	}

	// Add additional emails as attribute if more than one
	if len(entry.Emails) > 1 {
		attrs = append(attrs, leadsapi.ListAttr("additional_emails", entry.Emails[1:]))
	}

	if len(attrs) > 0 {
		lead.Attributes = attrs
	}

	return lead, nil
}
