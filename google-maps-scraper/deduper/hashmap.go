package deduper

import (
	"context"
	"crypto/sha256"
	"sync"
	"sync/atomic"
)

const shardCount = 64

type shard struct {
	sync.RWMutex
	seen map[[16]byte]struct{}
}
type hashmap struct {
	shards     [shardCount]shard
	maxEntries int
	size       atomic.Int64
}

func (d *hashmap) AddIfNotExists(_ context.Context, key string) bool {
	sum := sha256.Sum256([]byte(key))
	var short [16]byte
	copy(short[:], sum[:16])
	s := &d.shards[int(sum[0])%shardCount]
	s.RLock()
	_, ok := s.seen[short]
	s.RUnlock()
	if ok {
		return false
	}
	s.Lock()
	defer s.Unlock()
	if _, ok = s.seen[short]; ok {
		return false
	}
	if int(d.size.Load()) >= d.maxEntries {
		target := max(16, d.maxEntries/shardCount/4)
		removed := 0
		for k := range s.seen {
			delete(s.seen, k)
			removed++
			if removed >= target {
				break
			}
		}
		d.size.Add(int64(-removed))
	}
	s.seen[short] = struct{}{}
	d.size.Add(1)
	return true
}
