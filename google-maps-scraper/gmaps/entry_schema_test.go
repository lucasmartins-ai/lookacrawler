package gmaps

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestEntryFromJSONMinimalSchema(t *testing.T) {
	place := make([]any, 20)
	place[11] = "Example Place"
	place[9] = []any{nil, nil, 1.25, 2.5}
	root := make([]any, 7)
	root[6] = place
	raw, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := EntryFromJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Title != "Example Place" || entry.Latitude != 1.25 || entry.Longitude != 2.5 {
		t.Fatalf("unexpected entry: %+v", entry)
	}
}

func TestEntryFromJSONReturnsTypedSchemaDrift(t *testing.T) {
	_, err := EntryFromJSON([]byte(`[]`))
	var drift *SchemaDriftError
	if !errors.As(err, &drift) {
		t.Fatalf("expected SchemaDriftError, got %T: %v", err, err)
	}
}
