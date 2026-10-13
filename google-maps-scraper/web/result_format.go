package web

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/coelhobugado/google-maps-scraper/internal/csvsafe"
)

type resultRecord struct {
	row []string
	idx map[string]int
}

func newResultRecord(header, row []string) resultRecord {
	idx := make(map[string]int, len(header))
	for i, name := range header {
		idx[strings.ToLower(strings.TrimSpace(name))] = i
	}
	return resultRecord{row: row, idx: idx}
}

func (r resultRecord) get(names ...string) string {
	for _, name := range names {
		if i, ok := r.idx[strings.ToLower(name)]; ok && i < len(r.row) {
			if value := strings.TrimSpace(r.row[i]); value != "" {
				return value
			}
		}
	}
	return ""
}

func parseList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "[]" || raw == "{}" {
		return nil
	}
	var values []string
	if strings.HasPrefix(raw, "[") && json.Unmarshal([]byte(raw), &values) == nil {
		return cleanList(values)
	}
	return cleanList(strings.Split(raw, ","))
}

func cleanList(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !slices.Contains(result, value) {
			result = append(result, value)
		}
	}
	return result
}

func (r resultRecord) categories() []string {
	values := parseList(r.get("categories"))
	if category := strings.TrimSpace(r.get("category")); category != "" && !slices.Contains(values, category) {
		values = append([]string{category}, values...)
	}
	return values
}

func (r resultRecord) category() string {
	if values := r.categories(); len(values) > 0 {
		return values[0]
	}
	return ""
}

func normalizedURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return u.String()
}

func socialDomain(raw string) string {
	u, err := url.Parse(normalizedURL(raw))
	if err != nil {
		return ""
	}
	host := strings.ToLower(strings.TrimPrefix(u.Hostname(), "www."))
	for _, domain := range []string{"instagram.com", "facebook.com", "fb.com", "tiktok.com", "twitter.com", "x.com", "linkedin.com", "wa.me", "whatsapp.com", "linktr.ee"} {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return domain
		}
	}
	return ""
}

func (r resultRecord) contacts() (website, instagram string) {
	instagram = normalizedURL(r.get("instagram"))
	website = normalizedURL(r.get("website", "web_site"))
	if socialDomain(instagram) != "instagram.com" {
		instagram = ""
	}
	if domain := socialDomain(website); domain != "" {
		if domain == "instagram.com" && instagram == "" {
			instagram = website
		}
		website = ""
	}
	return website, instagram
}

type completeAddress struct {
	Borough    string `json:"borough"`
	Street     string `json:"street"`
	City       string `json:"city"`
	PostalCode string `json:"postal_code"`
	State      string `json:"state"`
	Country    string `json:"country"`
}

func (r resultRecord) addressDetails() completeAddress {
	var address completeAddress
	_ = json.Unmarshal([]byte(r.get("complete_address")), &address)
	return address
}

