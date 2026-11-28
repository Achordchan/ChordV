package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type externalURLCommand struct {
	name string
	args []string
}

// 串行测试仅替换本测试进程的OS执行器，真实Invoke和URL校验仍运行。
func captureExternalURLOpen(t *testing.T) *[]externalURLCommand {
	t.Helper()
	previous := externalURLCommandOutput
	t.Cleanup(func() { externalURLCommandOutput = previous })
	commands := []externalURLCommand{}
	externalURLCommandOutput = func(_ context.Context, name string, args ...string) (string, error) {
		commands = append(commands, externalURLCommand{name, append([]string(nil), args...)})
		return "", nil
	}
	return &commands
}

func invokeExternalURL(address string) (any, error) {
	payload, _ := json.Marshal(map[string]string{"url": address})
	return (&DesktopService{}).Invoke(context.Background(), "open_external_url", payload)
}

func TestExternalURLAcceptsMailtoAndWeb(t *testing.T) {
	commands := captureExternalURLOpen(t)
	query := url.Values{"subject": {"ChordV 账号密码协助"}, "body": {"你好，我需要协助。\n\n登录邮箱：user@example.com"}}
	for _, address := range []string{
		"mailto:achordchan@gmail.com?" + query.Encode(),
		"mailto:user+tag@example.com",
		"mailto:user%2Btag%40example.com?subject=&body=",
		"http://example.invalid/help",
		"https://example.invalid/help?a=1&b=2#account",
	} {
		result, err := invokeExternalURL(address)
		if err != nil {
			t.Fatalf("valid URL %q rejected: %v", address, err)
		}
		if !reflect.DeepEqual(result, map[string]bool{"ok": true}) {
			t.Fatalf("unexpected result: %#v", result)
		}
		command := (*commands)[len(*commands)-1]
		name, args := "xdg-open", []string{address}
		switch runtime.GOOS {
		case "darwin":
			name = "/usr/bin/open"
		case "windows":
			name, args = "rundll32.exe", []string{"url.dll,FileProtocolHandler", address}
		}
		if command.name != name || !reflect.DeepEqual(command.args, args) {
			t.Fatalf("wrong OS command: %#v", command)
		}
	}
	if len(*commands) != 5 {
		t.Fatalf("commands: %d", len(*commands))
	}
}

func TestExternalURLRejectsSchemesHeadersAndControlCharacters(t *testing.T) {
	commands := captureExternalURLOpen(t)
	for _, address := range []string{
		"file:///tmp/test-only", "javascript:alert(1)", "data:text/plain,test", "tel:123", "custom:test",
		"http:///missing-host", "https://example.invalid/%0Aheader", "https://example.invalid/\x00",
		" mailto:user@example.com", "mailto:user@example.com ", "mailto://user@example.com", "mailto:/user@example.com",
		"mailto:not-an-email", "mailto:Name%20%3Cuser@example.com%3E", "mailto:user@example.com,other@example.com",
		"mailto:user@example.com%2Cother@example.com", "mailto:user@example.com;other@example.com",
		"mailto:user@example.com%0D%0ABcc:other@example.com", "mailto:user@example.com#fragment",
		"mailto:user@example.com?cc=other@example.com", "mailto:user@example.com?bcc=other@example.com",
		"mailto:user@example.com?attachment=file:///tmp/test-only", "mailto:user@example.com?%62cc=other@example.com",
		"mailto:user@example.com?subject=one&subject=two", "mailto:user@example.com?body=one&body=two",
		"mailto:user@example.com?subject=hello%0ABcc:other@example.com", "mailto:user@example.com?subject=hello%0DBcc:other@example.com",
		"mailto:user@example.com?subject=hello%09header", "mailto:user@example.com?body=hello%0Dheader",
		"mailto:user@example.com?subject=hello%250ABcc:other@example.com", "mailto:user@example.com?subject=hello%25250DBcc:other@example.com",
		"mailto:user@example.com?body=hello%FF", "mailto:user@example.com#", "mailto:user@example.com?body=" + strings.Repeat("x", 16*1024),
		"mailto:user@example.com?body=hello%00", "mailto:user@example.com?body=hello%7F", "mailto:user@example.com?subject=%zz",
		"mailto:user@example.com?body=hello\nworld", "mailto:user@example.com?body=hello\rworld",
	} {
		if _, err := invokeExternalURL(address); err == nil {
			t.Errorf("invalid URL accepted: %q", address)
		}
	}
	if len(*commands) != 0 {
		t.Fatalf("rejected URLs reached OS opener: %#v", *commands)
	}
}

func TestExternalURLOpenerFailurePropagates(t *testing.T) {
	previous := externalURLCommandOutput
	t.Cleanup(func() { externalURLCommandOutput = previous })
	failure := errors.New("test-only OS opener failure")
	externalURLCommandOutput = func(context.Context, string, ...string) (string, error) { return "", failure }
	if _, err := invokeExternalURL("https://example.invalid/help"); !errors.Is(err, failure) {
		t.Fatalf("lost opener failure: %v", err)
	}
}
