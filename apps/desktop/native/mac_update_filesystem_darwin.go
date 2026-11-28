//go:build darwin

package main

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

type macFilesystemIdentity struct {
	VolumeUUID string `json:"volumeUuid"`
	FileID     uint64 `json:"fileId"`
	BirthSec   int64  `json:"birthSec"`
	BirthNsec  int64  `json:"birthNsec"`
}

type macUpdateFilesystem struct {
	Current   macFilesystemIdentity `json:"current"`
	Candidate macFilesystemIdentity `json:"candidate"`
	Work      macFilesystemIdentity `json:"work"`
	Parent    macFilesystemIdentity `json:"parent"`
}

var macFilesystemAPI struct {
	sync.Once
	getattr func(int32, *unix.Attrlist, *byte, uint64, uint32) int32
	errno   func() *int32
	err     error
}

func macFilesystemAttributes(fd int, attributes unix.Attrlist, size int) ([]byte, error) {
	macFilesystemAPI.Do(func() {
		var library uintptr
		library, macFilesystemAPI.err = purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if macFilesystemAPI.err == nil {
			purego.RegisterLibFunc(&macFilesystemAPI.getattr, library, "fgetattrlist")
			purego.RegisterLibFunc(&macFilesystemAPI.errno, library, "__error")
		}
	})
	if macFilesystemAPI.err != nil {
		return nil, macFilesystemAPI.err
	}
	data := make([]byte, size)
	// errno is thread-local; read it on the same native thread as fgetattrlist.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if macFilesystemAPI.getattr(int32(fd), &attributes, &data[0], uint64(len(data)), unix.FSOPT_NOFOLLOW) != 0 {
		return nil, syscall.Errno(*macFilesystemAPI.errno())
	}
	if binary.LittleEndian.Uint32(data) != uint32(size) {
		return nil, errors.New("文件系统身份属性长度不匹配")
	}
	return data[4:], nil
}

func readMacFilesystemNode(path string) (macFilesystemIdentity, macNodeIdentity, error) {
	var identity macFilesystemIdentity
	var node macNodeIdentity
	canonical, err := macCanonical(path)
	if err != nil || canonical != path {
		return identity, node, errors.New("文件系统身份路径必须规范且不能经过符号链接")
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return identity, node, err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	var fs unix.Statfs_t
	if err = unix.Fstat(fd, &stat); err != nil {
		return identity, node, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return identity, node, errors.New("文件系统身份对象不是目录")
	}
	if err = unix.Fstatfs(fd, &fs); err != nil {
		return identity, node, err
	}
	end := 0
	for end < len(fs.Mntonname) && fs.Mntonname[end] != 0 {
		end++
	}
	if end == 0 || end == len(fs.Mntonname) {
		return identity, node, errors.New("卷挂载点无效")
	}
	mount := make([]byte, end)
	for i := range mount {
		mount[i] = byte(fs.Mntonname[i])
	}
	volume, err := unix.Open(string(mount), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return identity, node, err
	}
	defer unix.Close(volume)
	var volumeFS unix.Statfs_t
	if err = unix.Fstatfs(volume, &volumeFS); err != nil || volumeFS.Fsid != fs.Fsid {
		return identity, node, errors.New("卷挂载点与目录FD不一致")
	}
	uuid, err := macFilesystemAttributes(volume, unix.Attrlist{Bitmapcount: 5, Volattr: unix.ATTR_VOL_INFO | unix.ATTR_VOL_UUID}, 20)
	if err != nil {
		return identity, node, err
	}
	fileID, err := macFilesystemAttributes(fd, unix.Attrlist{Bitmapcount: 5, Commonattr: unix.ATTR_CMN_FILEID}, 12)
	if err != nil {
		return identity, node, err
	}
	identity = macFilesystemIdentity{VolumeUUID: hex.EncodeToString(uuid), FileID: binary.LittleEndian.Uint64(fileID), BirthSec: stat.Btim.Sec, BirthNsec: stat.Btim.Nsec}
	if identity.VolumeUUID == "00000000000000000000000000000000" || identity.FileID == 0 || identity.FileID != stat.Ino || identity.BirthSec <= 0 || identity.BirthNsec < 0 || identity.BirthNsec >= 1e9 {
		return macFilesystemIdentity{}, node, errors.New("卷UUID或持久文件ID无效")
	}
	node = macNodeIdentity{Device: uint64(stat.Dev), Inode: stat.Ino}
	return identity, node, nil
}

func readMacSwapDirectories(target, work string) (macSwapDirectories, error) {
	if err := validateMacWork(work); err != nil {
		return macSwapDirectories{}, err
	}
	parent, parentNode, err := readMacFilesystemNode(filepath.Dir(target))
	if err != nil {
		return macSwapDirectories{}, err
	}
	workspace, workNode, err := readMacFilesystemNode(work)
	if err != nil {
		return macSwapDirectories{}, err
	}
	if workspace.VolumeUUID != parent.VolumeUUID {
		return macSwapDirectories{}, errors.New("更新工作目录不在应用所在卷")
	}
	return macSwapDirectories{Parent: parentNode, Work: workNode, ParentStable: parent, WorkStable: workspace}, nil
}

func (p *macUpdatePlan) verifyBoundDirectories() error {
	if p.Directories == nil {
		return errors.New("更新交接计划缺少父目录和工作目录的原始身份")
	}
	actual, err := readMacSwapDirectories(p.Current.Path, p.Work)
	if err != nil || actual != *p.Directories {
		return errors.Join(err, errors.New("更新交接的父目录或工作目录已变化，已保留更新资料"))
	}
	return nil
}

func captureMacUpdateFilesystem(p *macUpdatePlan, candidate macBundleInfo) (*macUpdateFilesystem, error) {
	result := &macUpdateFilesystem{}
	for _, item := range []struct {
		path string
		want *macNodeIdentity
		out  *macFilesystemIdentity
	}{{p.Current.Path, &p.Current.Node, &result.Current}, {candidate.Path, &candidate.Node, &result.Candidate}, {p.Work, nil, &result.Work}, {filepath.Dir(p.Current.Path), nil, &result.Parent}} {
		identity, node, err := readMacFilesystemNode(item.path)
		if err != nil {
			return nil, fmt.Errorf("更新目录持久身份读取失败：%w", err)
		}
		if item.want != nil && node != *item.want {
			return nil, errors.New("记录持久身份时应用目录已改变")
		}
		*item.out = identity
	}
	for _, item := range []macFilesystemIdentity{result.Current, result.Candidate, result.Work} {
		if item.VolumeUUID != result.Parent.VolumeUUID {
			return nil, errors.New("更新目录不在同一持久卷")
		}
	}
	return result, nil
}
