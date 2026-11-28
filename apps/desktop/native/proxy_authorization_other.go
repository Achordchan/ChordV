//go:build !darwin

package main

func platformPrepareProxyAuthorization() error         { return nil }
func platformWatchdogAuthorization() string            { return "" }
func platformImportWatchdogAuthorization(string) error { return nil }
