package api

import (
	"context"
	"errors"
	releaseprotocol "github.com/Achordchan/ChordV/packages/releaseprotocol"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (s *Server) verifyReleaseBinding(ctx context.Context, m releaseManifest, body, signature []byte) error {
	projected, err := releaseprotocol.Validate(m.SchemaVersion, m.TagBinding, m.SourceCommit, s.Config.GitHubRepository, s.Config.GitHubPublicKey != "")
	if err != nil || !projected {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client := *s.HTTP
	client.Timeout = 30 * time.Second
	client.Jar = nil
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		host := request.URL.Host
		if len(via) > 3 || via[0].URL.Host == "api.github.com" || request.URL.Scheme != "https" || request.URL.User != nil || (host != "release-assets.githubusercontent.com" && host != "objects.githubusercontent.com") {
			return errors.New("发布绑定重定向无效")
		}
		return nil
	}
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
	repo, _ := releaseprotocol.CanonicalRepository(s.Config.GitHubRepository)
	read := func(_ context.Context, path string, max int64) ([]byte, error) {
		if !strings.HasPrefix(path, "/repos/"+repo+"/git/") {
			return nil, errors.New("发布绑定API仓库不符")
		}
		return get("https://api.github.com"+path, max)
	}
	if _, err = releaseprotocol.Verify(ctx, read, repo, m.Tag, "chordv-release.json", body, signature); err != nil {
		return err
	}
	canonical := "https://github.com/" + repo + "/releases/download/" + url.PathEscape(m.Tag) + "/chordv-release.json"
	for _, file := range []struct {
		url      string
		expected []byte
		max      int64
	}{{canonical, body, 1 << 20}, {canonical + ".sig", signature, 1024}} {
		raw, err := get(file.url, file.max)
		if err != nil {
			return err
		}
		if string(raw) != string(file.expected) {
			return errors.New("发布绑定与正式Release原文不一致")
		}
	}
	return nil
}
