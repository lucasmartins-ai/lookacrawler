// Command example_writer demonstrates the standalone JSONL writer protocol.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "writer error:", err)
		os.Exit(1)
	}
}

func run() error {
	output := os.Getenv("GMAPS_WRITER_OUTPUT")
	if output == "" {
		output = "results.jsonl"
	}
	f, err := os.OpenFile(output, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("open output: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	w := bufio.NewWriter(f)
	for scanner.Scan() {
		var value map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &value); err != nil {
			return fmt.Errorf("decode JSONL record: %w", err)
		}
		line, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("encode JSONL record: %w", err)
		}
		if _, err := w.Write(append(line, '\n')); err != nil {
			return fmt.Errorf("write output: %w", err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	if err := w.Flush(); err != nil {
		return fmt.Errorf("flush output: %w", err)
	}
	if err := f.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return fmt.Errorf("sync output: %w", err)
	}
	return nil
}
