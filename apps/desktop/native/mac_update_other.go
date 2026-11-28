//go:build !darwin

package main

import (
	"context"
	"errors"
)

type macUpdateHandoff struct{}

func lockRuntimeMutation(string) (func(), error) { return func() {}, nil }

func macUpdateJournalPresent(string) (bool, error) { return false, nil }

func requireUnusedMacUpdateJournal(string) error { return nil }

func recoverMacUpdateOnStartup(context.Context, appConfig, *macUpdateHealthClient, bool) error {
	return nil
}

func runMacProtectedRecoveryWorker() error { return errors.New("独立恢复助手仅适用于 macOS") }

func (s *DesktopService) prepareMacUpdate(context.Context, string) (any, error) {
	return nil, errors.New("自动应用替换仅适用于 macOS")
}

func (s *DesktopService) commitMacUpdate(context.Context) (any, error) {
	return nil, errors.New("自动应用替换仅适用于 macOS")
}

func (s *DesktopService) abortMacUpdate() error { return nil }

func runMacUpdateHelper(string) error {
	return errors.New("自动应用替换仅适用于 macOS")
}
