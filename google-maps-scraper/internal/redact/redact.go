package redact

import (
	"net/url"
	"regexp"
	"strings"
)

var (
	emailRE  = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
	bearerRE = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+\-/=]+`)
)

func String(s string) string {
	s = bearerRE.ReplaceAllString(s, "Bearer [REDACTED]")
	s = emailRE.ReplaceAllString(s, "[REDACTED_EMAIL]")
	for _, marker := range []string{"api_key=", "apikey=", "token=", "password=", "secret="} {
		lower := strings.ToLower(s)
		for {
			i := strings.Index(lower, marker)
			if i < 0 {
				break
			}
			start := i + len(marker)
			end := start
			for end < len(s) && !strings.ContainsRune("& \t\r\n\"'", rune(s[end])) {
				end++
			}
			s = s[:start] + "[REDACTED]" + s[end:]
			lower = strings.ToLower(s)
		}
	}
	return s
}

func URL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return String(raw)
	}
	if u.User != nil {
		u.User = url.UserPassword("[REDACTED]", "[REDACTED]")
	}
	q := u.Query()
	for key := range q {
		lk := strings.ToLower(key)
		if strings.Contains(lk, "key") || strings.Contains(lk, "token") || strings.Contains(lk, "secret") || strings.Contains(lk, "password") {
			q.Set(key, "[REDACTED]")
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}
