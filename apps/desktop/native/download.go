package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxDownloadBytes int64 = 1024 * 1024 * 1024
const downloadChunkBytes int64 = 4 * 1024 * 1024
const downloadStallTimeout = 45 * time.Second
const downloadSlowMirrorMarker = "download too slow on this mirror"

var errDownloadStalled = fmt.Errorf("download stalled: 下载源连续 %s 未收到数据，请切换其他下载源", downloadStallTimeout)

func validateDownloadURL(address string) error {
	u, err := url.Parse(address)
	if err != nil || u.User != nil || u.Fragment != "" {
		return errors.New("下载地址无效")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && ip.IsLoopback() && u.Scheme == "http" {
		return nil
	}
	if u.Scheme != "https" {
		return errors.New("下载仅允许 HTTPS")
	}
	if strings.EqualFold(u.Hostname(), "ghfast.top") {
		inner, err := url.PathUnescape(strings.TrimPrefix(u.EscapedPath(), "/"))
		if err != nil || (!strings.HasPrefix(inner, "https://github.com/") && !strings.HasPrefix(inner, "https://raw.githubusercontent.com/")) {
			return errors.New("下载镜像必须包裹 GitHub 原始地址")
		}
		return validateDownloadURL(inner)
	}
	switch strings.ToLower(u.Hostname()) {
	case "github.com":
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) < 6 || parts[2] != "releases" || parts[3] != "download" || parts[4] == "latest" {
			return errors.New("必须使用固定版本的 GitHub Release 下载地址")
		}
	case "api.github.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
	default:
		return errors.New("本地重构版本仅允许 GitHub 官方下载源")
	}
	return nil
}

func downloadHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 15 * time.Second}).DialContext, ResponseHeaderTimeout: 30 * time.Second, TLSHandshakeTimeout: 15 * time.Second, IdleConnTimeout: 30 * time.Second}, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 8 {
			return errors.New("下载重定向次数过多")
		}
		return validateDownloadURL(req.URL.String())
	}}
}

func normalizedSHA256(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	bytes, err := hex.DecodeString(value)
	if err != nil || len(bytes) != sha256.Size {
		return "", errors.New("下载文件必须提供有效的 SHA256")
	}
	return value, nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func verifyFile(path, expected string, size int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("下载目标不是普通文件")
	}
	if size > 0 && info.Size() != size {
		return errors.New("下载文件长度与发布清单不一致")
	}
	hash, err := fileSHA256(path)
	if err != nil {
		return err
	}
	if hash != expected {
		return errors.New("下载文件 SHA256 与发布清单不一致")
	}
	return nil
}

