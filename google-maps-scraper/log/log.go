package log

import (
	"context"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"time"
)

var (
	logger *slog.Logger

	emailRegex  = regexp.MustCompile(`(?i)[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}`)
	awsKeyRegex = regexp.MustCompile(`(?i)(AKIA|A3T|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}`)
	dsnRegex    = regexp.MustCompile(`(?i)(postgres|http|https|socks5)://([^:]+):([^@]+)@`)
)

func redactor(_ []string, a slog.Attr) slog.Attr {
	if a.Key == slog.TimeKey {
		if t, ok := a.Value.Any().(time.Time); ok {
			return slog.Time(slog.TimeKey, t.UTC())
		}
	}

	lowerKey := strings.ToLower(a.Key)
	if strings.Contains(lowerKey, "password") ||
		strings.Contains(lowerKey, "email") ||
		strings.Contains(lowerKey, "aws") ||
		strings.Contains(lowerKey, "proxy") {
		return slog.String(a.Key, "[REDACTED]")
	}

	if a.Value.Kind() == slog.KindString {
		val := a.Value.String()
		if emailRegex.MatchString(val) {
			val = emailRegex.ReplaceAllString(val, "[REDACTED_EMAIL]")
		}
		if awsKeyRegex.MatchString(val) {
			val = awsKeyRegex.ReplaceAllString(val, "[REDACTED_AWS_KEY]")
		}
		if dsnRegex.MatchString(val) {
			val = dsnRegex.ReplaceAllString(val, "$1://$2:[REDACTED_PASSWORD]@")
		}
		if val != a.Value.String() {
			a.Value = slog.StringValue(val)
		}
	}

	return a
}

func init() {
	logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level:       slog.LevelInfo,
		ReplaceAttr: redactor,
	}))
}

func Init(level slog.Level) {
	logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level:       level,
		ReplaceAttr: redactor,
	}))
}

type BaseFields struct {
	RequestID  string
	JobID      string
	Phase      string
	DurationMs int64
	Attempt    int
	ErrorCode  string
}

func WithBaseFields(fields BaseFields) *slog.Logger {
	var args []any
	if fields.RequestID != "" {
		args = append(args, "request_id", fields.RequestID)
	}
	if fields.JobID != "" {
		args = append(args, "job_id", fields.JobID)
	}
	if fields.Phase != "" {
		args = append(args, "phase", fields.Phase)
	}
	if fields.DurationMs != 0 {
		args = append(args, "duration_ms", fields.DurationMs)
	}
	if fields.Attempt != 0 {
		args = append(args, "attempt", fields.Attempt)
	}
	if fields.ErrorCode != "" {
		args = append(args, "error_code", fields.ErrorCode)
	}
	return logger.With(args...)
}

func Debug(msg string, args ...any) {
	logger.Debug(msg, args...)
}

func Info(msg string, args ...any) {
	logger.Info(msg, args...)
}

func Warn(msg string, args ...any) {
	logger.Warn(msg, args...)
}

func Error(msg string, args ...any) {
	logger.Error(msg, args...)
}

func DebugContext(ctx context.Context, msg string, args ...any) {
	logger.DebugContext(ctx, msg, args...)
}

func InfoContext(ctx context.Context, msg string, args ...any) {
	logger.InfoContext(ctx, msg, args...)
}

func ErrorContext(ctx context.Context, msg string, args ...any) {
	logger.ErrorContext(ctx, msg, args...)
}

func With(args ...any) *slog.Logger {
	return logger.With(args...)
}
