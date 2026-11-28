package api

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func cleanupFixtureFile(a *testAPI, name string) string {
	a.t.Helper()
	dir := filepath.Join(a.server.Config.DataDir, "tmp")
	if err := os.MkdirAll(dir, 0700); err != nil {
		a.t.Fatal(err)
	}
	return filepath.Join(dir, name)
}

func cleanupFixtureJob(a *testAPI, path string, at time.Time) Object {
	a.t.Helper()
	job, err := insert(context.Background(), a.server.DB, "FileCleanupJob", Object{"path": path, "reason": "本机私有目录清理契约", "nextAttemptAt": at.UTC().Format(time.RFC3339Nano)})
	if err != nil {
		a.t.Fatal(err)
	}
	return job
}

func cleanupHTTPJob(a *testAPI, id string) Object {
	a.t.Helper()
	state := a.call("GET", "/api/admin/storage", nil, 200)
	for _, value := range state["cleanupJobs"].([]any) {
		job := value.(map[string]any)
		if job["id"] == id {
			return job
		}
	}
	a.t.Fatal("未找到持久化清理任务", id)
	return nil
}

func TestFileCleanupRetryPersistsFailureAndBackoff(t *testing.T) {
	a := newTestAPI(t)
	path := cleanupFixtureFile(a, "recent.part")
	if err := os.WriteFile(path, []byte("fresh file must survive"), 0600); err != nil {
		t.Fatal(err)
	}
	// Only mtime is old; real ctime remains fresh and must still block removal.
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(path, past, past); err != nil {
		t.Fatal(err)
	}
	job := cleanupFixtureJob(a, path, time.Now().Add(time.Hour))
	endpoint := "/api/admin/storage/cleanup/" + text(job, "id") + "/retry"
	for attempt := 1; attempt <= 2; attempt++ {
		before := time.Now()
		a.call("POST", endpoint, Object{}, 200)
		state := cleanupHTTPJob(a, text(job, "id"))
		next, err := parseTimestamp(text(state, "nextAttemptAt"))
		delay := time.Duration(1<<(attempt-1)) * time.Minute
		if err != nil || next.Before(before.Add(delay-time.Second)) || next.After(before.Add(delay+time.Second)) || state["attempts"] != float64(attempt) || !strings.Contains(text(state, "lastError"), "24小时") {
			t.Fatal("失败重试必须持久化次数、错误和指数退避", state, err)
		}
		if data, err := os.ReadFile(path); err != nil || string(data) != "fresh file must survive" {
			t.Fatal("人工重试绕过了真实ctime保护", err)
		}
	}
	// Missing files converge idempotently, without relaxing the age check.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	a.call("POST", endpoint, Object{}, 200)
	if state := a.call("GET", "/api/admin/storage", nil, 200); state["cleanupTotal"] != float64(0) {
		t.Fatal("文件已不存在后，清理任务没有收敛")
	}
	a.call("POST", endpoint, Object{}, 200)
}

