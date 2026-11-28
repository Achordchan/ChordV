//go:build darwin && e2e

package main

import (
	"errors"
	"os"
	"strings"
)

func macUpdateRestartExtra(cfg appConfig) ([]string, error) {
	state := os.Getenv("CHORDV_E2E_PROXY_STATE")
	if state == "" {
		return nil, nil
	}
	if _, err := newE2EFileProxy(state, cfg, buildMode); err != nil {
		return nil, err
	}
	return []string{"CHORDV_E2E_PROXY_STATE=" + state}, nil
}
func validateMacUpdateRestartExtra(p *macUpdatePlan) error {
	if len(p.ExtraRestartEnvironment) == 0 {
		return nil
	}
	if len(p.ExtraRestartEnvironment) != 1 || !strings.HasPrefix(p.ExtraRestartEnvironment[0], "CHORDV_E2E_PROXY_STATE=") {
		return errors.New("独立重启环境不在白名单")
	}
	_, err := newE2EFileProxy(strings.TrimPrefix(p.ExtraRestartEnvironment[0], "CHORDV_E2E_PROXY_STATE="), appConfig{DataDir: p.DataDir, APIBase: p.APIBase}, buildMode)
	return err
}
