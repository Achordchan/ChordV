package main

import (
	"errors"
	"strconv"
	"strings"
)

func linuxProcessStarttime(stat []byte, pid int) (string, error) {
	text := string(stat)
	left, right := strings.IndexByte(text, '('), strings.LastIndexByte(text, ')')
	if pid <= 0 || left < 1 || right < left || right+1 >= len(text) {
		return "", errors.New("Linux进程stat结构无效")
	}
	actual, err := strconv.Atoi(strings.TrimSpace(text[:left]))
	if err != nil || actual != pid {
		return "", errors.New("Linux进程stat PID不一致")
	}
	// comm is parenthesized and may itself contain spaces and parentheses.
	// Fields after its final ')' start at field 3; starttime is exactly field 22.
	fields := strings.Fields(text[right+1:])
	if len(fields) < 20 || len(fields[0]) != 1 {
		return "", errors.New("Linux进程stat缺少启动时间")
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return "", errors.New("Linux进程启动时间无效")
	}
	return strconv.Itoa(pid) + ":" + strconv.FormatUint(start, 10), nil
}
