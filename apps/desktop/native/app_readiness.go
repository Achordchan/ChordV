package main

import (
	"context"
	"encoding/json"
	"errors"
)

func (s *DesktopService) confirmAppReady(ctx context.Context, input json.RawMessage) error {
	var screen struct {
		Screen string `json:"screen"`
	}
	if err := decode(input, &screen); err != nil || screen.Screen != "login" && screen.Screen != "main" {
		return errors.New("界面就绪状态无效")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.waitStartup(ctx); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.ctx.Err(); err != nil {
		return err
	}
	if s.shell == nil || s.shell.main == nil {
		return errors.New("原生主窗口尚未创建")
	}
	s.shell.mu.Lock()
	quitting := s.shell.quitting
	s.shell.mu.Unlock()
	if quitting {
		return errors.New("应用正在退出")
	}
	if s.updateHealth != nil {
		return s.updateHealth.AppReady()
	}
	return nil
}