// A fixed hash owns its partial file, so interruption resumes the same immutable release.
func downloadVerified(ctx context.Context, address, destination, expected string, size int64, minBytesPerSecond int64, progress func(int64, *int64)) error {
	if err := validateDownloadURL(address); err != nil {
		return err
	}
	hash, err := normalizedSHA256(expected)
	if err != nil {
		return err
	}
	if size <= 0 || size > maxDownloadBytes {
		return errors.New("发布清单文件大小无效")
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	partial := destination + "." + hash[:16] + ".part"
	f, err := os.OpenFile(partial, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	offset := info.Size()
	if offset > size {
		if err = f.Truncate(0); err != nil {
			return err
		}
		offset = 0
	}
	client := downloadHTTPClient(0)
	defer client.CloseIdleConnections()
	started, initialOffset := time.Now(), offset
	for offset < size {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := min(offset+downloadChunkBytes-1, size-1)
		chunkCtx, cancel := context.WithCancelCause(ctx)
		request, err := http.NewRequestWithContext(chunkCtx, "GET", address, nil)
		if err != nil {
			cancel(nil)
			return err
		}
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, end))
		request.Header.Set("Accept-Encoding", "identity")
		response, err := client.Do(request)
		if err != nil {
			cancel(nil)
			return err
		}
		if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
			response.Body.Close()
			cancel(nil)
			return fmt.Errorf("下载返回 HTTP %d", response.StatusCode)
		}
		if response.StatusCode == http.StatusPartialContent {
			var from, to, total int64
			if _, err := fmt.Sscanf(response.Header.Get("Content-Range"), "bytes %d-%d/%d", &from, &to, &total); err != nil || from != offset || to < from || to > end || total != size {
				response.Body.Close()
				cancel(nil)
				return errors.New("下载分块范围与发布清单不一致")
			}
		} else if offset > 0 {
			if err = f.Truncate(0); err != nil {
				response.Body.Close()
				cancel(nil)
				return err
			}
			offset = 0
			started, initialOffset = time.Now(), offset
		}
		if _, err = f.Seek(offset, io.SeekStart); err != nil {
			response.Body.Close()
			cancel(nil)
			return err
		}
		stall := time.AfterFunc(downloadStallTimeout, func() { cancel(errDownloadStalled) })
		buffer := make([]byte, 128*1024)
		received := int64(0)
		for {
			n, readErr := response.Body.Read(buffer)
			if n > 0 {
				stall.Reset(downloadStallTimeout)
				if offset+int64(n) > size {
					err = errors.New("下载内容超过发布清单大小")
					break
				}
				written, writeErr := f.Write(buffer[:n])
				offset += int64(written)
				received += int64(written)
				if writeErr != nil {
					err = writeErr
					break
				}
				if written != n {
					err = io.ErrShortWrite
					break
				}
				progress(offset, &size)
				if elapsed := time.Since(started); minBytesPerSecond > 0 && elapsed > 12*time.Second && float64(offset-initialOffset)/elapsed.Seconds() < float64(minBytesPerSecond) {
					err = errors.New(downloadSlowMirrorMarker + ": 下载源持续低速，请切换其他源")
					break
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					err = readErr
				}
				break
			}
		}
		stall.Stop()
		if cause := context.Cause(chunkCtx); cause != nil {
			err = cause
		}
		response.Body.Close()
		cancel(nil)
		if syncErr := f.Sync(); err == nil {
			err = syncErr
		}
		if err != nil {
			return err
		}
		if received == 0 {
			return errors.New("下载没有收到文件内容")
		}
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = verifyFile(partial, hash, size); err != nil {
		_ = os.Remove(partial)
		return err
	}
	return os.Rename(partial, destination)
}

func (s *DesktopService) beginDownload(ctx context.Context) (context.Context, func(), error) {
	s.downloadMu.Lock()
	defer s.downloadMu.Unlock()
	if s.downloadCancel != nil {
		return nil, nil, errors.New("已有下载任务正在运行")
	}
	child, cancel := context.WithCancel(ctx)
	s.downloadCancel = cancel
	return child, func() { cancel(); s.downloadMu.Lock(); s.downloadCancel = nil; s.downloadMu.Unlock() }, nil
}
func (s *DesktopService) cancelDownload() {
	s.downloadMu.Lock()
	defer s.downloadMu.Unlock()
	if s.downloadCancel != nil {
		s.downloadCancel()
	}
}

func probeDownloads(ctx context.Context, addresses []string) ([]map[string]any, error) {
	if len(addresses) > 12 {
		return nil, errors.New("每次最多检测 12 个下载源")
	}
	results := make([]map[string]any, len(addresses))
	var wg sync.WaitGroup
	for i, address := range addresses {
		wg.Add(1)
		go func(i int, address string) {
			defer wg.Done()
			started := time.Now()
			result := map[string]any{"url": address, "ok": false, "bytesReceived": int64(0), "bytesPerSecond": float64(0), "elapsedMs": int64(0), "error": nil}
			defer func() { result["elapsedMs"] = max(time.Since(started).Milliseconds(), 1); results[i] = result }()
			if err := validateDownloadURL(address); err != nil {
				result["error"] = err.Error()
				return
			}
			probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(probeCtx, "GET", address, nil)
			if err != nil {
				result["error"] = "地址无效"
				return
			}
			req.Header.Set("Range", "bytes=0-262143")
			client := downloadHTTPClient(0)
			defer client.CloseIdleConnections()
			response, err := client.Do(req)
			if err != nil {
				result["error"] = "连接失败"
				return
			}
			defer response.Body.Close()
			if response.StatusCode != 200 && response.StatusCode != 206 {
				result["error"] = "HTTP " + strconv.Itoa(response.StatusCode)
				return
			}
			n, err := io.Copy(io.Discard, io.LimitReader(response.Body, 256*1024))
			if err != nil && n == 0 {
				result["error"] = "读取失败"
				return
			}
			result["ok"] = n > 0
			result["bytesReceived"] = n
			result["bytesPerSecond"] = float64(n) / max(time.Since(started).Seconds(), 0.001)
		}(i, address)
	}
	wg.Wait()
	return results, nil
}
