package deduper

import (
	"context"
	"sync"
	"testing"
)

func TestConcurrentDeduper(t *testing.T) {
	d := NewWithLimit(1024)
	var wg sync.WaitGroup
	var successes int
	var mu sync.Mutex
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if d.AddIfNotExists(context.Background(), "same") {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if successes != 1 {
		t.Fatalf("successes=%d", successes)
	}
}