func TestFileCleanupRestoresDeadlineAndFailureAfterServerRestart(t *testing.T) {
	a := newTestAPI(t)
	observe := cleanupObserver(a)
	missing := cleanupFixtureFile(a, "already-absent.part")
	deadline := time.Now().Add(250 * time.Millisecond)
	job := cleanupFixtureJob(a, missing, deadline)
	a = restartTestAPI(a)
	event := observe(text(job, "id"), "DELETE")
	at, err := parseTimestamp(text(event, "at"))
	if err != nil || at.Before(deadline.Add(-time.Millisecond)) {
		t.Fatal("恢复任务未遵循持久化nextAttemptAt", event, err)
	}
	path := cleanupFixtureFile(a, "fresh-restart.part")
	if err = os.WriteFile(path, []byte("protected across restart"), 0600); err != nil {
		t.Fatal(err)
	}
	failed := cleanupFixtureJob(a, path, time.Now().Add(-time.Second))
	a = restartTestAPI(a)
	observe(text(failed, "id"), "UPDATE")
	state := cleanupHTTPJob(a, text(failed, "id"))
	if state["attempts"] != float64(1) || !strings.Contains(text(state, "lastError"), "24小时") {
		t.Fatal("启动恢复没有持久化真实删除失败", state)
	}
	// Force only the persisted retry deadline due; never fake file ctime.
	if _, err = a.server.DB.Exec(context.Background(), `UPDATE "FileCleanupJob" SET "nextAttemptAt"=$2 WHERE id=$1`, failed["id"], time.Now().UTC().Add(100*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	observe(text(failed, "id"), "UPDATE")
	a = restartTestAPI(a)
	observe(text(failed, "id"), "UPDATE")
	if state = cleanupHTTPJob(a, text(failed, "id")); state["attempts"] != float64(2) {
		t.Fatal("重启后失败任务没有从已有attempts继续退避", state)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "protected across restart" {
		t.Fatal("恢复任务删除了未满24小时的真实文件", err)
	}
}

func TestFileCleanupConcurrentRetriesProcessSameJobOnce(t *testing.T) {
	a := newTestAPI(t)
	observe := cleanupObserver(a)
	job := cleanupFixtureJob(a, cleanupFixtureFile(a, "absent-concurrent.part"), time.Now().Add(time.Hour))
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	gate, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback(context.Background())
	var pid int
	if err = gate.QueryRow(ctx, `SELECT pg_backend_pid() FROM "FileCleanupJob" WHERE id=$1 FOR UPDATE`, job["id"]).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	type result struct {
		value Object
		err   error
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			value, err := concurrentJSON(a.http.Client(), a.http.URL, a.token, "/api/admin/storage/cleanup/"+text(job, "id")+"/retry", Object{})
			results <- result{value, err}
		}()
	}
	waitCleanupLockGate(t, a.server.DB, ctx, pid)
	if err = gate.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	processed := 0
	for i := 0; i < 2; i++ {
		value := <-results
		if value.err != nil {
			t.Fatal(value.err)
		}
		if value.value["processed"] == true {
			processed++
		}
	}
	if processed != 1 {
		t.Fatal("并发请求只能有一次实际执行", processed)
	}
	observe(text(job, "id"), "DELETE")
	if state := a.call("GET", "/api/admin/storage", nil, 200); state["cleanupTotal"] != float64(0) {
		t.Fatal("并发清理没有收敛")
	}
}

func TestFileCleanupRejectsForeignTraversalBlockedAndSymlinkPaths(t *testing.T) {
	a := newTestAPI(t)
	outside := filepath.Join(t.TempDir(), "protected.outside")
	if err := os.WriteFile(outside, []byte("outside unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	cleanupFixtureFile(a, "unused")
	protected := []string{filepath.Join(a.server.Config.DataDir, "protected"), filepath.Join(a.server.Config.DataDir, "agent-dist", "keep.bin")}
	for _, path := range protected {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("protected managed file"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{outside, a.server.Config.DataDir + "/tmp/../protected", protected[1]} {
		job := cleanupFixtureJob(a, path, time.Now().Add(time.Hour))
		a.call("POST", "/api/admin/storage/cleanup/"+text(job, "id")+"/retry", Object{}, 400)
	}
	blocked := cleanupFixtureJob(a, cleanupFixtureFile(a, "blocked.part"), time.Now().Add(time.Hour))
	if _, err := update(context.Background(), a.server.DB, "FileCleanupJob", text(blocked, "id"), Object{"blocked": true}, "blocked"); err != nil {
		t.Fatal(err)
	}
	a.call("POST", "/api/admin/storage/cleanup/"+text(blocked, "id")+"/retry", Object{}, 400)
	symlink := cleanupFixtureFile(a, "outside-link")
	if err := os.Symlink(filepath.Dir(outside), symlink); err != nil {
		t.Fatal(err)
	}
	job := cleanupFixtureJob(a, filepath.Join(symlink, filepath.Base(outside)), time.Now().Add(time.Hour))
	a.call("POST", "/api/admin/storage/cleanup/"+text(job, "id")+"/retry", Object{}, 200)
	if state := cleanupHTTPJob(a, text(job, "id")); state["attempts"] != float64(1) || !strings.Contains(text(state, "lastError"), "符号链接") {
		t.Fatal("符号链接路径拒绝未真实持久化", state)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "outside unchanged" {
		t.Fatal("越界或符号链接清理触碰了外部文件", err)
	}
	for _, path := range protected {
		if data, err := os.ReadFile(path); err != nil || string(data) != "protected managed file" {
			t.Fatal("越界清理触碰了非临时托管文件", err)
		}
	}
}

func TestFileCleanupStaleCatalogUsesSameLiveChecksAndFailureState(t *testing.T) {
	a := newTestAPI(t)
	path := cleanupFixtureFile(a, "catalog-race.part")
	if err := os.WriteFile(path, []byte("fresh after catalog snapshot"), 0600); err != nil {
		t.Fatal(err)
	}
	a.request("POST", "/api/admin/storage/scan", nil, 200)
	state := a.call("GET", "/api/admin/storage", nil, 200)
	entry := state["items"].([]any)[0].(map[string]any)
	// Inject only a stale catalog decision; the real fresh file must still be
	// protected by the execution-time ctime/age check, not a fake aged file.
	if _, err := a.server.DB.Exec(context.Background(), `UPDATE "StorageCatalogSnapshot" SET payload=jsonb_set(payload,'{snapshot,entries,0,canCleanup}','true') WHERE id=$1`, a.server.storageSnapshotID()); err != nil {
		t.Fatal(err)
	}
	a.call("POST", "/api/admin/storage/cleanup", Object{"ids": []string{text(entry, "id")}}, 200)
	state = a.call("GET", "/api/admin/storage", nil, 200)
	jobs := state["cleanupJobs"].([]any)
	if len(jobs) != 1 {
		t.Fatal("清理请求未持久化真实失败任务")
	}
	job := jobs[0].(map[string]any)
	if job["attempts"] != float64(1) || !strings.Contains(text(job, "lastError"), "24小时") {
		t.Fatal("首次清理与人工重试未使用同一执行和错误记录", job)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "fresh after catalog snapshot" {
		t.Fatal("过期目录快照绕过了真实文件保护", err)
	}
}

func TestFileCleanupMissingParentConvergesWithoutCreatingDirectories(t *testing.T) {
	a := newTestAPI(t)
	path := filepath.Join(a.server.Config.DataDir, "tmp", "removed-folder", "absent.part")
	job := cleanupFixtureJob(a, path, time.Now().Add(time.Hour))
	a.call("POST", "/api/admin/storage/cleanup/"+text(job, "id")+"/retry", Object{}, 200)
	if state := a.call("GET", "/api/admin/storage", nil, 200); state["cleanupTotal"] != float64(0) {
		t.Fatal("整个父目录已不存在时，不应留下永久失败任务")
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("幂等清理不应创建已不存在的目录", err)
	}
}
