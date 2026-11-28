//go:build linux

package main

import "testing"

func startDconfRealityServer(t *testing.T, binary string, echoPort int) (runtimeOutbound, dconfTestProcess) {
	t.Helper()
	outbound, peer := startRealityTestPeer(t, binary, echoPort)
	return outbound, captureDconfProcess(t, peer.Process.Pid)
}
