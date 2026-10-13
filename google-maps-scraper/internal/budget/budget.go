package budget

import (
	"errors"
	"fmt"
	"sync/atomic"
)

var ErrExceeded = errors.New("resource budget exceeded")

type Budget struct {
	maxRequests, maxBytes, maxEnrich int64
	requests, bytes, enrich          atomic.Int64
}

func New(maxRequests, maxBytes, maxEnrich int64) *Budget {
	return &Budget{maxRequests: maxRequests, maxBytes: maxBytes, maxEnrich: maxEnrich}
}
func (b *Budget) TakeRequest() error      { return take(&b.requests, b.maxRequests, 1, "requests") }
func (b *Budget) TakeBytes(n int64) error { return take(&b.bytes, b.maxBytes, n, "bytes") }
func (b *Budget) TakeEnrichment() error   { return take(&b.enrich, b.maxEnrich, 1, "enrichments") }
func take(counter *atomic.Int64, maxValue, n int64, label string) error {
	if maxValue <= 0 {
		counter.Add(n)
		return nil
	}
	v := counter.Add(n)
	if v > maxValue {
		counter.Add(-n)
		return fmt.Errorf("%w: %s limit %d", ErrExceeded, label, maxValue)
	}
	return nil
}
