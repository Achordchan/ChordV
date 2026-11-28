package main

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync"
	"time"
)

func probeNodes(ctx context.Context, nodes []nodeSummary) ([]map[string]any, error) {
	if len(nodes) > 32 {
		return nil, errors.New("每次最多检测 32 个节点")
	}
	results := make([]map[string]any, len(nodes))
	sem := make(chan struct{}, 12)
	var wg sync.WaitGroup
	for i, node := range nodes {
		wg.Add(1)
		go func(i int, node nodeSummary) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			result := map[string]any{"nodeId": node.ID, "status": "offline", "latencyMs": nil, "checkedAt": time.Now().UTC().Format(time.RFC3339), "error": nil}
			if node.ServerHost == "" || node.ServerPort < 1 || node.ServerPort > 65535 {
				result["status"] = "unknown"
				result["error"] = "该节点暂不支持本机测速"
				results[i] = result
				return
			}
			started := time.Now()
			conn, err := (&net.Dialer{Timeout: 4 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(node.ServerHost, strconv.Itoa(node.ServerPort)))
			if err != nil {
				result["error"] = "本机无法连接该节点"
			} else {
				conn.Close()
				result["status"] = "healthy"
				result["latencyMs"] = max(int64(1), time.Since(started).Milliseconds())
			}
			results[i] = result
		}(i, node)
	}
	wg.Wait()
	return results, ctx.Err()
}
