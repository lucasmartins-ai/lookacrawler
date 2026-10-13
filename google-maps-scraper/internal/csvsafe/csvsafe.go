package csvsafe

import "strings"

func Cell(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed == "" {
		return value
	}
	switch trimmed[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + value
	default:
		return value
	}
}

func Record(values []string) []string {
	out := make([]string, len(values))
	for i, value := range values {
		out[i] = Cell(value)
	}
	return out
}
