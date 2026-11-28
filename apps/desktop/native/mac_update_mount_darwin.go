//go:build darwin

package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	macMountRecordName            = "mount-owned.json"
	macUpdateAttachCaptureTimeout = 125 * time.Second
	macUpdateDetachTimeout        = 70 * time.Second
	macUpdateAbortTimeout         = macUpdateAttachCaptureTimeout + macUpdateDetachTimeout + 10*time.Second
)

var errMacMountRecordMissing = errors.New("镜像归属文件不存在")

type macMountRecord struct {
	Schema       int              `json:"schema"`
	Work         string           `json:"work"`
	Mount        string           `json:"mountpoint"`
	Image        string           `json:"image"`
	ImageNode    macNodeIdentity  `json:"imageNode"`
	ImageSHA256  string           `json:"imageSha256"`
	ImageSize    int64            `json:"imageSize"`
	BootSession  string           `json:"bootSession"`
	Phase        string           `json:"phase"`
	DetachDevice string           `json:"detachDevice,omitempty"`
	Devices      []macMountDevice `json:"devices,omitempty"`
}

func readMacMountRecord(dir string) (*macMountRecord, error) {
	fd, err := unix.Open(filepath.Join(dir, macMountRecordName), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, errMacMountRecordMissing
	}
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), macMountRecordName)
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || int(st.Uid) != os.Getuid() || st.Nlink != 1 || info.Size() > 64<<10 {
		return nil, errors.New("镜像归属文件身份无效")
	}
	var r macMountRecord
	dec := json.NewDecoder(io.LimitReader(f, (64<<10)+1))
	dec.DisallowUnknownFields()
	if dec.Decode(&r) != nil {
		return nil, errors.New("镜像归属记录不足，保留工作目录等待核验")
	}
	var extra any
	_, hashErr := hex.DecodeString(r.ImageSHA256)
	if dec.Decode(&extra) != io.EOF || r.Schema != 2 || r.Work != dir || r.Mount != filepath.Join(dir, "mount") || r.Image != filepath.Join(dir, "image.dmg") || r.ImageSize <= 0 || len(r.ImageSHA256) != 64 || hashErr != nil {
		return nil, errors.New("镜像归属记录无效")
	}
	boot, err := macUpdateBootSession()
	if err != nil {
		return nil, err
	}
	if boot != r.BootSession {
		return nil, errors.New("镜像设备归属记录来自另一启动会话")
	}
	imageInfo, err := os.Lstat(r.Image)
	if err != nil {
		return nil, errors.New("镜像文件不可核验，保留归属记录")
	}
	imageStat, ok := imageInfo.Sys().(*syscall.Stat_t)
	if !ok || !imageInfo.Mode().IsRegular() || imageInfo.Mode().Perm() != 0600 || int(imageStat.Uid) != os.Getuid() || imageStat.Nlink != 1 {
		return nil, errors.New("独立镜像文件归属或权限无效")
	}
	node, err := macNode(r.Image)
	if err != nil || node != r.ImageNode {
		return nil, errors.New("镜像文件身份已变化，保留归属记录")
	}
	if err = verifyFile(r.Image, r.ImageSHA256, r.ImageSize); err != nil {
		return nil, err
	}
	return &r, nil
}

// Keep a private immutable-by-path copy: the download cache can be replaced independently.
func (p *macUpdatePlan) mountImage(ctx context.Context) error {
	if err := validateMacWork(p.Work); err != nil {
		return err
	}
	image := filepath.Join(p.Work, "image.dmg")
	if _, err := os.Lstat(image); !os.IsNotExist(err) {
		return errors.New("独立更新镜像已存在或不可核验")
	}
	if err := copyAtomicContext(ctx, p.Installer.Path, image, 0600); err != nil {
		return err
	}
	if err := verifyFile(image, p.Installer.SHA256, p.Installer.Size); err != nil {
		return err
	}
	node, err := macNode(image)
	if err != nil {
		return err
	}
	boot, err := macUpdateBootSession()
	if err != nil {
		return err
	}
	r := macMountRecord{Schema: 2, Work: p.Work, Mount: filepath.Join(p.Work, "mount"), Image: image, ImageNode: node, ImageSHA256: p.Installer.SHA256, ImageSize: p.Installer.Size, BootSession: boot, Phase: "ready"}
	images, err := macMountInventory(ctx)
	if err != nil {
		return err
	}
	for _, im := range images {
		if im.Image == image {
			return errors.New("独立镜像在本次挂载前已经attached")
		}
		for _, e := range im.Entities {
			if e.Mount == r.Mount {
				return errors.New("独立挂载点已被占用")
			}
		}
	}
	if err = durableMacUpdateJSON(filepath.Join(p.Work, macMountRecordName), r); err != nil {
		return err
	}
	if err = p.journal("mounting", "", ""); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	r.Phase = "attaching"
	if err = durableMacUpdateJSON(filepath.Join(p.Work, macMountRecordName), r); err != nil {
		return err
	}
	// Once submitted, finish the bounded attach and capture ownership before honoring cancellation.
	captureCtx, captureCancel := context.WithTimeout(context.Background(), macUpdateAttachCaptureTimeout)
	defer captureCancel()
	out, err := runMacUpdateCommand(captureCtx, 90*time.Second, "/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", r.Mount, "-plist", image)
	// An interrupted client does not prove the DiskImages backend stopped; preserve the intent.
	if err != nil {
		return err
	}
	dict, err := parsePlist(out)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(dict)
	if err != nil {
		return err
	}
	var attached macAttachedImage
	if err = json.Unmarshal(raw, &attached); err != nil {
		return err
	}
	r.Devices, err = macMountDeviceSnapshot(attached.Entities, r.Mount)
	if err != nil {
		return err
	}
	r.DetachDevice, err = macWholeImageDevice(attached.Entities)
	if err != nil {
		return err
	}
	r.Phase = "attached"
	images, err = macMountInventory(captureCtx)
	if err != nil {
		return err
	}
	present, err := r.validateInventory(images)
	if err != nil {
		return err
	}
	if !present {
		return errors.New("已挂载镜像未出现在设备清单")
	}
	if err = durableMacUpdateJSON(filepath.Join(p.Work, macMountRecordName), r); err != nil {
		return err
	}
	return ctx.Err()
}

