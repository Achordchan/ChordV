//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const macSchema2HTTPFile = "schema2-http-fixture.json"

type macSchema2HTTPConfig struct {
	Root, DataDir, Endpoint, Repository, PublicKey string
	OwnerIdentity                                  string
	OwnerPID                                       int
}

type macSchema2HTTPRequest struct {
	PID  int    `json:"pid"`
	Host string `json:"host"`
	Path string `json:"path"`
}

type macSchema2HTTPServer struct {
	git      *schema2Fixture
	endpoint string
	mu       sync.Mutex
	requests []macSchema2HTTPRequest
}

func newMacSchema2HTTPServer(t *testing.T, manifest map[string]any) *macSchema2HTTPServer {
	t.Helper()
	f := &macSchema2HTTPServer{git: schema2GitFixture(t, manifest)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.Atoi(r.Header.Get("X-ChordV-Schema2-Test-PID"))
		if err != nil || pid < 2 || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" ||
			(r.Host != "api.github.com" && r.Host != "github.com") {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		f.mu.Lock()
		f.requests = append(f.requests, macSchema2HTTPRequest{PID: pid, Host: r.Host, Path: r.URL.Path})
		f.mu.Unlock()
		f.git.mu.RLock()
		body, exists := f.git.routes[r.URL.Path]
		body = append([]byte(nil), body...)
		f.git.mu.RUnlock()
		if !exists {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	f.endpoint = server.URL
	return f
}

func (f *macSchema2HTTPServer) snapshot() []macSchema2HTTPRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]macSchema2HTTPRequest(nil), f.requests...)
}

func writeMacSchema2HTTPConfig(t *testing.T, f macUpdateFixture, server *macSchema2HTTPServer) {
	t.Helper()
	identity, err := processIdentity(context.Background(), os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	cfg := macSchema2HTTPConfig{Root: f.Root, DataDir: f.DataDir, Endpoint: server.endpoint, Repository: "owner/repo", PublicKey: server.git.public,
		OwnerPID: os.Getpid(), OwnerIdentity: identity}
	if err := atomicJSON(filepath.Join(f.DataDir, "updater", macSchema2HTTPFile), cfg); err != nil {
		t.Fatal(err)
	}
}

// Only the test binary's explicit holder/helper roles call this. Neither the
// ordinary packaged GUI nor production configuration reads this fixture file.
func installMacSchema2HTTPFixture(expected macFixtureConfig) (func(), error) {
	path := filepath.Join(expected.DataDir, "updater", macSchema2HTTPFile)
	raw, err := readMacRecoveryFile(path)
	if os.IsNotExist(err) {
		return func() {}, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg macSchema2HTTPConfig
	if json.Unmarshal(raw, &cfg) != nil || cfg.DataDir != expected.DataDir || cfg.Repository != expected.Repository ||
		cfg.PublicKey != expected.PublicKey || cfg.OwnerPID < 2 || cfg.OwnerIdentity == "" {
		return nil, errors.New("schema2测试传输不属于当前fixture")
	}
	root, err := macCanonical(cfg.Root)
	temporary, tempErr := macCanonical(os.TempDir())
	if err != nil || tempErr != nil || root != cfg.Root || filepath.Dir(cfg.DataDir) != root || !macPathInside(temporary, root) {
		return nil, errors.New("schema2测试传输必须位于自有临时目录")
	}
	identity, err := processIdentity(context.Background(), cfg.OwnerPID)
	if err != nil || identity != cfg.OwnerIdentity {
		return nil, errors.New("schema2测试传输的父测试进程已变化")
	}
	endpoint, err := url.Parse(cfg.Endpoint)
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.Port() == "" ||
		endpoint.User != nil || endpoint.Path != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("schema2测试传输只允许固定回环HTTP服务")
	}
	if err := atomicJSON(filepath.Join(cfg.DataDir, "updater", "schema2-transport-"+strconv.Itoa(os.Getpid())+".json"),
		map[string]any{"pid": os.Getpid(), "ownerPid": cfg.OwnerPID, "configurationSHA256": testHash(raw)}); err != nil {
		return nil, err
	}
	original := newAPITransport
	newAPITransport = func() *http.Transport {
		transport := original()
		transport.Proxy = func(request *http.Request) (*url.URL, error) {
			if request.Method != http.MethodGet || request.URL.Scheme != "https" || request.URL.User != nil ||
				(request.URL.Host != "api.github.com" && request.URL.Host != "github.com") {
				return nil, errors.New("schema2测试传输拒绝非固定GitHub请求")
			}
			request.Header.Set("X-ChordV-Schema2-Test-PID", strconv.Itoa(os.Getpid()))
			return nil, nil
		}
		transport.DialContext = func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("schema2测试传输不允许真实HTTP或外网连接")
		}
		transport.DialTLSContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if address != "api.github.com:443" && address != "github.com:443" {
				return nil, errors.New("schema2测试传输目标无效")
			}
			return (&net.Dialer{}).DialContext(ctx, network, endpoint.Host)
		}
		return transport
	}
	return func() { newAPITransport = original }, nil
}

