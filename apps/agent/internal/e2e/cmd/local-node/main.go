//go:build e2e

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

type request struct {
	ID      int             `json:"id"`
	Action  string          `json:"action"`
	Runtime json.RawMessage `json:"runtime"`
	Bytes   int             `json:"bytes"`
}

func main() {
	node, err := startNode()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer node.close()
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(map[string]any{"event": "ready", "node": node.public}); err != nil {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			encoder.Encode(map[string]any{"error": "invalid JSON request"})
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		var data any
		var err error
		switch req.Action {
		case "snapshot":
			users, usersErr := node.api.ListUsers(ctx)
			counters, statsErr := node.api.ReadAbsoluteCounters(ctx)
			data = map[string]any{"users": users, "counters": counters}
			if usersErr != nil {
				err = usersErr
			} else {
				err = statsErr
			}
		case "transfer":
			data, err = node.transfer(ctx, req.Runtime, req.Bytes)
		case "stop":
			cancel()
			encoder.Encode(map[string]any{"id": req.ID, "data": "stopped"})
			return
		default:
			err = fmt.Errorf("unknown action")
		}
		cancel()
		answer := map[string]any{"id": req.ID, "data": data}
		if err != nil {
			answer["error"] = err.Error()
		}
		if encoder.Encode(answer) != nil {
			return
		}
	}
}
