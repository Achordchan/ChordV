//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

type macUpdateLaunchError struct {
	cause        error
	rollbackSafe bool
}

func (e *macUpdateLaunchError) Error() string { return e.cause.Error() }
func (e *macUpdateLaunchError) Unwrap() error { return e.cause }
func macUpdateLaunchRollbackSafe(err error) bool {
	var failure *macUpdateLaunchError
	return errors.As(err, &failure) && failure.rollbackSafe
}

var macWorkspaceLibrary struct {
	sync.Once
	err error
}

func macLaunchString(value string) objc.ID {
	return objc.ID(objc.GetClass("NSString")).Send(objc.RegisterName("stringWithUTF8String:"), value)
}

type macLaunchResult struct {
	owned *macUpdateLaunchedProcess
	err   error
}

// NSWorkspace returns the actual new application PID; `open` only returns a launcher status.
func launchMacUpdateApplication(ctx context.Context, bundle macBundleInfo, environment []string) (*macUpdateLaunchedProcess, error) {
	if err := ctx.Err(); err != nil {
		return nil, &macUpdateLaunchError{err, true}
	}
	if bundle.Path == "" || bundle.Executable == "" {
		return nil, &macUpdateLaunchError{errors.New("缺少新应用启动身份"), true}
	}
	for _, entry := range environment {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || key == "" || strings.ContainsRune(entry, '\x00') {
			return nil, &macUpdateLaunchError{errors.New("更新启动环境无效"), true}
		}
	}
	macWorkspaceLibrary.Do(func() {
		_, macWorkspaceLibrary.err = purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	})
	if macWorkspaceLibrary.err != nil {
		return nil, &macUpdateLaunchError{macWorkspaceLibrary.err, true}
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool := objc.ID(objc.GetClass("NSAutoreleasePool")).Send(objc.RegisterName("new"))
	defer pool.Send(objc.RegisterName("drain"))
	cfg := objc.ID(objc.GetClass("NSWorkspaceOpenConfiguration")).Send(objc.RegisterName("configuration"))
	cfg.Send(objc.RegisterName("setCreatesNewApplicationInstance:"), true)
	cfg.Send(objc.RegisterName("setAllowsRunningApplicationSubstitution:"), false)
	cfg.Send(objc.RegisterName("setPromptsUserIfNeeded:"), false)
	cfg.Send(objc.RegisterName("setAddsToRecentItems:"), false)
	env := objc.ID(objc.GetClass("NSMutableDictionary")).Send(objc.RegisterName("dictionary"))
	for _, entry := range environment {
		key, value, _ := strings.Cut(entry, "=")
		env.Send(objc.RegisterName("setObject:forKey:"), macLaunchString(value), macLaunchString(key))
	}
	cfg.Send(objc.RegisterName("setEnvironment:"), env)
	url := objc.ID(objc.GetClass("NSURL")).Send(objc.RegisterName("fileURLWithPath:"), macLaunchString(bundle.Path))
	result := make(chan macLaunchResult, 1)
	block := objc.NewBlock(func(_ objc.Block, app, failure objc.ID) {
		if app == 0 {
			message := "LaunchServices未返回应用进程"
			if failure != 0 {
				message = objc.Send[string](failure.Send(objc.RegisterName("localizedDescription")), objc.RegisterName("UTF8String"))
			}
			result <- macLaunchResult{err: &macUpdateLaunchError{errors.New(message), failure != 0}}
			return
		}
		pid := int(objc.Send[int32](app, objc.RegisterName("processIdentifier")))
		if objc.Send[bool](app, objc.RegisterName("isTerminated")) {
			result <- macLaunchResult{err: &macUpdateLaunchError{errors.New("新应用已在启动回调前退出"), true}}
			return
		}
		if pid <= 1 {
			result <- macLaunchResult{err: &macUpdateLaunchError{errors.New("LaunchServices返回无效PID"), false}}
			return
		}
		owned, err := ownMacUpdateProcess(pid, bundle.Executable)
		if err != nil {
			result <- macLaunchResult{err: &macUpdateLaunchError{fmt.Errorf("无法确认新应用进程归属：%w", err), false}}
			return
		}
		result <- macLaunchResult{owned: owned}
	})
	// AppKit copies the block until completion. Its copy outlives this scoped reference,
	// including an indeterminate timeout where the late callback must not become dangling.
	defer block.Release()
	objc.ID(objc.GetClass("NSWorkspace")).Send(objc.RegisterName("sharedWorkspace")).Send(objc.RegisterName("openApplicationAtURL:configuration:completionHandler:"), url, cfg, block)
	select {
	case outcome := <-result:
		return outcome.owned, outcome.err
	case <-ctx.Done():
		// The OS may still launch after this timeout. Never authorize a rollback here.
		go func() {
			outcome := <-result
			if outcome.owned != nil {
				outcome.owned.Close()
			}
		}()
		return nil, &macUpdateLaunchError{fmt.Errorf("启动结果不确定，保留应用备份：%w", ctx.Err()), false}
	}
}
