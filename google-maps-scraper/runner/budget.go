package runner

import "fmt"

type RequestBudget struct {
	MaxGridCells int
	MaxSeedJobs  int
}

func (b *RequestBudget) CheckGridCells(count int) error {
	if b.MaxGridCells > 0 && count > b.MaxGridCells {
		return fmt.Errorf("grid cells limit exceeded: %d > %d", count, b.MaxGridCells)
	}
	return nil
}

func (b *RequestBudget) CheckSeedJobs(count int) error {
	if b.MaxSeedJobs > 0 && count > b.MaxSeedJobs {
		return fmt.Errorf("seed jobs limit exceeded: %d > %d", count, b.MaxSeedJobs)
	}
	return nil
}
