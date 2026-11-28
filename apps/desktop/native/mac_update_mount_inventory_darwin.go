//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

type macAttachedEntity struct {
	Device string `json:"dev-entry"`
	Mount  string `json:"mount-point"`
	Hint   string `json:"content-hint"`
}
type macAttachedImage struct {
	Image    string              `json:"image-path"`
	UID      *int64              `json:"owner-uid"`
	Writable *bool               `json:"writeable"`
	Entities []macAttachedEntity `json:"system-entities"`
}
type macMountDevice struct {
	Device     string `json:"device"`
	RegistryID uint64 `json:"registryId"`
}

func macMountInventory(ctx context.Context) ([]macAttachedImage, error) {
	out, err := runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/hdiutil", "info", "-plist")
	if err != nil {
		return nil, err
	}
	dict, err := parsePlist(out)
	if err != nil {
		return nil, err
	}
	if _, ok := dict["images"].([]any); !ok {
		return nil, errors.New("镜像设备清单缺少images")
	}
	raw, err := json.Marshal(dict)
	if err != nil {
		return nil, err
	}
	var inventory struct {
		Images []macAttachedImage `json:"images"`
	}
	if err = json.Unmarshal(raw, &inventory); err != nil {
		return nil, err
	}
	return inventory.Images, nil
}

func macMountDeviceSnapshot(entities []macAttachedEntity, mount string) ([]macMountDevice, error) {
	if len(entities) == 0 || len(entities) > 32 {
		return nil, errors.New("镜像设备实体数量无效")
	}
	devices := make([]macMountDevice, 0, len(entities))
	seen := map[string]bool{}
	for _, e := range entities {
		if seen[e.Device] || e.Mount != "" && e.Mount != mount {
			return nil, errors.New("镜像设备或挂载点不唯一")
		}
		id, err := macUpdateDeviceID(e.Device)
		if err != nil {
			return nil, err
		}
		seen[e.Device] = true
		devices = append(devices, macMountDevice{e.Device, id})
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].Device < devices[j].Device })
	return devices, nil
}

func sameMacMountDevices(a, b []macMountDevice) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func macWholeImageDevice(entities []macAttachedEntity) (string, error) {
	whole := ""
	scheme := ""
	count := 0
	for _, e := range entities {
		if !macUpdateDevicePath.MatchString(e.Device) || strings.Contains(strings.TrimPrefix(e.Device, "/dev/disk"), "s") {
			continue
		}
		whole = e.Device
		count++
		if e.Hint == "GUID_partition_scheme" || e.Hint == "Apple_partition_scheme" {
			if scheme != "" {
				return "", errors.New("镜像包含多个分区表设备")
			}
			scheme = e.Device
		}
	}
	if scheme != "" {
		return scheme, nil
	}
	if count == 1 {
		return whole, nil
	}
	return "", errors.New("挂载未返回唯一整盘设备")
}
