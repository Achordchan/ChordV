package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNativeSlowDownloadEmitsFrontendFallbackMarker(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "2")
		_, _ = w.Write([]byte("a"))
		w.(http.Flusher).Flush()
		select {
		case <-time.After(12100 * time.Millisecond):
			_, _ = w.Write([]byte("b"))
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "slow.dat")
	err := downloadVerified(context.Background(), server.URL, path, testHash([]byte("ab")), 2, 64*1024, func(int64, *int64) {})
	if err == nil || !strings.Contains(err.Error(), "download too slow on this mirror") {
		t.Fatalf("原生低速错误不符合前端去门槛重试协议: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("低速失败不应发布最终文件")
	}
}

func TestVerifiedDownloadResumesAcrossSourcesAndRejectsPoisonedPartial(t *testing.T) {
	data := bytes.Repeat([]byte("immutable-release\n"), 100000)
	hash := testHash(data)
	for _, poisoned := range []bool{false, true} {
		t.Run(fmt.Sprintf("poisoned=%t", poisoned), func(t *testing.T) {
			prefix := bytes.Clone(data[:65536])
			if poisoned {
				prefix[0] ^= 0xff
			}
			broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", fmt.Sprint(len(data)))
				w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(data)-1, len(data)))
				w.WriteHeader(206)
				_, _ = w.Write(prefix)
			}))
			defer broken.Close()
			var mu sync.Mutex
			var ranges []string
			healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Error("资产传输不应发送业务凭据")
				}
				mu.Lock()
				ranges = append(ranges, r.Header.Get("Range"))
				mu.Unlock()
				http.ServeContent(w, r, "artifact.dat", time.Time{}, bytes.NewReader(data))
			}))
			defer healthy.Close()
			path := filepath.Join(t.TempDir(), "artifact.dat")
			previous := []byte("previous verified artifact")
			if err := os.WriteFile(path, previous, 0600); err != nil {
				t.Fatal(err)
			}
			progress := func(int64, *int64) {}
			if err := downloadVerified(context.Background(), broken.URL, path, hash, int64(len(data)), 0, progress); err == nil {
				t.Fatal("断流源不应成功")
			}
			partial := path + "." + hash[:16] + ".part"
			info, err := os.Stat(partial)
			if err != nil || info.Size() != int64(len(prefix)) {
				t.Fatal("没有保留实际断流位置", err)
			}
			err = downloadVerified(context.Background(), healthy.URL, path, hash, int64(len(data)), 0, progress)
			mu.Lock()
			first := ranges[0]
			mu.Unlock()
			if !strings.HasPrefix(first, fmt.Sprintf("bytes=%d-", len(prefix))) {
				t.Fatal("切换源后没有续传相同Hash的实际断点", first)
			}
			if poisoned {
				if err == nil || !strings.Contains(err.Error(), "SHA256") {
					t.Fatal("污染part与健康源拼接后没有拒绝整体Hash不符")
				}
				retained, _ := os.ReadFile(path)
				if !bytes.Equal(retained, previous) {
					t.Fatal("污染下载覆盖了上一份已验证文件")
				}
				if _, err := os.Stat(partial); !os.IsNotExist(err) {
					t.Fatal("校验失败的part没有清理")
				}
				if err = downloadVerified(context.Background(), healthy.URL, path, hash, int64(len(data)), 0, progress); err != nil {
					t.Fatal("污染part清理后不能从健康源重新下载", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if err := verifyFile(path, hash, int64(len(data))); err != nil {
				t.Fatal("跨源最终文件不符合签名授权Hash与大小", err)
			}
		})
	}
}

