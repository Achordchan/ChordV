package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComponentMetadataRejectsInvalidBaseContract(t *testing.T) {
	for _, scenario := range []string{"wrong-kind", "zero-size", "negative-size"} {
		t.Run(scenario, func(t *testing.T) {
			s := testService(t, "http://127.0.0.1:3100")
			if err := os.MkdirAll(s.binDir(), 0700); err != nil {
				t.Fatal(err)
			}
			record := installedComponent{Kind: "xray", InstalledSize: 10, InstalledSHA256: strings.Repeat("a", 64)}
			switch scenario {
			case "wrong-kind":
				record.Kind = "geoip"
			case "zero-size":
				record.InstalledSize = 0
			case "negative-size":
				record.InstalledSize = -1
			}
			if err := atomicJSON(filepath.Join(s.binDir(), "xray.json"), record); err != nil {
				t.Fatal(err)
			}
			if _, err := s.componentMetadata("xray"); err == nil {
				t.Fatal("基础安装记录契约必须由读取入口拒绝")
			}
		})
	}
}

func TestInvokeConnectRejectsInvalidRecordBeforeRuntimeExecution(t *testing.T) {
	for _, invalidKind := range []string{"xray", "geoip", "geosite"} {
		for _, zeroSize := range []bool{false, true} {
			scenario := "wrong-kind"
			if zeroSize {
				scenario = "zero-size"
			}
			t.Run(invalidKind+"/"+scenario, func(t *testing.T) {
				s := testService(t, "http://127.0.0.1:3100")
				if err := os.MkdirAll(s.binDir(), 0700); err != nil {
					t.Fatal(err)
				}
				for _, kind := range []string{"xray", "geoip", "geosite"} {
					data := []byte("non-executable local contract test " + kind)
					path, _ := s.componentPath(kind)
					if err := os.WriteFile(path, data, 0600); err != nil {
						t.Fatal(err)
					}
					record := installedComponent{Kind: kind, ArtifactSHA256: testHash(data), InstalledSHA256: testHash(data), InstalledSize: int64(len(data))}
					if kind == invalidKind {
						if zeroSize {
							record.InstalledSize = 0
						} else {
							record.Kind = "wrong-component"
						}
					}
					if err := atomicJSON(filepath.Join(s.binDir(), kind+".json"), record); err != nil {
						t.Fatal(err)
					}
				}
				listeners := []net.Listener{}
				for range 2 {
					listener, err := net.Listen("tcp", "127.0.0.1:0")
					if err != nil {
						t.Fatal(err)
					}
					listeners = append(listeners, listener)
					t.Cleanup(func() { _ = listener.Close() })
				}
				config := runtimeConfig{SessionID: "local-record-contract", LeaseHeartbeatIntervalSeconds: 30, LeaseGraceSeconds: 300, Mode: "direct", LocalHTTPPort: listeners[0].Addr().(*net.TCPAddr).Port,
					LocalSocksPort: listeners[1].Addr().(*net.TCPAddr).Port, Outbound: runtimeOutbound{Server: "127.0.0.1", Port: 443, UUID: "local-contract-only"}}
				for _, listener := range listeners {
					_ = listener.Close()
				}
				input, err := json.Marshal(map[string]any{"config": config})
				if err != nil {
					t.Fatal(err)
				}
				value, err := s.Invoke(context.Background(), "connect_runtime", input)
				if value != nil || err == nil || err.Error() != invalidKind+" 组件尚未准备完成" {
					t.Errorf("Invoke必须在启动内核前拒绝指定组件的安装记录: %v", err)
				}
				for _, name := range []string{"config.json", "xray.log"} {
					if _, err := os.Stat(filepath.Join(s.cfg.DataDir, "runtime", name)); !os.IsNotExist(err) {
						t.Error("无效安装记录不应进入配置写入/进程启动阶段", name)
					}
				}
				if s.runtime.process != nil {
					t.Fatal("无效组件记录启动了runtime进程")
				}
			})
		}
	}
}

