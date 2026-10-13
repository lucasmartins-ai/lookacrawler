package retry

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"
)

type Config struct {
	Attempts            int
	BaseDelay, MaxDelay time.Duration
}

func Do(ctx context.Context, cfg Config, retryable func(error) bool, fn func(context.Context) error) error {
	if cfg.Attempts < 1 {
		cfg.Attempts = 1
	}
	if cfg.BaseDelay <= 0 {
		cfg.BaseDelay = 200 * time.Millisecond
	}
	if cfg.MaxDelay <= 0 {
		cfg.MaxDelay = 5 * time.Second
	}
	var err error
	for attempt := 0; attempt < cfg.Attempts; attempt++ {
		if err = fn(ctx); err == nil {
			return nil
		}
		if !retryable(err) || attempt == cfg.Attempts-1 {
			return err
		}
		delay := cfg.BaseDelay << attempt
		if delay > cfg.MaxDelay {
			delay = cfg.MaxDelay
		}
		delay += time.Duration(rand.Int64N(max(1, int64(delay/4))))
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return errors.Join(err, ctx.Err())
		case <-t.C:
		}
	}
	return err
}
