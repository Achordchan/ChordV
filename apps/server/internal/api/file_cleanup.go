package api

import (
	"context"
	"io/fs"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) storageCleanup(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	ids, err := stringArray(input["ids"], 100)
	if err != nil {
		return nil, err
	}
	state, err := s.storageState(r.Context())
	if err != nil {
		return nil, err
	}
	snapshot := state["snapshot"].(map[string]any)
	if snapshot["scannedAt"] == nil {
		return nil, fail(409, "请先扫描本地文件")
	}
	entries, _ := snapshot["entries"].([]any)
	byID := map[string]Object{}
	for _, raw := range entries {
		entry := raw.(map[string]any)
		byID[text(entry, "id")] = entry
	}
	paths, _ := state["paths"].(map[string]any)
	targets := make([]string, 0, len(ids))
	// Reject the entire invalid selection before enqueueing or executing any
	// earlier target; filesystem execution still performs its own live checks.
	for _, id := range ids {
		entry := byID[id]
		if entry == nil || entry["canCleanup"] != true {
			return nil, fail(400, "只能清理扫描确认的过期临时文件")
		}
		relative, _ := paths[id].(string)
		if !managedTemporary(relative) {
			return nil, fail(400, "文件不属于本地临时目录")
		}
		targets = append(targets, s.Config.DataDir+"/"+relative)
	}
	for _, absolute := range targets {
		job, err := one(r.Context(), s.DB, `WITH queued AS(INSERT INTO "FileCleanupJob"(id,path,reason,"updatedAt") VALUES($1,$2,'本地过期临时文件',now()) ON CONFLICT(path) DO UPDATE SET attempts=0,"lastError"=NULL,"nextAttemptAt"=now(),revision="FileCleanupJob".revision+1,"updatedAt"=now() RETURNING *) SELECT to_jsonb(queued) FROM queued`, newID(), absolute)
		if err != nil {
			return nil, err
		}
		if _, err = s.executeFileCleanup(r.Context(), text(job, "id"), true); err != nil {
			return nil, err
		}
	}
	return Object{"ok": true}, nil
}
func (s *Server) cleanLocalTemporary(_ context.Context, relative string) error {
	if !managedTemporary(relative) {
		return fail(400, "拒绝清理非托管临时路径")
	}
	root, err := os.OpenRoot(s.Config.DataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	parts := strings.Split(relative, "/")
	for i := 1; i < len(parts); i++ {
		parent, err := root.Lstat(strings.Join(parts[:i], "/"))
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !parent.IsDir() || parent.Mode()&fs.ModeSymlink != 0 {
			return fail(409, "临时目录已变化，拒绝跟随符号链接清理")
		}
	}
	info, err := root.Lstat(relative)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !cleanupAge(info) {
		return fail(409, "文件已变化或未满24小时，未删除")
	}
	return root.Remove(relative)
}
func (s *Server) retryStorageCleanup(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	processed, err := s.executeFileCleanup(r.Context(), r.PathValue("id"), true)
	if err != nil {
		return nil, err
	}
	return Object{"ok": true, "processed": processed}, nil
}

func (s *Server) cleanupRelativePath(absolute string) (string, error) {
	prefix := s.Config.DataDir + "/"
	if !strings.HasPrefix(absolute, prefix) || !managedTemporary(strings.TrimPrefix(absolute, prefix)) {
		return "", fail(400, "清理任务不属于本地托管临时目录")
	}
	return strings.TrimPrefix(absolute, prefix), nil
}

func fileCleanupDelay(attempts int) time.Duration {
	if attempts > 11 {
		attempts = 11
	}
	return min(24*time.Hour, time.Minute*time.Duration(1<<max(0, attempts)))
}

func (s *Server) resumeFileCleanups(ctx context.Context) error {
	jobs, err := list(ctx, s.DB, `SELECT to_jsonb(j) FROM "FileCleanupJob" j WHERE starts_with(path,$1) AND NOT blocked ORDER BY "nextAttemptAt",id`, s.Config.DataDir+"/")
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if _, pathErr := s.cleanupRelativePath(text(job, "path")); pathErr != nil {
			if _, err = s.DB.Exec(ctx, `UPDATE "FileCleanupJob" SET blocked=true,"lastError"=$2,"updatedAt"=now() WHERE id=$1 AND revision=$3`, job["id"], pathErr.Error(), job["revision"]); err != nil {
				return err
			}
			continue
		}
		at, err := parseTimestamp(text(job, "nextAttemptAt"))
		if err != nil {
			return err
		}
		s.scheduleEntity("file-cleanup", text(job, "id"), at)
	}
	return nil
}

func (s *Server) executeFileCleanup(ctx context.Context, id string, manual bool) (bool, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	// Hold the durable job lock through the live filesystem check/removal, so
	// explicit retry and multiple server workers cannot execute it together.
	job, err := one(ctx, tx, `SELECT to_jsonb(j) FROM "FileCleanupJob" j WHERE id=$1 FOR UPDATE`, id)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	absolute := text(job, "path")
	relative, err := s.cleanupRelativePath(absolute)
	if err != nil {
		return false, err
	}
	if job["blocked"] == true {
		return false, fail(400, "该清理任务需要先人工核对异常路径")
	}
	next, err := parseTimestamp(text(job, "nextAttemptAt"))
	if err != nil {
		return false, err
	}
	if !manual && next.After(time.Now()) {
		s.scheduleEntity("file-cleanup", id, next)
		return false, nil
	}
	failed := false
	if cleanupErr := s.cleanLocalTemporary(ctx, relative); cleanupErr != nil {
		failed = true
		next = time.Now().UTC().Add(fileCleanupDelay(int(number(job, "attempts"))))
		message := cleanupErr.Error()
		if runes := []rune(message); len(runes) > 1000 {
			message = string(runes[:1000])
		}
		_, err = tx.Exec(ctx, `UPDATE "FileCleanupJob" SET attempts=attempts+1,"lastError"=$2,"nextAttemptAt"=$3,"updatedAt"=now() WHERE id=$1 AND revision=$4`, id, message, next, job["revision"])
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM "FileCleanupJob" WHERE id=$1 AND revision=$2`, id, job["revision"])
	}
	if err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	if failed {
		s.scheduleEntity("file-cleanup", id, next)
	}
	return true, nil
}
