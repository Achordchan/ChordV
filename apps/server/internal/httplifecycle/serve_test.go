package httplifecycle

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestShutdownDrainsOrTimesOut(t *testing.T) {
	for _, stall := range []bool{false, true} {
		name := "complete"
		if stall {
			name = "timeout"
		}
		t.Run(name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			entered, release, stopping := make(chan struct{}), make(chan struct{}), make(chan struct{})
			defer close(release)
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				select {
				case <-release:
				case <-r.Context().Done():
					return
				case <-stopping:
					if stall {
						<-r.Context().Done()
						return
					}
					io.WriteString(w, "complete")
				}
			})}
			timeout := 3 * time.Second
			if stall {
				timeout = 100 * time.Millisecond
			}
			done := make(chan error, 1)
			go func() { done <- Serve(ctx, server, listener, timeout, func() { close(stopping) }) }()
			result := make(chan string, 1)
			go func() {
				client := http.Client{Timeout: 4 * time.Second}
				resp, err := client.Get("http://" + listener.Addr().String())
				if err != nil {
					result <- "closed"
					return
				}
				defer resp.Body.Close()
				b, _ := io.ReadAll(resp.Body)
				result <- string(b)
			}()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("handler not reached")
			}
			cancel()
			err = <-done
			body := <-result
			if stall {
				if !errors.Is(err, context.DeadlineExceeded) || body != "closed" {
					t.Fatal(err, body)
				}
			} else if err != nil || body != "complete" {
				t.Fatal(err, body)
			}
		})
	}
}
