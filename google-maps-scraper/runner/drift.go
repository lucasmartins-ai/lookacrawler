package runner

import (
	"context"
	"log/slog"

	"github.com/coelhobugado/google-maps-scraper/gmaps"
	"github.com/gosom/scrapemate"
)

type DriftDetectorWriter struct{ next scrapemate.ResultWriter }

func NewDriftDetectorWriter(next scrapemate.ResultWriter) scrapemate.ResultWriter {
	return &DriftDetectorWriter{next: next}
}
func (d *DriftDetectorWriter) Run(ctx context.Context, in <-chan scrapemate.Result) error {
	intercepted := make(chan scrapemate.Result)
	go func() {
		defer close(intercepted)
		total, noPhone, noWebsite := 0, 0, 0
		for {
			select {
			case <-ctx.Done():
				return
			case res, ok := <-in:
				if !ok {
					return
				}
				if entry, ok := res.Data.(*gmaps.Entry); ok {
					total++
					if entry.Phone == "" {
						noPhone++
					}
					if entry.WebSite == "" {
						noWebsite++
					}
					if total >= 50 {
						phoneMissing := float64(noPhone) / float64(total)
						websiteMissing := float64(noWebsite) / float64(total)
						if phoneMissing > .95 || websiteMissing > .95 {
							slog.Warn("parser quality threshold exceeded", "sample_size", total, "phone_missing_ratio", phoneMissing, "website_missing_ratio", websiteMissing)
						}
						total, noPhone, noWebsite = 0, 0, 0
					}
				}
				select {
				case <-ctx.Done():
					return
				case intercepted <- res:
				}
			}
		}
	}()
	return d.next.Run(ctx, intercepted)
}
