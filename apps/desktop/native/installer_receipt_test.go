package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPersistedInstallerNeverTrustsReceiptWithoutConfiguredKey(t *testing.T) {
	s, pending := installerHandoffFixture(t, "http://127.0.0.1:1")
	if err := atomicJSON(filepath.Join(s.cfg.DataDir, "updater", "pending.json"), pending); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(pending.Path)
	if err != nil {
		t.Fatal(err)
	}
	for _, missing := range []string{"key", "repository"} {
		t.Run(missing, func(t *testing.T) {
			cfg := s.cfg
			if missing == "key" {
				cfg.ReleasePublicKey = ""
			} else {
				cfg.ReleaseRepository = ""
			}
			restarted := newDesktopService(cfg)
			defer restarted.cancel()
			if _, err := restarted.validatedInstaller(pending.Path); err == nil {
				t.Fatal("持久pending与本地floor不能替代当前配置的验签公钥及发布仓库")
			}
			after, err := os.ReadFile(pending.Path)
			if err != nil || string(after) != string(before) {
				t.Fatal("拒绝信任缺失时不应修改下载文件", err)
			}
		})
	}
	if _, err := s.validatedInstaller(pending.Path); err != nil {
		t.Fatal("仍保留完整信任配置的原服务必须可重试", err)
	}
}

func TestInstallerDownloadPublishesOnlyPersistedReceipt(t *testing.T) {
	s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
	s.pending = nil
	payload, err := os.ReadFile(p.Path)
	if err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(map[string]any{"url": "https://github.com/" + s.cfg.ReleaseRepository + "/releases/download/" + p.Grant.Tag + "/" + p.Grant.FileName, "sha256": p.SHA256, "fileName": p.Grant.FileName, "fileSizeBytes": p.Size, "expectedVersion": p.Version})
	if err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(filepath.Dir(p.Path), "pending.json")
	if err := os.Mkdir(record, 0700); err != nil {
		t.Fatal(err)
	}
	// Resume a complete partial file through the actual download verifier without HTTP.
	download := func() error {
		t.Helper()
		if err := os.WriteFile(p.Path+"."+p.SHA256[:16]+".part", payload, 0600); err != nil {
			t.Fatal(err)
		}
		_, err := s.downloadInstaller(context.Background(), input)
		return err
	}
	if err := download(); err == nil {
		t.Fatal("expected receipt persistence failure")
	}
	if _, err := s.validatedInstaller(p.Path); err == nil {
		t.Fatal("failed download was installable from memory")
	}
	if err := os.Remove(record); err != nil {
		t.Fatal(err)
	}
	if err := download(); err != nil {
		t.Fatal(err)
	}
	restarted := newDesktopService(s.cfg)
	defer restarted.cancel()
	for _, svc := range []*DesktopService{s, restarted} {
		got, err := svc.validatedInstaller(p.Path)
		if err != nil || *got != *p {
			t.Fatal("retry did not persist the same verified installer", err)
		}
	}
}

func TestInstallerCorrectedDiskReceiptRetriedWithoutRestart(t *testing.T) {
	s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
	s.pending = nil
	path := filepath.Join(filepath.Dir(p.Path), "pending.json")
	bad := *p
	bad.Version = "wrong-version"
	if err := atomicJSON(path, bad); err != nil {
		t.Fatal(err)
	}
	if _, err := s.validatedInstaller(p.Path); err == nil {
		t.Fatal("changed receipt accepted")
	}
	if err := atomicJSON(path, p); err != nil {
		t.Fatal(err)
	}
	got, err := s.validatedInstaller(p.Path)
	if err != nil || *got != *p {
		t.Fatal("corrected receipt not reloaded", err)
	}
}
