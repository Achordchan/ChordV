//go:build !darwin

package main

type macUpdateHealthClient struct{}

func beginMacUpdateHealth() (*macUpdateHealthClient, error) { return nil, nil }
func (*macUpdateHealthClient) NativeReady(error)            {}
func (*macUpdateHealthClient) AppReady() error              { return nil }
func (*macUpdateHealthClient) Close()                       {}
func (*macUpdateHealthClient) Done() <-chan error           { return nil }
