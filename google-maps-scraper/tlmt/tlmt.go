package tlmt

import "context"

type Event struct {
	Name       string
	Properties map[string]any
}

func NewEvent(name string, props map[string]any) Event {
	safe := map[string]any{}
	for k, v := range props {
		switch k {
		case "duration_ms", "job_count", "success", "mode", "version":
			safe[k] = v
		}
	}
	return Event{Name: name, Properties: safe}
}

type Telemetry interface {
	Send(context.Context, Event) error
	Close() error
}
