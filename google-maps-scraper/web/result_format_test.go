package web

import (
	"bytes"
	"encoding/csv"
	"strings"
	"testing"
)

func TestFriendlyCSVFormatsBusinessDataForBrazilianExcel(t *testing.T) {
	header := []string{"title", "category", "categories", "address", "open_hours", "website", "review_rating", "review_count", "owner", "emails", "complete_address", "link", "latitude", "longitude"}
	row := []string{
		"Clínica Exemplo",
		"",
		"Clínica odontológica, Dentista",
		"Av. Brasil, 100",
		`{"segunda-feira":["08:00–18:00"],"terça-feira":["08:00–18:00"]}`,
		"https://instagram.com/clinica.exemplo/",
		"4.8",
		"120",
		`{"id":"","name":"","link":""}`,
		"contato@example.com, comercial@example.com",
		`{"borough":"Centro","city":"Uberlândia","postal_code":"38400-000","state":"Minas Gerais","country":"Brasil"}`,
		"https://maps.google.com/example",
		"-18.9186",
		"-48.2772",
	}

	var out bytes.Buffer
	if err := writeFriendlyCSV(&out, header, [][]string{row}); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(out.Bytes(), []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatal("CSV must include UTF-8 BOM")
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(out.String(), "\xEF\xBB\xBF")))
	reader.Comma = ';'
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf("records=%d want 2", len(records))
	}
	index := map[string]int{}
	for i, name := range records[0] {
		index[name] = i
	}
	got := records[1]
	if got[index["Categoria principal"]] != "Clínica odontológica" {
		t.Fatalf("category=%q", got[index["Categoria principal"]])
	}
	if got[index["Site"]] != "" || !strings.Contains(got[index["Instagram"]], "instagram.com") {
		t.Fatalf("site=%q instagram=%q", got[index["Site"]], got[index["Instagram"]])
	}
	if got[index["Responsável"]] != "" {
		t.Fatalf("empty owner object leaked: %q", got[index["Responsável"]])
	}
	if got[index["Avaliação"]] != "4,8" || !strings.Contains(got[index["Horário de funcionamento"]], "Segunda-feira: 08:00–18:00") {
		t.Fatalf("rating=%q hours=%q", got[index["Avaliação"]], got[index["Horário de funcionamento"]])
	}
}

func TestInstagramFilterDoesNotCountAsWebsite(t *testing.T) {
	header := []string{"title", "website", "instagram"}
	row := []string{"Loja", "https://instagram.com/loja", ""}
	idx := headerIndex(header)
	yes, no := true, false
	if !matchRow(row, idx, ResultFilter{HasInstagram: &yes, HasWebsite: &no}) {
		t.Fatal("Instagram should match its own filter and not the website filter")
	}
	if matchRow(row, idx, ResultFilter{HasWebsite: &yes}) {
		t.Fatal("Instagram must not count as website")
	}
}

func TestStreamFriendlyCSVConvertsDirectDownload(t *testing.T) {
	input := "title,category,categories,address,website,instagram\r\n" +
		`"=Empresa","","Padaria, Cafeteria","Rua A, 10","instagram.com/padaria",""` + "\r\n"
	var out bytes.Buffer
	if err := streamFriendlyCSV(&out, strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(out.String(), "\xEF\xBB\xBF")))
	reader.Comma = ';'
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || records[1][0] != "'=Empresa" {
		t.Fatalf("direct download was not converted safely: %v", records)
	}
	index := map[string]int{}
	for i, value := range records[0] {
		index[value] = i
	}
	if records[1][index["Site"]] != "" || !strings.Contains(records[1][index["Instagram"]], "instagram.com") {
		t.Fatalf("Instagram separation failed in direct download: %v", records[1])
	}
}
