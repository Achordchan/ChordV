//go:build !darwin

package main

import "os"

func beginMacDesktopLaunch(*macUpdateHealthClient) (*os.File, error) { return nil, nil }
