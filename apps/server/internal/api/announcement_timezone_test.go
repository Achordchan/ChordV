package api

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

type announcementTimezoneOracle struct {
	Commit string `json:"commit"`
	Zones  []struct {
		Name  string `json:"name"`
		Cases []struct {
			Input    string `json:"input"`
			Expected string `json:"expected"`
		} `json:"cases"`
	} `json:"zones"`
}

func TestAnnouncementTimezoneMatchesOriginalInFreshProcesses(t *testing.T) {
	raw, err := os.ReadFile("testdata/announcement-timezone-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var oracle announcementTimezoneOracle
	if err = json.Unmarshal(raw, &oracle); err != nil || oracle.Commit != "397a64d" || len(oracle.Zones) != 4 {
		t.Fatal("旧时区Date实证无效", err)
	}
	if child := os.Getenv("CHORDV_ANNOUNCEMENT_TZ_CHILD"); child != "" {
		if os.Getenv("TZ") != child || time.Local.String() != child {
			t.Fatal("子进程没有使用独立TZ", child, os.Getenv("TZ"), time.Local.String())
		}
		matched := false
		for _, zone := range oracle.Zones {
			if zone.Name != child {
				continue
			}
			matched = true
			for _, sample := range zone.Cases {
				t.Run(sample.Input, func(t *testing.T) {
					actual, err := announcementDate(sample.Input)
					if err != nil {
						t.Fatal(err)
					}
					got, gotErr := time.Parse(time.RFC3339Nano, actual)
					want, wantErr := time.Parse(time.RFC3339Nano, sample.Expected)
					if gotErr != nil || wantErr != nil || !got.Equal(want) {
						t.Errorf("旧Date时区差异: TZ=%s input=%s got=%s want=%s", child, sample.Input, actual, sample.Expected)
					}
				})
			}
		}
		if !matched {
			t.Fatal("未知时区子进程", child)
		}
		return
	}
	for _, zone := range oracle.Zones {
		t.Run(zone.Name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestAnnouncementTimezoneMatchesOriginalInFreshProcesses$", "-test.v")
			for _, entry := range os.Environ() {
				if !strings.HasPrefix(entry, "TZ=") && !strings.HasPrefix(entry, "CHORDV_ANNOUNCEMENT_TZ_CHILD=") {
					command.Env = append(command.Env, entry)
				}
			}
			command.Env = append(command.Env, "TZ="+zone.Name, "CHORDV_ANNOUNCEMENT_TZ_CHILD="+zone.Name)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("独立TZ子进程失败: %v\n%s", err, output)
			}
			t.Logf("TZ=%s：%d个原Date calendar/DST/显式时区对照通过；未修改全局time.Local", zone.Name, len(zone.Cases))
		})
	}
}
