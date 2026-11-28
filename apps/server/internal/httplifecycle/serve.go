// Package httplifecycle coordinates HTTP draining before the caller releases service resources.
package httplifecycle

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"
)

func Serve(ctx context.Context, server *http.Server, listener net.Listener, timeout time.Duration, stopStreams func()) error {
	server.RegisterOnShutdown(stopStreams)
	serving := make(chan error, 1)
	go func() { serving <- server.Serve(listener) }()
	select {
	case err := <-serving:
		return err
	case <-ctx.Done():
		drain, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		err := server.Shutdown(drain)
		if err != nil {
			err = errors.Join(err, server.Close())
		}
		if serveErr := <-serving; !errors.Is(serveErr, http.ErrServerClosed) {
			err = errors.Join(err, serveErr)
		}
		return err
	}
}
