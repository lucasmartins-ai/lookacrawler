package adaptive

import (
	"runtime"
	"sync"
	"time"
)

type Controller struct {
	mu                sync.Mutex
	current, min, max int
	last              time.Time
}

func New(minimum, maximum int) *Controller {
	if minimum < 1 {
		minimum = 1
	}
	if maximum < minimum {
		maximum = minimum
	}
	c := runtime.NumCPU() / 2
	if c < minimum {
		c = minimum
	}
	if c > maximum {
		c = maximum
	}
	return &Controller{current: c, min: minimum, max: maximum, last: time.Now()}
}
func (c *Controller) Current() int { c.mu.Lock(); defer c.mu.Unlock(); return c.current }
func (c *Controller) Observe(success bool, latency time.Duration) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.last) < time.Second {
		return c.current
	}
	c.last = time.Now()
	if !success || latency > 15*time.Second {
		if c.current > c.min {
			c.current--
		}
	} else if latency < 5*time.Second && c.current < c.max {
		c.current++
	}
	return c.current
}
