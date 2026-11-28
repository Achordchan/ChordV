//go:build darwin && !e2e

package main

import "errors"

func macUpdateRestartExtra(appConfig) ([]string, error) { return nil, nil }
func validateMacUpdateRestartExtra(p *macUpdatePlan) error {
	if len(p.ExtraRestartEnvironment) != 0 {
		return errors.New("普通构建不允许附加重启环境")
	}
	return nil
}
