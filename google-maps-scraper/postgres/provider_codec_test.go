package postgres

import (
	"encoding/json"
	"testing"

	"github.com/coelhobugado/google-maps-scraper/gmaps"
)

func TestPayloadEnvelopeRoundTripAndTamperDetection(t *testing.T) {
	job := gmaps.NewGmapJob("job-1", "pt-BR", "cafes", 5, false, "", 15)
	typ, payload, err := encodeJob(job)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeJob(typ, payload)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.GetID() != job.GetID() {
		t.Fatalf("id=%q", decoded.GetID())
	}

	var env payloadEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		t.Fatal(err)
	}
	env.Data[0] ^= 0xff
	tampered, _ := json.Marshal(env)
	if _, err := decodeJob(typ, tampered); err == nil {
		t.Fatal("expected checksum failure")
	}
}

func TestFastSearchPayloadRoundTrip(t *testing.T) {
	job := gmaps.NewSearchJob(&gmaps.MapSearchParams{Query: "padaria", Location: gmaps.MapLocation{Lat: -23.5, Lon: -46.6, ZoomLvl: 15, Radius: 1000}, Hl: "pt-BR"})
	typ, payload, err := encodeJob(job)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeJob(typ, payload)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.GetID() != job.GetID() {
		t.Fatalf("id=%q", decoded.GetID())
	}
}
