package web

import (
	"context"
	"encoding/json"
	"testing"
)

func TestGeoTypeLabelInPortuguese(t *testing.T) {
	cases := map[string]string{
		"city":          "Cidade",
		"neighbourhood": "Bairro ou distrito",
		"state":         "Estado ou região",
		"country":       "País",
		"unknown":       "Local",
	}
	for value, want := range cases {
		if got := geoTypeLabel(value); got != want {
			t.Fatalf("geoTypeLabel(%q)=%q want %q", value, got, want)
		}
	}
}

func TestOpenMeteoTypeLabelInPortuguese(t *testing.T) {
	if got := openMeteoTypeLabel("PPLA2"); got != "Cidade ou localidade" {
		t.Fatalf("openMeteoTypeLabel(PPLA2)=%q", got)
	}
	if got := openMeteoTypeLabel("ADM2"); got != "Região ou distrito" {
		t.Fatalf("openMeteoTypeLabel(ADM2)=%q", got)
	}
}

func TestGeocodingProviderFieldsDecode(t *testing.T) {
	var photon photonResponse
	if err := json.Unmarshal([]byte(`{"features":[{"properties":{"countrycode":"BR","osm_value":"municipality","type":"city"}}]}`), &photon); err != nil {
		t.Fatal(err)
	}
	if photon.Features[0].Properties.Countrycode != "BR" || photon.Features[0].Properties.OsmValue != "municipality" || photon.Features[0].Properties.Type != "city" {
		t.Fatalf("photon fields were not decoded: %+v", photon.Features[0].Properties)
	}
	var meteo openMeteoResponse
	if err := json.Unmarshal([]byte(`{"results":[{"country_code":"BR","feature_code":"PPLA2"}]}`), &meteo); err != nil {
		t.Fatal(err)
	}
	if meteo.Results[0].CountryCode != "BR" || meteo.Results[0].FeatureCode != "PPLA2" {
		t.Fatalf("Open-Meteo fields were not decoded: %+v", meteo.Results[0])
	}
}

func TestPhotonQueryUsesSupportedNativeLanguage(t *testing.T) {
	params := photonQueryParams("Uberlândia MG", false)
	if params.Has("lang") {
		t.Fatalf("public Photon rejects lang=%q; native language must be used", params.Get("lang"))
	}
	if params.Get("q") != "Uberlândia MG" || len(params["layer"]) == 0 {
		t.Fatalf("unexpected Photon parameters: %v", params)
	}
}

func TestOpenMeteoQueryCandidatesRemoveBrazilianStateSuffix(t *testing.T) {
	got := openMeteoQueryCandidates("Uberlândia MG")
	if len(got) != 2 || got[0] != "Uberlândia MG" || got[1] != "Uberlândia" {
		t.Fatalf("unexpected candidates: %v", got)
	}
	got = openMeteoQueryCandidates("Campinas, São Paulo")
	if len(got) != 2 || got[1] != "Campinas" {
		t.Fatalf("unexpected comma candidates: %v", got)
	}
}

func TestGeocodingGetRejectsUnknownHostsBeforeNetwork(t *testing.T) {
	if _, _, err := geocodingGet(context.Background(), "https://example.com/api"); err == nil {
		t.Fatal("unknown geocoding host must be rejected")
	}
}
