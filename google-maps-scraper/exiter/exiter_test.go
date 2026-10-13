package exiter

import "testing"

func TestSnapshotReportsLiveProgress(t *testing.T) {
	monitor := New()
	monitor.SetSeedCount(2)
	monitor.IncrSeedCompleted(1)
	monitor.IncrPlacesFound(4)
	monitor.IncrPlacesCompleted(2)
	seedTotal, seedDone, placesFound, placesDone := monitor.Snapshot()
	if seedTotal != 2 || seedDone != 1 || placesFound != 4 || placesDone != 2 {
		t.Fatalf("snapshot=%d,%d,%d,%d", seedTotal, seedDone, placesFound, placesDone)
	}
}