func ownerName(raw string) string {
	var owner struct {
		Name string `json:"name"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(raw)), &owner) != nil {
		return ""
	}
	return strings.TrimSpace(owner.Name)
}

var emailPattern = regexp.MustCompile(`(?i)[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}`)

func formatEmails(raw string) string {
	return strings.Join(cleanList(emailPattern.FindAllString(raw, -1)), " | ")
}

func formatHours(raw string) string {
	var hours map[string][]string
	if json.Unmarshal([]byte(strings.TrimSpace(raw)), &hours) != nil || len(hours) == 0 {
		return ""
	}
	order := []string{"monday", "segunda-feira", "tuesday", "terça-feira", "wednesday", "quarta-feira", "thursday", "quinta-feira", "friday", "sexta-feira", "saturday", "sábado", "sunday", "domingo"}
	labels := map[string]string{
		"monday": "Segunda-feira", "segunda-feira": "Segunda-feira",
		"tuesday": "Terça-feira", "terça-feira": "Terça-feira",
		"wednesday": "Quarta-feira", "quarta-feira": "Quarta-feira",
		"thursday": "Quinta-feira", "quinta-feira": "Quinta-feira",
		"friday": "Sexta-feira", "sexta-feira": "Sexta-feira",
		"saturday": "Sábado", "sábado": "Sábado",
		"sunday": "Domingo", "domingo": "Domingo",
	}
	normalized := map[string][]string{}
	for day, values := range hours {
		normalized[strings.ToLower(strings.TrimSpace(day))] = cleanList(values)
	}
	parts := []string{}
	seen := map[string]bool{}
	for _, day := range order {
		label := labels[day]
		if seen[label] || len(normalized[day]) == 0 {
			continue
		}
		seen[label] = true
		parts = append(parts, label+": "+strings.Join(normalized[day], " / "))
	}
	return strings.Join(parts, " | ")
}

func localizedDecimal(raw string) string {
	return strings.ReplaceAll(strings.TrimSpace(raw), ".", ",")
}

var friendlyCSVHeader = []string{
	"Nome",
	"Categoria principal",
	"Outras categorias",
	"Endereço",
	"Bairro",
	"Cidade",
	"Estado",
	"CEP",
	"País",
	"Telefone",
	"Site",
	"Instagram",
	"E-mails",
	"Avaliação",
	"Quantidade de avaliações",
	"Horário de funcionamento",
	"Descrição",
	"Faixa de preço",
	"Responsável",
	"Google Maps",
	"Latitude",
	"Longitude",
}

func friendlyCSVRow(header, row []string) []string {
	record := newResultRecord(header, row)
	categories := record.categories()
	category, otherCategories := "", ""
	if len(categories) > 0 {
		category = categories[0]
		otherCategories = strings.Join(categories[1:], " | ")
	}
	website, instagram := record.contacts()
	address := record.addressDetails()
	visibleAddress := record.get("address")
	if visibleAddress == "" {
		visibleAddress = strings.Join(cleanList([]string{address.Street, address.Borough, address.City, address.State, address.PostalCode, address.Country}), ", ")
	}
	return []string{
		record.get("title", "name"),
		category,
		otherCategories,
		visibleAddress,
		address.Borough,
		address.City,
		address.State,
		address.PostalCode,
		address.Country,
		record.get("phone", "phone_number"),
		website,
		instagram,
		formatEmails(record.get("emails", "email")),
		localizedDecimal(record.get("review_rating", "rating")),
		record.get("review_count"),
		formatHours(record.get("open_hours")),
		record.get("descriptions", "description"),
		record.get("price_range"),
		ownerName(record.get("owner")),
		record.get("link"),
		localizedDecimal(record.get("latitude")),
		localizedDecimal(record.get("longitude")),
	}
}

func writeFriendlyCSV(out io.Writer, header []string, rows [][]string) error {
	writer, err := newFriendlyCSVWriter(out)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := writer.Write(csvsafe.Record(friendlyCSVRow(header, row))); err != nil {
			return err
		}
	}
	writer.Flush()
	return writer.Error()
}

func newFriendlyCSVWriter(out io.Writer) (*csv.Writer, error) {
	if _, err := io.WriteString(out, "\xEF\xBB\xBF"); err != nil {
		return nil, err
	}
	writer := csv.NewWriter(out)
	writer.Comma = ';'
	writer.UseCRLF = true
	if err := writer.Write(csvsafe.Record(friendlyCSVHeader)); err != nil {
		return nil, err
	}
	return writer, nil
}

func streamFriendlyCSV(out io.Writer, in io.Reader) error {
	reader := csv.NewReader(in)
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return err
	}
	writer, err := newFriendlyCSVWriter(out)
	if err != nil {
		return err
	}
	for {
		row, readErr := reader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
		if err := writer.Write(csvsafe.Record(friendlyCSVRow(header, row))); err != nil {
			return err
		}
	}
	writer.Flush()
	return writer.Error()
}
