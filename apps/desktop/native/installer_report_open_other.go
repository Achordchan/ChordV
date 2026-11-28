//go:build !darwin && !linux

package main

import "os"

const installReportOpenFlags = os.O_RDONLY
