//go:build darwin && e2e

package main

import (
	"reflect"
	"testing"
)

func TestMacUpdateRestartKeepsExplicitFileProxyIsolationOnly(t *testing.T) {
	state, cfg, _ := e2eProxyFixture(t)
	t.Setenv("CHORDV_E2E_PROXY_STATE", state)
	t.Setenv("MYGO_AUTOMATION", "must-not-reach-restarted-app")
	extra, err := macUpdateRestartExtra(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(extra, []string{"CHORDV_E2E_PROXY_STATE=" + state}) {
		t.Fatal("unexpected restart environment", extra)
	}
	p := macUpdatePlan{DataDir: cfg.DataDir, APIBase: cfg.APIBase, ExtraRestartEnvironment: extra}
	if err = validateMacUpdateRestartExtra(&p); err != nil {
		t.Fatal(err)
	}
	p.ExtraRestartEnvironment = append(extra, "MYGO_AUTOMATION=forbidden")
	if err = validateMacUpdateRestartExtra(&p); err == nil {
		t.Fatal("unapproved restart environment accepted")
	}
}