func TestComponentLocalInfoRequiresMatchingInstallationRecord(t *testing.T) {
	for _, kind := range []string{"xray", "geoip", "geosite"} {
		for _, scenario := range []string{"missing-file", "missing-record", "corrupt-record", "changed-hash", "tampered-file", "changed-size", "missing-size", "wrong-kind", "valid"} {
			t.Run(kind+"/"+scenario, func(t *testing.T) {
				s := testService(t, "http://127.0.0.1:3100")
				if err := os.MkdirAll(s.binDir(), 0700); err != nil {
					t.Fatal(err)
				}
				path, _ := s.componentPath(kind)
				data := []byte("real local test component " + kind)
				if scenario != "missing-file" {
					if err := os.WriteFile(path, data, 0700); err != nil {
						t.Fatal(err)
					}
				}
				recordPath := filepath.Join(s.binDir(), kind+".json")
				record := installedComponent{Kind: kind, VersionLabel: pointer("local-test-profile"), ArtifactSHA256: testHash(data), InstalledSHA256: testHash(data), InstalledSize: int64(len(data))}
				switch scenario {
				case "corrupt-record":
					if err := os.WriteFile(recordPath, []byte("{"), 0600); err != nil {
						t.Fatal(err)
					}
				case "missing-file", "missing-record":
				default:
					switch scenario {
					case "changed-hash":
						record.InstalledSHA256 = strings.Repeat("0", 64)
					case "changed-size":
						record.InstalledSize++
					case "missing-size":
						record.InstalledSize = 0
					case "wrong-kind":
						record.Kind = "another-component"
					}
					if err := atomicJSON(recordPath, record); err != nil {
						t.Fatal(err)
					}
					if scenario == "tampered-file" {
						data[0] ^= 0xff
						if err := os.WriteFile(path, data, 0700); err != nil {
							t.Fatal(err)
						}
					}
				}
				value, err := s.componentLocalInfo(kind)
				if err != nil {
					t.Fatal(err)
				}
				info := value.(map[string]any)
				if info["exists"] != (scenario != "missing-file") || info["verified"] != (scenario == "valid") {
					t.Fatalf("物理存在和安装校验必须独立: exists=%v verified=%v", info["exists"], info["verified"])
				}
				if scenario != "missing-file" && (info["checksumSha256"] != testHash(data) || info["sizeBytes"] != int64(len(data))) {
					t.Fatal("应保留本次实际Hash和大小，不使用metadata代替文件事实")
				}
				if scenario != "valid" && info["versionLabel"] != nil {
					t.Fatal("无效安装记录不能对外报告已安装版本")
				}
				if scenario == "valid" && *info["versionLabel"].(*string) != "local-test-profile" {
					t.Fatal("正常预装profile标签应保留，不要求正式发行标签")
				}
			})
		}
	}
}

func TestComponentLocalInfoAndEnsureRejectEmptyFiles(t *testing.T) {
	s := testService(t, "http://127.0.0.1:3100")
	if err := os.MkdirAll(s.binDir(), 0700); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"xray", "geoip", "geosite"} {
		path, _ := s.componentPath(kind)
		if err := os.WriteFile(path, nil, 0700); err != nil {
			t.Fatal(err)
		}
		if err := atomicJSON(filepath.Join(s.binDir(), kind+".json"), installedComponent{Kind: kind, InstalledSHA256: testHash(nil)}); err != nil {
			t.Fatal(err)
		}
		value, err := s.componentLocalInfo(kind)
		if err != nil || value.(map[string]any)["verified"] != false {
			t.Fatal("空文件即使Hash符合也不能就绪", err)
		}
	}
	value, err := s.ensureComponents()
	if err != nil || value.(map[string]any)["ready"] != false {
		t.Fatal("内置组件检查不应对零长度记录返回ready", err)
	}
}

func TestVerifiedPreinstalledComponentsRemainReadyWithoutReleaseSource(t *testing.T) {
	s := testService(t, "http://127.0.0.1:3100")
	if s.cfg.ReleaseRepository != "" {
		t.Fatal("本用例必须没有远端发布来源")
	}
	if err := os.MkdirAll(s.binDir(), 0700); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"xray", "geoip", "geosite"} {
		data := []byte("preinstalled fixture bytes " + kind)
		path, _ := s.componentPath(kind)
		if err := os.WriteFile(path, data, 0700); err != nil {
			t.Fatal(err)
		}
		hash := testHash(data)
		if err := atomicJSON(filepath.Join(s.binDir(), kind+".json"), installedComponent{Kind: kind, VersionLabel: pointer("manual-local-profile"), ArtifactSHA256: hash, InstalledSHA256: hash, InstalledSize: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		value, err := s.checkComponent(componentItem{Component: kind, ChecksumSHA256: &hash})
		if err != nil || value.(map[string]any)["ready"] != true {
			t.Fatal("真实预装文件应保持可用，不要求远端配置或正式版本标签", err)
		}
	}
	value, err := s.ensureComponents()
	if err != nil || value.(map[string]any)["ready"] != true || len(value.(map[string]any)["missingComponents"].([]string)) != 0 {
		t.Fatal("完整且校验通过的预装profile不应被缺少远端来源阻断", err)
	}
}