func TestVerifiedDownloadResumesAndPublishesOnlyValidFile(t *testing.T) {
	data := bytes.Repeat([]byte("chordv-download"), 400000)
	var ranges []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ranges = append(ranges, r.Header.Get("Range"))
		mu.Unlock()
		http.ServeContent(w, r, "component.dat", time.Time{}, bytes.NewReader(data))
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "component.dat")
	hash := testHash(data)
	ctx, cancel := context.WithCancel(context.Background())
	err := downloadVerified(ctx, server.URL, path, hash, int64(len(data)), 0, func(int64, *int64) { cancel() })
	if err == nil {
		t.Fatal("canceled download succeeded")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("user cancellation lost its cancellation identity: %v", err)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("partial file was published")
	}
	partial := path + "." + hash[:16] + ".part"
	info, err := os.Stat(partial)
	if err != nil || info.Size() <= 0 {
		t.Fatal("partial not retained", err)
	}
	offset := info.Size()
	mu.Lock()
	ranges = nil
	mu.Unlock()
	if err := downloadVerified(context.Background(), server.URL, path, hash, int64(len(data)), 0, func(int64, *int64) {}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	first := ranges[0]
	mu.Unlock()
	if !strings.HasPrefix(first, fmt.Sprintf("bytes=%d-", offset)) {
		t.Fatalf("did not resume at %d: %s", offset, first)
	}
	if err := verifyFile(path, hash, int64(len(data))); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(partial); !os.IsNotExist(err) {
		t.Fatal("verified partial not cleaned")
	}
}
func TestDownloadRejectsHashMismatchAndPreservesPreviousFile(t *testing.T) {
	data := []byte("bad remote bytes")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "item", time.Time{}, bytes.NewReader(data))
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "item")
	if err := os.WriteFile(path, []byte("previous verified version"), 0600); err != nil {
		t.Fatal(err)
	}
	err := downloadVerified(context.Background(), server.URL, path, strings.Repeat("a", 64), int64(len(data)), 0, func(int64, *int64) {})
	if err == nil {
		t.Fatal("mismatched hash accepted")
	}
	existing, _ := os.ReadFile(path)
	if string(existing) != "previous verified version" {
		t.Fatal("previous version overwritten")
	}
}
func TestDownloadHandlesServerIgnoringRange(t *testing.T) {
	data := []byte("complete artifact")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(data) }))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "item")
	hash := testHash(data)
	if err := os.WriteFile(path+"."+hash[:16]+".part", data[:3], 0600); err != nil {
		t.Fatal(err)
	}
	if err := downloadVerified(context.Background(), server.URL, path, hash, int64(len(data)), 0, func(int64, *int64) {}); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(actual, data) {
		t.Fatal("range ignored caused duplicated bytes")
	}
}

func TestDownloadIgnoringRangeRestartsSpeedBaseline(t *testing.T) {
	data := bytes.Repeat([]byte("a"), 8*1024*1024)
	hash := testHash(data)
	const resumeOffset = 7 * 1024 * 1024
	requests := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Header.Get("Range")
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		w.WriteHeader(http.StatusOK)
		for offset := 0; offset < len(data); offset += 128 * 1024 {
			if offset > 0 {
				select {
				case <-time.After(250 * time.Millisecond):
				case <-r.Context().Done():
					return
				}
			}
			if _, err := w.Write(data[offset : offset+128*1024]); err != nil {
				return
			}
			w.(http.Flusher).Flush()
		}
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "restart.dat")
	previous := []byte("previous verified artifact")
	if err := os.WriteFile(path, previous, 0600); err != nil {
		t.Fatal(err)
	}
	partial := path + "." + hash[:16] + ".part"
	if err := os.WriteFile(partial, data[:resumeOffset], 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	started := time.Now()
	err := downloadVerified(ctx, server.URL, path, hash, int64(len(data)), 64*1024, func(int64, *int64) {
		retained, readErr := os.ReadFile(path)
		if readErr != nil || !bytes.Equal(retained, previous) {
			t.Error("unverified full retransmission replaced the previous artifact", readErr)
		}
	})
	if err != nil {
		t.Fatalf("healthy 512KiB/s HTTP 200 retransmission was rejected after %s: %v", time.Since(started), err)
	}
	if elapsed := time.Since(started); elapsed <= 12*time.Second {
		t.Fatalf("test did not cross the real speed grace period: %s", elapsed)
	}
	if first := <-requests; first != fmt.Sprintf("bytes=%d-%d", resumeOffset, len(data)-1) || len(requests) != 0 {
		t.Fatalf("expected one ranged request followed by full HTTP 200 body: %s", first)
	}
	if err := verifyFile(path, hash, int64(len(data))); err != nil {
		t.Fatal("full retransmission failed final size/SHA256 validation", err)
	}
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatal("verified retransmission left its partial file", err)
	}
}

