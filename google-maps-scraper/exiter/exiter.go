package exiter

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Exiter interface {
	SetSeedCount(int)
	SetCancelFunc(context.CancelFunc)
	IncrSeedCompleted(int)
	IncrPlacesFound(int)
	IncrPlacesCompleted(int)
	Snapshot() (seedCount, seedCompleted, placesFound, placesCompleted int)
	Run(context.Context)
}

type exiter struct {
	seedCount       int
	seedCompleted   int
	placesFound     int
	placesCompleted int

	mu         *sync.Mutex
	cancelFunc context.CancelFunc
	doneCh     chan struct{}
}

func New() Exiter {
	return &exiter{
		mu:     &sync.Mutex{},
		doneCh: make(chan struct{}, 1),
	}
}

func (e *exiter) SetSeedCount(val int) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.seedCount = val
}

func (e *exiter) SetCancelFunc(fn context.CancelFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.cancelFunc = fn
}

func (e *exiter) IncrSeedCompleted(val int) {
	e.mu.Lock()
	e.seedCompleted += val
	done := e.seedCompleted >= e.seedCount && e.placesCompleted >= e.placesFound
	e.mu.Unlock()

	if done {
		select {
		case e.doneCh <- struct{}{}:
		default:
		}
	}
}

func (e *exiter) IncrPlacesFound(val int) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.placesFound += val
}

func (e *exiter) IncrPlacesCompleted(val int) {
	e.mu.Lock()
	e.placesCompleted += val
	done := e.seedCompleted >= e.seedCount && e.placesCompleted >= e.placesFound
	e.mu.Unlock()

	if done {
		select {
		case e.doneCh <- struct{}{}:
		default:
		}
	}
}

func (e *exiter) Snapshot() (seedCount, seedCompleted, placesFound, placesCompleted int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.seedCount, e.seedCompleted, e.placesFound, e.placesCompleted
}

func (e *exiter) Run(ctx context.Context) {
	// Completion is `seedCompleted >= seedCount && placesCompleted >=
	// placesFound`, but a job that FAILS never calls IncrPlacesCompleted, and
	// nothing upstream reports failures (the runner never passes
	// scrapemate.WithFailed(), so scrapemate's failed-jobs channel is nil).
	// placesFound therefore stays permanently above placesCompleted and the
	// process writes its whole payload and then lives forever — measured, and
	// the reason the adapter had to SIGKILL a browser on every call.
	//
	// Fix: fall back to inactivity. Once nothing has completed for a while, no
	// further work is arriving, so anything still outstanding has failed or
	// stalled and there is nothing left to wait for.
	//
	// Measured: with 13-14 places this exits in ~6s. With 19 places it hung past
	// 300s, because `seedCompleted` stops advancing once the search page is
	// fully parsed while the place jobs are still trickling — so the old
	// seed-only check never stabilised. Counting placesCompleted too is what
	// makes the 19-place case terminate.
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		lastSeed, lastPlaces := -1, -1
		stableTicks := 0

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				e.mu.Lock()
				seedCompleted := e.seedCompleted
				placesCompleted := e.placesCompleted
				cancelFunc := e.cancelFunc
				e.mu.Unlock()

				// Still making progress: keep waiting.
				if seedCompleted != lastSeed || placesCompleted != lastPlaces {
					lastSeed, lastPlaces = seedCompleted, placesCompleted
					stableTicks = 0
					continue
				}

				// Nothing has completed for ~9s and at least one job finished
				// earlier: whatever is outstanding has failed or stalled. Stop.
				stableTicks++
				if stableTicks >= 3 && (seedCompleted > 0 || placesCompleted > 0) {
					if cancelFunc != nil {
						cancelFunc()
					}
					return
				}
			}
		}
	}()

	// The scraper exits, but the playwright-go driver it started does NOT: that
	// node process outlives its parent and holds the Chromium open forever
	// (measured: `maps-leads` gone in 8s, driver + 2 chrome-headless-shell still
	// alive 12s later). Every run leaked a browser, which is what forced the
	// adapter to carry process-killing surgery.
	//
	// Fix: after Run returns, kill any process this exiter's children started.
	// Only the driver is targeted (matched by its playwright-go path), never an
	// unrelated browser the user opened.
	go func() {
		<-ctx.Done()
		// Give the driver a moment to be fully up before looking for it.
		time.Sleep(500 * time.Millisecond)
		out, err := exec.Command("ps", "-Aeo", "pid=,ppid=,command=").Output()
		if err != nil {
			return
		}
		self := os.Getpid()
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(strings.TrimSpace(line))
			if len(fields) < 3 {
				continue
			}
			pid, err := strconv.Atoi(fields[0])
			if err != nil || pid == self {
				continue
			}
			// Only our own driver: a concurrent maps-leads run has its own.
			if ppid, err := strconv.Atoi(fields[1]); err != nil || ppid != self {
				continue
			}
			cmd := strings.Join(fields[2:], " ")
			if strings.Contains(cmd, "ms-playwright-go") {
				if p, err := os.FindProcess(pid); err == nil {
					_ = p.Kill()
				}
			}
		}
	}()

	select {
	case <-ctx.Done():
	case <-e.doneCh:
		if e.cancelFunc != nil {
			e.cancelFunc()
		}
	}
}
