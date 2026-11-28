package main

import (
	"fmt"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

type shellSummary struct {
	Status             string   `json:"status"`
	SignedIn           bool     `json:"signedIn"`
	NodeName           *string  `json:"nodeName"`
	PrimaryActionLabel string   `json:"primaryActionLabel"`
	Mode               *string  `json:"mode"`
	Modes              []string `json:"modes"`
	Nodes              []struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		LatencyMs *int   `json:"latencyMs"`
		Status    string `json:"status"`
	} `json:"nodes"`
	SelectedNodeID *string `json:"selectedNodeId"`
	TrafficLine    *string `json:"trafficLine"`
}

type desktopShell struct {
	service       *DesktopService
	main          *mygo.Window
	tray          *mygo.Tray
	mu            sync.Mutex
	summary       shellSummary
	support       *mygo.Window
	supportEpoch  uint64
	supportLabel  string
	supportOrigin string
	supportReady  bool
	quitting      bool
	resizeMu      sync.Mutex
}

func newDesktopShell(service *DesktopService) *desktopShell {
	shell := &desktopShell{service: service, supportEpoch: 1}
	height := 440
	if platformName() == "macos" {
		height += 28
	}
	shell.main = mygo.NewWindow(mygo.WindowOptions{Title: applicationName(), URL: "/", Width: 660, Height: height, UseContentSize: true, MinWidth: 660, MinHeight: height, DisableResize: true, DisableMaximize: true, TitleBarStyle: mygo.TitleBarHidden, Hidden: true, BackgroundColor: "#f4f6fa"})
	shell.main.OnReadyToShow(shell.main.Show)
	shell.main.OnClose(func(event *mygo.CloseEvent) {
		shell.mu.Lock()
		quitting := shell.quitting
		shell.mu.Unlock()
		if !quitting {
			event.PreventDefault()
			shell.main.Hide()
		}
	})
	shell.main.OnFocus(func() { service.publish("chordv://window-focus", true) })
	shell.main.OnBlur(func() { service.publish("chordv://window-focus", false) })
	tray, err := mygo.NewTray(mygo.TrayOptions{ID: "chordv-local", Icon: appIcon, ToolTip: "ChordV 本地调试"})
	if err == nil {
		shell.tray = tray
	} else {
		service.publish("chordv://shell-tray-unavailable", "系统托盘创建失败，关闭窗口后请从程序坞重新打开")
	}
	shell.update(shellSummary{Status: "idle", PrimaryActionLabel: "打开主界面连接"})
	return shell
}