func TestVerifiedDownloadRejectsActualBodyStall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "2")
		_, _ = w.Write([]byte("a"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "stalled.dat")
	previous := []byte("previous verified artifact")
	if err := os.WriteFile(path, previous, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer cancel()
	started := time.Now()
	err := downloadVerified(ctx, server.URL, path, testHash([]byte("ab")), 2, 64*1024, func(int64, *int64) {})
	if err == nil || ctx.Err() != nil {
		t.Fatalf("body stall was not rejected by the native inactivity timer: %v; caller=%v", err, ctx.Err())
	}
	if errors.Is(err, context.Canceled) || strings.Contains(strings.ToLower(err.Error()), "cancel") || strings.Contains(err.Error(), "取消") || strings.Contains(err.Error(), "AbortError") {
		t.Fatalf("native inactivity timeout impersonated user cancellation: %v", err)
	}
	if elapsed := time.Since(started); elapsed < downloadStallTimeout || elapsed > 60*time.Second {
		t.Fatalf("unexpected native stall interval: %s", elapsed)
	}
	retained, readErr := os.ReadFile(path)
	if readErr != nil || !bytes.Equal(retained, previous) {
		t.Fatal("stalled download replaced the previous verified artifact", readErr)
	}
	partial := path + "." + testHash([]byte("ab"))[:16] + ".part"
	info, statErr := os.Stat(partial)
	if statErr != nil || info.Size() != 1 {
		t.Fatal("stall did not retain the actual one-byte resume position", statErr)
	}
	t.Logf("native body stall rejected after %s: %v", time.Since(started), err)
	resumedRange := make(chan string, 1)
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resumedRange <- r.Header.Get("Range")
		http.ServeContent(w, r, "artifact.dat", time.Time{}, bytes.NewReader([]byte("ab")))
	}))
	defer healthy.Close()
	if err := downloadVerified(ctx, healthy.URL, path, testHash([]byte("ab")), 2, 64*1024, func(int64, *int64) {}); err != nil {
		t.Fatal("healthy second source did not resume after native stall", err)
	}
	if got := <-resumedRange; got != "bytes=1-1" {
		t.Fatalf("healthy source did not receive the actual saved offset: %s", got)
	}
	if err := verifyFile(path, testHash([]byte("ab")), 2); err != nil {
		t.Fatal("second-source result failed final SHA256/size verification", err)
	}
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatal("successful source fallback retained partial file", err)
	}
}

func TestDownloadRejectsWrongRangeAndLength(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Range", "bytes 1-4/5")
		w.WriteHeader(206)
		w.Write([]byte("test"))
	}))
	defer server.Close()
	if err := downloadVerified(context.Background(), server.URL, filepath.Join(t.TempDir(), "item"), strings.Repeat("0", 64), 5, 0, func(int64, *int64) {}); err == nil {
		t.Fatal("wrong range accepted")
	}
}
func TestDownloadURLAllowlist(t *testing.T) {
	for _, address := range []string{"https://github.com/o/r/releases/download/v1.2.3/app.exe", "https://ghfast.top/https://github.com/o/r/releases/download/v1.2.3/app.exe", "https://raw.githubusercontent.com/o/r/release-channels/stable.json"} {
		if err := validateDownloadURL(address); err != nil {
			t.Fatal(address, err)
		}
	}
	for _, address := range []string{"http://example.com/file", "https://github.com/o/r/releases/latest/download/app.exe", "https://ghfast.top/https://127.0.0.1:3000/private", "https://github.com.evil.test/o/r/releases/download/v1/app.exe", "https://user:password@github.com/o/r/releases/download/v1/app.exe"} {
		if validateDownloadURL(address) == nil {
			t.Fatal("untrusted source accepted", address)
		}
	}
}
func TestExtractZipEntryDoesNotFollowArchivePathsOrSymlinks(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "archive.zip")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	header := &zip.FileHeader{Name: "xray"}
	header.SetMode(0755)
	entry, _ := writer.CreateHeader(header)
	entry.Write([]byte("real binary content"))
	link := &zip.FileHeader{Name: "link"}
	link.SetMode(os.ModeSymlink | 0777)
	entry, _ = writer.CreateHeader(link)
	entry.Write([]byte("/etc/passwd"))
	writer.Close()
	file.Close()
	destination := filepath.Join(t.TempDir(), "xray")
	if err := extractZipEntry(archive, "xray", destination); err != nil {
		t.Fatal(err)
	}
	if err := extractZipEntry(archive, "link", destination+".link"); err == nil {
		t.Fatal("symlink entry accepted")
	}
	if err := extractZipEntry(archive, "missing", destination+".missing"); err == nil {
		t.Fatal("missing entry accepted")
	}
}