func (r *macMountRecord) validateInventory(images []macAttachedImage) (bool, error) {
	matches := 0
	present := false
	for _, im := range images {
		if im.Image != r.Image {
			for _, entity := range im.Entities {
				if entity.Mount == r.Mount {
					return false, errors.New("挂载点已经属于另一镜像")
				}
				for _, d := range r.Devices {
					if d.Device == entity.Device {
						return false, errors.New("镜像设备号已被另一镜像复用")
					}
				}
			}
			continue
		}
		matches++
		if matches > 1 || im.UID == nil || *im.UID != int64(os.Getuid()) || im.Writable == nil || *im.Writable {
			return false, errors.New("镜像归属或只读属性不匹配")
		}
		if r.Phase == "attached" {
			whole, err := macWholeImageDevice(im.Entities)
			if err != nil || whole != r.DetachDevice {
				return false, errors.New("镜像整盘设备与归属记录不一致")
			}
		}
		devices, err := macMountDeviceSnapshot(im.Entities, r.Mount)
		if err != nil {
			return false, err
		}
		if !sameMacMountDevices(devices, r.Devices) {
			return false, errors.New("镜像设备生命周期身份已变化")
		}
		present = true
	}
	return present, nil
}

func detachMacUpdateMount(dir string) error {
	if err := validateMacWork(dir); err != nil {
		return err
	}
	r, err := readMacMountRecord(dir)
	if errors.Is(err, errMacMountRecordMissing) {
		return assertMacWorkImageAbsent(dir)
	}
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), macUpdateDetachTimeout)
	defer cancel()
	if r.Phase != "attached" && r.Phase != "ready" {
		return errors.New("镜像挂载尚无完整设备归属，保留记录")
	}
	if r.Phase == "attached" {
		if len(r.Devices) == 0 || !macUpdateDevicePath.MatchString(r.DetachDevice) || strings.Contains(strings.TrimPrefix(r.DetachDevice, "/dev/disk"), "s") {
			return errors.New("镜像设备归属不完整")
		}
		found := false
		for _, d := range r.Devices {
			found = found || d.Device == r.DetachDevice
		}
		if !found {
			return errors.New("镜像整盘设备不在归属集合")
		}
	}
	images, err := macMountInventory(ctx)
	if err != nil {
		return err
	}
	present, err := r.validateInventory(images)
	if err != nil {
		return err
	}
	if present {
		if r.Phase != "attached" {
			return errors.New("镜像提前挂载，缺少设备身份")
		}
		// hdiutil is path-based, so this fresh kernel identity check is not an atomic detach primitive.
		if _, err = runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/hdiutil", "detach", r.DetachDevice); err != nil {
			return err
		}
	}
	images, err = macMountInventory(ctx)
	if err != nil {
		return err
	}
	present, err = r.validateInventory(images)
	if err != nil {
		return err
	}
	if present {
		return errors.New("镜像设备卸载后仍attached")
	}
	if err = os.Remove(filepath.Join(dir, macMountRecordName)); err != nil {
		return err
	}
	return syncMacUpdateDirectory(dir)
}

func assertMacWorkImageAbsent(dir string) error {
	if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir || !strings.HasPrefix(filepath.Base(dir), ".chordv-mac-update-") {
		return errors.New("缺失更新目录的路径身份无效")
	}
	images, err := macMountInventory(context.Background())
	if err != nil {
		return err
	}
	for _, im := range images {
		if im.Image == filepath.Join(dir, "image.dmg") {
			return errors.New("镜像仍attached但工作目录或归属记录缺失")
		}
		for _, e := range im.Entities {
			if e.Mount == filepath.Join(dir, "mount") {
				return errors.New("挂载点仍占用但工作目录或归属记录缺失")
			}
		}
	}
	return nil
}