func (s *desktopShell) show()      { s.main.Show(); s.main.Focus(); s.main.FlashFrame(false) }
func (s *desktopShell) hide()      { s.main.Hide() }
func (s *desktopShell) allowQuit() { s.mu.Lock(); s.quitting = true; s.mu.Unlock() }
func (s *desktopShell) quit()      { s.allowQuit(); mygo.App.Quit() }
func (s *desktopShell) resize(signedIn, animate bool) {
	s.resizeMu.Lock()
	defer s.resizeMu.Unlock()
	width, height := 660, 440
	if signedIn {
		width, height = 820, 560
	}
	if platformName() == "macos" {
		height += 28
	}
	bounds := s.main.ContentBounds()
	from := bounds
	bounds.X += (bounds.Width - width) / 2
	bounds.Y += (bounds.Height - height) / 2
	bounds.Width = width
	bounds.Height = height
	area := mygo.Screen.DisplayMatching(bounds).WorkArea
	if area.Width > 0 && area.Height > 0 {
		bounds.X = max(area.X, min(bounds.X, area.X+area.Width-bounds.Width))
		bounds.Y = max(area.Y, min(bounds.Y, area.Y+area.Height-bounds.Height))
	}
	s.main.SetMinimumSize(660, 440)
	if animate && (from.Width != bounds.Width || from.Height != bounds.Height) {
		started := time.Now()
		for {
			progress := min(time.Since(started).Seconds()/0.24, 1)
			eased := 1 - (1-progress)*(1-progress)*(1-progress)
			mix := func(a, b int) int { return a + int(float64(b-a)*eased) }
			s.main.SetContentBounds(mygo.Rectangle{X: mix(from.X, bounds.X), Y: mix(from.Y, bounds.Y), Width: mix(from.Width, bounds.Width), Height: mix(from.Height, bounds.Height)})
			if progress >= 1 {
				break
			}
			time.Sleep(16 * time.Millisecond)
		}
	} else {
		s.main.SetContentBounds(bounds)
	}
	s.main.SetMinimumSize(width, height)
}
func (s *desktopShell) update(summary shellSummary) {
	s.mu.Lock()
	s.summary = summary
	s.mu.Unlock()
	click := func(action string) func(*mygo.MenuItem, *mygo.Window) {
		return func(*mygo.MenuItem, *mygo.Window) {
			s.show()
			s.service.publish("chordv://shell-action", map[string]string{"action": action})
		}
	}
	status := "未连接"
	if summary.Status == "connected" {
		status = "已连接"
	}
	if summary.Status == "connecting" {
		status = "连接中"
	}
	items := []*mygo.MenuItem{{Label: "ChordV · " + status, Disabled: true}, {Label: "显示主窗口", Click: func(*mygo.MenuItem, *mygo.Window) { s.show() }}, {Label: summary.PrimaryActionLabel, Click: click("toggle-connection"), Disabled: !summary.SignedIn}, {Label: "查看日志", Click: click("open-logs")}}
	if summary.NodeName != nil {
		items = append(items, &mygo.MenuItem{Label: *summary.NodeName, Disabled: true})
	}
	if summary.TrafficLine != nil {
		items = append(items, &mygo.MenuItem{Label: *summary.TrafficLine, Disabled: true})
	}
	if len(summary.Modes) > 0 {
		modes := []*mygo.MenuItem{}
		for _, mode := range summary.Modes {
			mode := mode
			label := map[string]string{"rule": "规则模式", "global": "全局代理", "direct": "全部直连"}[mode]
			if label == "" {
				label = mode
			}
			modes = append(modes, &mygo.MenuItem{Label: label, Type: mygo.MenuItemRadio, Checked: summary.Mode != nil && *summary.Mode == mode, Click: func(*mygo.MenuItem, *mygo.Window) { s.selectShell("setMode", mode) }})
		}
		items = append(items, &mygo.MenuItem{Label: "代理模式", Submenu: modes})
	}
	if len(summary.Nodes) > 0 {
		nodes := []*mygo.MenuItem{}
		for _, node := range summary.Nodes {
			node := node
			label := node.Name
			if node.LatencyMs != nil {
				label += fmt.Sprintf(" · %d ms", *node.LatencyMs)
			}
			nodes = append(nodes, &mygo.MenuItem{Label: label, Type: mygo.MenuItemRadio, Checked: summary.SelectedNodeID != nil && *summary.SelectedNodeID == node.ID, Click: func(*mygo.MenuItem, *mygo.Window) { s.selectShell("selectNode", node.ID) }})
		}
		items = append(items, &mygo.MenuItem{Label: "选择节点", Submenu: nodes})
	}
	items = append(items, &mygo.MenuItem{Type: mygo.MenuItemSeparator}, &mygo.MenuItem{Label: "退出 ChordV", Click: func(*mygo.MenuItem, *mygo.Window) {
		go func() {
			if s.service.shutdown() == nil {
				s.quit()
			}
		}()
	}})
	menu := mygo.NewMenu(items)
	if s.tray != nil {
		s.tray.SetToolTip("ChordV · " + status)
		s.tray.SetMenu(menu)
	}
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{{Label: "ChordV", Submenu: []*mygo.MenuItem{{Label: "显示主窗口", Click: func(*mygo.MenuItem, *mygo.Window) { s.show() }}, {Label: "隐藏窗口", Accelerator: "CmdOrCtrl+H", Click: func(*mygo.MenuItem, *mygo.Window) { s.hide() }}, {Label: "关闭窗口", Accelerator: "CmdOrCtrl+W", Click: func(*mygo.MenuItem, *mygo.Window) { s.hide() }}, {Label: "退出 ChordV", Accelerator: "CmdOrCtrl+Q", Click: func(*mygo.MenuItem, *mygo.Window) {
		go func() {
			if s.service.shutdown() == nil {
				s.quit()
			}
		}()
	}}}}, {Role: mygo.RoleEditMenu}, {Role: mygo.RoleWindowMenu}}))
}
func (s *desktopShell) selectShell(method, value string) {
	s.service.publish("chordv://shell-selection", map[string]string{"method": method, "value": value})
	go func() {
		_, _ = s.main.Page().Eval(fmt.Sprintf("window.__CHORDV_DESKTOP_SHELL__?.[%q]?.(%q)", method, value))
	}()
}
