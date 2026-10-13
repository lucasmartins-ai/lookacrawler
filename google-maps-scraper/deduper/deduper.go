package deduper

import "context"

type Deduper interface {
	AddIfNotExists(context.Context, string) bool
}

func New() Deduper { return NewWithLimit(2_000_000) }
func NewWithLimit(maxEntries int) Deduper {
	if maxEntries < 1024 {
		maxEntries = 1024
	}
	d := &hashmap{maxEntries: maxEntries}
	for i := range d.shards {
		d.shards[i].seen = make(map[[16]byte]struct{})
	}
	return d
}
