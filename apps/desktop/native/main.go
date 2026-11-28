package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

//go:embed resources/icon.png
var appIcon []byte

var NativeEvents = mygo.NewEvent[NativeEvent]("native-event")

const macRecoveryWorkerArgument = "--chordv-mac-recovery-worker"

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "--chordv-build-info" {
		if len(os.Args) != 2 {
			log.Fatal("构建信息命令不接受其他参数")
		}
		build, err := strconv.ParseInt(embeddedBuildNumber, 10, 64)
		if err != nil || build < 0 {
			log.Fatal("内嵌构建号无效")
		}
		if err = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": mygo.App.Version(), "build": build, "mode": buildMode, "platform": platformName(), "architecture": architectureName()}); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) >= 2 && os.Args[1] == "--chordv-mac-update-helper" {
		if len(os.Args) != 3 {
			log.Fatal("更新交接参数无效")
		}
		if err := runMacUpdateHelper(os.Args[2]); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) >= 2 && os.Args[1] == macRecoveryWorkerArgument {
		if len(os.Args) != 2 {
			log.Fatal("独立恢复助手不接受路径或其他参数")
		}
		if err := runMacProtectedRecoveryWorker(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "--proxy-watchdog" {
		if err := runProxyWatchdog(os.Args[2]); err != nil {
			_ = atomicJSON(filepath.Join(os.Args[2], "watchdog-error.json"), map[string]string{"message": err.Error(), "createdAt": time.Now().UTC().Format(time.RFC3339)})
			log.Print("代理恢复未完成：", err)
		}
		return
	}
	if err := runDesktopApplication(); err != nil {
		log.Fatal(err)
	}
}

func runDesktopApplication() error {
	health, err := beginMacUpdateHealth()
	if err != nil {
		return err
	}
	if health != nil {
		defer health.Close()
	}
	launchGate, err := beginMacDesktopLaunch(health)
	if err != nil {
		return err
	}
	if launchGate != nil {
		defer launchGate.Close()
	}
	cfg, err := loadConfig()
	if err != nil {
		if health != nil {
			health.NativeReady(err)
		}
		return err
	}
	service := newDesktopService(cfg)
	service.updateHealth = health
	service.startupDone = make(chan struct{})
	mygo.App.SetName(applicationName())
	mygo.Bind(service)
	var quitting atomic.Bool
	allowQuit := func() {
		if service.shell != nil {
			service.shell.allowQuit()
		}
		quitting.Store(true)
	}
	mygo.App.WhenReady(func() {
		if !mygo.App.RequestSingleInstanceLock() {
			if health != nil {
				health.NativeReady(errors.New("更新候选未取得单实例锁"))
			}
			allowQuit()
			close(service.startupDone)
			mygo.App.Quit()
			return
		}
		service.shell = newDesktopShell(service)
		service.emit = func(event NativeEvent) { _ = NativeEvents.Emit(service.shell.main, event) }
		if health != nil {
			go func() {
				if err := <-health.Done(); err != nil {
					log.Print("更新就绪确认失败：", err)
					service.publish("chordv://startup-recovery-failed", "更新就绪确认失败："+err.Error())
					if err := service.shutdown(); err != nil {
						log.Print("更新候选退出清理未完成：", err)
						return
					}
					allowQuit()
					mygo.App.Quit()
				}
			}()
		}
		go func() {
			err := service.startup()
			service.mu.Lock()
			service.startupErr = err
			service.mu.Unlock()
			close(service.startupDone)
			if errors.Is(err, errMacRecoveryExitArmed) {
				if err := service.shutdown(); err != nil {
					log.Print("恢复交接退出清理未完成：", err)
					return
				}
				allowQuit()
				mygo.App.Quit()
				return
			}
			if health != nil {
				health.NativeReady(err)
			}
			if err != nil {
				service.publish("chordv://startup-recovery-failed", err.Error())
			}
		}()
		mygo.App.OnSecondInstance(func([]string, string) { service.shell.show() })
		mygo.App.OnActivate(func(bool) { service.shell.show() })
	})
	mygo.App.OnBeforeQuit(func(event *mygo.QuitEvent) {
		if quitting.Load() {
			return
		}
		if event.SessionEnding {
			if err := service.shutdown(); err != nil {
				log.Print(err)
			}
			allowQuit()
			return
		}
		event.PreventDefault()
		go func() {
			if err := service.shutdown(); err == nil {
				allowQuit()
				mygo.App.Quit()
			}
		}()
	})
	return mygo.App.Run()
}