func TestMacSchema2HTTPFactoryDefaultAndAbsentFixture(t *testing.T) {
	original := newAPITransport
	transport := original()
	defer transport.CloseIdleConnections()
	if transport.Proxy != nil || transport.DialTLSContext != nil || transport.ResponseHeaderTimeout != 15*time.Second ||
		transport.TLSHandshakeTimeout != 10*time.Second || transport.IdleConnTimeout != 90*time.Second {
		t.Fatal("default production transport changed")
	}
	restore, err := installMacSchema2HTTPFixture(macFixtureConfig{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer restore()
	if reflect.ValueOf(newAPITransport).Pointer() != reflect.ValueOf(original).Pointer() {
		t.Fatal("absent fixture changed transport")
	}
}

func TestMacSchema2HTTPFixtureRejectsUnownedConfiguration(t *testing.T) {
	for _, scenario := range []string{"repository", "public-key", "data-dir", "root", "owner-identity", "owner-pid", "remote-endpoint", "tls-endpoint", "endpoint-user", "endpoint-path", "endpoint-query", "endpoint-fragment", "endpoint-no-port", "mode", "symlink", "hardlink", "oversize", "invalid-json"} {
		t.Run(scenario, func(t *testing.T) {
			root, err := macCanonical(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			expected := macFixtureConfig{DataDir: filepath.Join(root, "data"), Repository: "owner/repo", PublicKey: "fixture-key"}
			if err := os.MkdirAll(filepath.Join(expected.DataDir, "updater"), 0700); err != nil {
				t.Fatal(err)
			}
			identity, err := processIdentity(context.Background(), os.Getpid())
			if err != nil {
				t.Fatal(err)
			}
			cfg := macSchema2HTTPConfig{Root: root, DataDir: expected.DataDir, Repository: expected.Repository, PublicKey: expected.PublicKey,
				OwnerPID: os.Getpid(), OwnerIdentity: identity, Endpoint: "http://127.0.0.1:12345"}
			switch scenario {
			case "repository":
				cfg.Repository = "other/repo"
			case "public-key":
				cfg.PublicKey = "other-key"
			case "data-dir":
				cfg.DataDir = filepath.Join(root, "other")
			case "root":
				cfg.Root = filepath.Dir(root)
			case "owner-identity":
				cfg.OwnerIdentity += "-changed"
			case "owner-pid":
				cfg.OwnerPID = 1
			case "remote-endpoint":
				cfg.Endpoint = "http://192.0.2.1:12345"
			case "tls-endpoint":
				cfg.Endpoint = "https://127.0.0.1:12345"
			case "endpoint-user":
				cfg.Endpoint = "http://fixture@127.0.0.1:12345"
			case "endpoint-path":
				cfg.Endpoint += "/path"
			case "endpoint-query":
				cfg.Endpoint += "?fixture=1"
			case "endpoint-fragment":
				cfg.Endpoint += "#fixture"
			case "endpoint-no-port":
				cfg.Endpoint = "http://127.0.0.1"
			}
			path := filepath.Join(expected.DataDir, "updater", macSchema2HTTPFile)
			if err := atomicJSON(path, cfg); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "mode":
				err = os.Chmod(path, 0644)
			case "symlink":
				if err = os.Rename(path, path+".original"); err == nil {
					err = os.Symlink(path+".original", path)
				}
			case "hardlink":
				err = os.Link(path, path+".linked")
			case "oversize":
				err = os.WriteFile(path, []byte(strings.Repeat(" ", (2<<20)+1)), 0600)
			case "invalid-json":
				err = os.WriteFile(path, []byte("{"), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			original := newAPITransport
			restore, installErr := installMacSchema2HTTPFixture(expected)
			if restore != nil {
				defer restore()
			}
			if installErr == nil || reflect.ValueOf(newAPITransport).Pointer() != reflect.ValueOf(original).Pointer() {
				t.Fatal("unowned fixture changed transport", installErr)
			}
			if _, err := os.Stat(filepath.Join(expected.DataDir, "updater", "schema2-transport-"+strconv.Itoa(os.Getpid())+".json")); !os.IsNotExist(err) {
				t.Fatal("rejected configuration created an installation witness", err)
			}
		})
	}
}

func (f *macSchema2HTTPServer) mutateRawSignature(tag string) {
	f.git.mu.Lock()
	defer f.git.mu.Unlock()
	f.git.routes["/owner/repo/releases/download/"+tag+"/chordv-release.json.sig"] = []byte(strings.TrimSpace(string(f.git.signature)))
}
