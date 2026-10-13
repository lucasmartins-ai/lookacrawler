// Package grid divides geographic bounding boxes into bounded search cells.
package grid

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const kmPerDegreeLat = 111.32
const minCosLatitude = 1e-6

var ErrTooManyCells = errors.New("grid exceeds configured cell limit")

type BoundingBox struct{ MinLat, MinLon, MaxLat, MaxLon float64 }
type Cell struct{ Lat, Lon float64 }

func (c Cell) GeoCoordinates() string { return fmt.Sprintf("%.6f,%.6f", c.Lat, normalizeLon(c.Lon)) }

func ParseBoundingBox(s string) (BoundingBox, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return BoundingBox{}, fmt.Errorf("invalid bounding box %q: expected minLat,minLon,maxLat,maxLon", s)
	}
	vals := make([]float64, 4)
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return BoundingBox{}, fmt.Errorf("invalid bounding box value %q: %w", p, err)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return BoundingBox{}, fmt.Errorf("invalid bounding box value %q: must be finite", p)
		}
		vals[i] = v
	}
	b := BoundingBox{vals[0], vals[1], vals[2], vals[3]}
	if b.MinLat >= b.MaxLat {
		return BoundingBox{}, fmt.Errorf("minLat (%f) must be less than maxLat (%f)", b.MinLat, b.MaxLat)
	}
	if b.MinLat < -90 || b.MinLat > 90 {
		return BoundingBox{}, fmt.Errorf("minLat (%f) must be between -90 and 90", b.MinLat)
	}
	if b.MaxLat < -90 || b.MaxLat > 90 {
		return BoundingBox{}, fmt.Errorf("maxLat (%f) must be between -90 and 90", b.MaxLat)
	}
	if b.MinLon < -180 || b.MinLon > 180 {
		return BoundingBox{}, fmt.Errorf("minLon (%f) must be between -180 and 180", b.MinLon)
	}
	if b.MaxLon < -180 || b.MaxLon > 180 {
		return BoundingBox{}, fmt.Errorf("maxLon (%f) must be between -180 and 180", b.MaxLon)
	}
	if b.MinLon == b.MaxLon {
		return BoundingBox{}, errors.New("longitude span cannot be zero")
	}
	return b, nil
}

func GenerateCells(b BoundingBox, cellSizeKm float64) []Cell {
	cells, _ := GenerateCellsLimited(b, cellSizeKm, 0)
	return cells
}
func GenerateCellsLimited(b BoundingBox, cellSizeKm float64, maxCells int) ([]Cell, error) {
	count := EstimateCellCount(b, cellSizeKm)
	if maxCells > 0 && count > maxCells {
		return nil, fmt.Errorf("%w: %d > %d", ErrTooManyCells, count, maxCells)
	}
	cells := make([]Cell, 0, count)
	err := ForEachCell(b, cellSizeKm, maxCells, func(c Cell) error { cells = append(cells, c); return nil })
	return cells, err
}
func ForEachCell(b BoundingBox, cellSizeKm float64, maxCells int, fn func(Cell) error) error {
	cellSizeKm = normalizeCellSizeKm(cellSizeKm)
	latStep := cellSizeKm / kmPerDegreeLat
	lonStep := calculateLonStep(b, cellSizeKm)
	latCount := int(math.Ceil((b.MaxLat - b.MinLat) / latStep))
	lonCount := int(math.Ceil(lonSpan(b) / lonStep))
	total := safeMul(latCount, lonCount)
	if maxCells > 0 && total > maxCells {
		return fmt.Errorf("%w: %d > %d", ErrTooManyCells, total, maxCells)
	}
	for yi := 0; yi < latCount; yi++ {
		lat := b.MinLat + (float64(yi)+.5)*latStep
		if lat > b.MaxLat {
			lat = (b.MinLat + b.MaxLat) / 2
		}
		for xi := 0; xi < lonCount; xi++ {
			lon := normalizeLon(b.MinLon + (float64(xi)+.5)*lonStep)
			if err := fn(Cell{Lat: lat, Lon: lon}); err != nil {
				return err
			}
		}
	}
	return nil
}
func EstimateCellCount(b BoundingBox, cellSizeKm float64) int {
	cellSizeKm = normalizeCellSizeKm(cellSizeKm)
	latStep := cellSizeKm / kmPerDegreeLat
	lonStep := calculateLonStep(b, cellSizeKm)
	latCells := int(math.Ceil((b.MaxLat - b.MinLat) / latStep))
	lonCells := int(math.Ceil(lonSpan(b) / lonStep))
	if latCells < 0 {
		latCells = 0
	}
	if lonCells < 0 {
		lonCells = 0
	}
	return safeMul(latCells, lonCells)
}
func lonSpan(b BoundingBox) float64 {
	if b.MaxLon > b.MinLon {
		return b.MaxLon - b.MinLon
	}
	return (180 - b.MinLon) + (b.MaxLon + 180)
}
func normalizeLon(lon float64) float64 {
	for lon > 180 {
		lon -= 360
	}
	for lon < -180 {
		lon += 360
	}
	return lon
}
func normalizeCellSizeKm(v float64) float64 {
	if v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
		return 1
	}
	return v
}
func calculateLonStep(b BoundingBox, cell float64) float64 {
	mid := (b.MinLat + b.MaxLat) / 2
	c := math.Cos(mid * math.Pi / 180)
	if math.Abs(c) < minCosLatitude {
		if c < 0 {
			c = -minCosLatitude
		} else {
			c = minCosLatitude
		}
	}
	step := cell / (kmPerDegreeLat * math.Abs(c))
	if step > 360 {
		step = 360
	}
	return step
}
func safeMul(a, b int) int {
	if a <= 0 || b <= 0 {
		return 0
	}
	if a > math.MaxInt/b {
		return math.MaxInt
	}
	return a * b
}
