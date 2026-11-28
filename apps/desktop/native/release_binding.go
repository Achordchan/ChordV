package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	releaseprotocol "github.com/Achordchan/ChordV/packages/releaseprotocol"
)

type bindingFlight struct {
	done chan struct{}
	err  error
}
type releaseBindingCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
	pending map[string]*bindingFlight
}

func (c *releaseBindingCache) check(ctx context.Context, key string, verify func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[string]time.Time{}
		c.pending = map[string]*bindingFlight{}
	}
	if at, ok := c.entries[key]; ok && time.Since(at) < 30*time.Second {
		c.mu.Unlock()
		return nil
	}
	if flight := c.pending[key]; flight != nil {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-flight.done:
			return flight.err
		}
	}
	if len(c.pending) >= 8 {
		c.mu.Unlock()
		return errors.New("发布绑定验证并发过多")
	}
	flight := &bindingFlight{done: make(chan struct{})}
	c.pending[key] = flight
	c.mu.Unlock()
	err := verify()
	c.mu.Lock()
	defer c.mu.Unlock()
	flight.err = err
	if err == nil {
		if len(c.entries) >= 8 {
			var oldest string
			var at time.Time
			for candidate, stamp := range c.entries {
				if oldest == "" || stamp.Before(at) {
					oldest, at = candidate, stamp
				}
			}
			delete(c.entries, oldest)
		}
		c.entries[key] = time.Now()
	}
	delete(c.pending, key)
	close(flight.done)
	return err
}
func (s *DesktopService) verifyReleaseBinding(ctx context.Context, m releaseManifest, body, signature string) error {
	projected, err := releaseprotocol.Validate(m.SchemaVersion, m.TagBinding, m.SourceCommit, s.cfg.ReleaseRepository, s.cfg.ReleasePublicKey != "")
	if err != nil || !projected {
		return err
	}
	valid, err := verifyManifestSignature(body, signature, s.cfg.ReleasePublicKey)
	if err != nil || !valid {
		return errors.New("发布绑定签名无效")
	}
	tuple, _ := json.Marshal([]string{strings.ToLower(s.cfg.ReleaseRepository), s.cfg.ReleasePublicKey, body, signature})
	sum := sha256.Sum256(tuple)
	key := hex.EncodeToString(sum[:])
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return s.releaseBindings.check(ctx, key, func() error {
		transport := s.apiTransport
		if transport == nil {
			transport = newAPITransport()
		}
		copy := transport.Clone()
		defer copy.CloseIdleConnections()
		client := &http.Client{Transport: copy, Timeout: 30 * time.Second, CheckRedirect: func(request *http.Request, via []*http.Request) error {
			host := request.URL.Host
			if len(via) > 3 || via[0].URL.Host == "api.github.com" || request.URL.Scheme != "https" || request.URL.User != nil || (host != "release-assets.githubusercontent.com" && host != "objects.githubusercontent.com") {
				return errors.New("发布绑定重定向无效")
			}
			return nil
		}}
		get := func(address string, max int64) ([]byte, error) {
			request, err := http.NewRequestWithContext(ctx, "GET", address, nil)
			if err != nil {
				return nil, err
			}
			request.Header.Set("Accept", "application/vnd.github+json")
			response, err := client.Do(request)
			if err != nil {
				return nil, err
			}
			defer response.Body.Close()
			if response.StatusCode != 200 {
				return nil, errors.New("发布绑定源返回非200")
			}
			raw, err := io.ReadAll(io.LimitReader(response.Body, max+1))
			if err != nil || int64(len(raw)) > max {
				return nil, errors.New("发布绑定原文超过限制或传输失败")
			}
			return raw, nil
		}
		repo, _ := releaseprotocol.CanonicalRepository(s.cfg.ReleaseRepository)
		read := func(_ context.Context, path string, max int64) ([]byte, error) {
			if !strings.HasPrefix(path, "/repos/"+repo+"/git/") {
				return nil, errors.New("发布绑定API仓库不符")
			}
			return get("https://api.github.com"+path, max)
		}
		if _, err = releaseprotocol.Verify(ctx, read, repo, m.Tag, "chordv-release.json", []byte(body), []byte(signature)); err != nil {
			return err
		}
		canonical := "https://github.com/" + repo + "/releases/download/" + url.PathEscape(m.Tag) + "/chordv-release.json"
		for _, file := range []struct {
			url      string
			expected string
			max      int64
		}{{canonical, body, 1 << 20}, {canonical + ".sig", signature, 1024}} {
			raw, err := get(file.url, file.max)
			if err != nil {
				return err
			}
			if string(raw) != file.expected {
				return errors.New("发布绑定与正式Release原文不一致")
			}
		}
		return nil
	})
}
