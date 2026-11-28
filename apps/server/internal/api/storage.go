package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) storageSnapshotID() string { return "go-local:" + tokenHash(s.Config.DataDir) }
func (s *Server) storageState(ctx context.Context) (Object, error) {
	state, err := one(ctx, s.DB, `SELECT payload FROM "StorageCatalogSnapshot" WHERE id=$1`, s.storageSnapshotID())
	if err == pgx.ErrNoRows {
		return Object{"snapshot": Object{"scannedAt": nil, "entries": []any{}, "logicalBytes": 0, "allocatedBytes": 0, "hardlinkSavedBytes": 0, "warnings": []string{"尚未扫描；只统计本地 Go 服务数据目录，不包含旧发布中心和数据库目录"}}, "paths": Object{}}, nil
	}
	return state, err
}
func (s *Server) storageList(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	state, err := s.storageState(r.Context())
	if err != nil {
		return nil, err
	}
	snapshot := state["snapshot"].(map[string]any)
	entries, _ := snapshot["entries"].([]any)
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	cleanupPage, _ := strconv.Atoi(r.URL.Query().Get("cleanupPage"))
	if page < 0 || page > 100000 || cleanupPage < 0 || cleanupPage > 100000 {
		return nil, fail(400, "页码无效")
	}
	search := strings.ToLower(r.URL.Query().Get("search"))
	items := []Object{}
	orphan, missing := 0, 0
	reusable := float64(0)
	matched := 0
	for _, raw := range entries {
		entry := raw.(map[string]any)
		if entry["canCleanup"] == true {
			orphan++
			if number(entry, "links") <= 1 {
				reusable += number(entry, "allocatedBytes")
			}
		}
		if entry["state"] == "missing" {
			missing++
		}
		if search != "" && !strings.Contains(strings.ToLower(fmt.Sprint(entry["name"], entry["references"])), search) {
			continue
		}
		if matched >= page*100 && matched < (page+1)*100 {
			items = append(items, entry)
		}
		matched++
	}
	jobs, err := list(r.Context(), s.DB, `SELECT to_jsonb(j) FROM "FileCleanupJob" j WHERE starts_with(path,$1) ORDER BY "createdAt",id LIMIT 100 OFFSET $2`, s.Config.DataDir+"/", cleanupPage*100)
	if err != nil {
		return nil, err
	}
	var jobCount int
	if err = s.DB.QueryRow(r.Context(), `SELECT count(*) FROM "FileCleanupJob" WHERE starts_with(path,$1)`, s.Config.DataDir+"/").Scan(&jobCount); err != nil {
		return nil, err
	}
	out := pick(snapshot, "scannedAt", "logicalBytes", "allocatedBytes", "hardlinkSavedBytes", "warnings", "diskFreeBytes")
	out["totalFiles"] = len(entries)
	out["orphanCount"] = orphan
	out["missingCount"] = missing
	out["reusableBytes"] = reusable
	out["items"] = items
	out["hasMore"] = matched > (page+1)*100
	out["cleanupTotal"] = jobCount
	out["cleanupJobs"] = jobs
	return out, nil
}
func statInt(info fs.FileInfo, name string) (int64, bool) {
	value := reflect.ValueOf(info.Sys())
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return 0, false
	}
	field := value.FieldByName(name)
	if !field.IsValid() {
		return 0, false
	}
	if field.CanInt() {
		return field.Int(), true
	}
	if field.CanUint() {
		return int64(field.Uint()), true
	}
	return 0, false
}
func changedTime(info fs.FileInfo) (time.Time, bool) {
	value := reflect.ValueOf(info.Sys())
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return time.Time{}, false
	}
	for _, name := range []string{"Ctim", "Ctimespec"} {
		field := value.FieldByName(name)
		if field.IsValid() {
			sec := field.FieldByName("Sec")
			nsec := field.FieldByName("Nsec")
			if sec.CanInt() && nsec.CanInt() {
				return time.Unix(sec.Int(), nsec.Int()), true
			}
		}
	}
	return time.Time{}, false
}
func managedTemporary(relative string) bool {
	return (strings.HasPrefix(relative, "tmp/") || strings.HasPrefix(relative, "uploads/tmp/")) && path.Clean(relative) == relative && !strings.ContainsAny(relative, "\\\x00") && !strings.HasPrefix(relative, "/")
}
func cleanupAge(info fs.FileInfo) bool {
	changed, ok := changedTime(info)
	return ok && time.Since(info.ModTime()) > 24*time.Hour && time.Since(changed) > 24*time.Hour
}
func (s *Server) scanStorage(ctx context.Context, progress func(int, string)) error {
	if !s.storageMu.TryLock() {
		return fail(409, "已有本地文件扫描正在执行")
	}
	defer s.storageMu.Unlock()
	if err := os.MkdirAll(s.Config.DataDir, 0700); err != nil {
		return err
	}
	root, err := os.OpenRoot(s.Config.DataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	entries := []Object{}
	paths := Object{}
	warnings := []string{"仅扫描本地 Go 服务托管目录，不扫描 PostgreSQL、旧发布中心、旧后台版本或旧数据库快照"}
	seen := map[string]bool{}
	var logical, allocated, saved int64
	estimated := false
	progress(0, "正在扫描本地托管文件")
	err = fs.WalkDir(root.FS(), ".", func(relative string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			warnings = append(warnings, "无法读取："+relative)
			return nil
		}
		if strings.Count(relative, "/") > 32 {
			warnings = append(warnings, "跳过过深目录："+relative)
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			warnings = append(warnings, "跳过符号链接："+relative)
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if len(entries) >= 100000 {
			return fail(400, "文件数量超过本次扫描上限100000")
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		size := info.Size()
		blocks, hasBlocks := statInt(info, "Blocks")
		allocatedSize := size
		if hasBlocks {
			allocatedSize = blocks * 512
		} else {
			estimated = true
		}
		device, hasDevice := statInt(info, "Dev")
		inode, hasInode := statInt(info, "Ino")
		links, _ := statInt(info, "Nlink")
		if links < 1 {
			links = 1
		}
		identity := fmt.Sprintf("%d:%d", device, inode)
		if !hasDevice || !hasInode {
			identity = relative
		}
		logical += size
		if seen[identity] {
			saved += size
		} else {
			allocated += allocatedSize
			seen[identity] = true
		}
		id := tokenHash(s.Config.DataDir + "/" + relative)
		paths[id] = relative
		canCleanup := managedTemporary(relative) && cleanupAge(info)
		state := "protected"
		references := []string{"应用托管文件，保留"}
		category := "本地托管文件"
		if strings.HasPrefix(relative, "agent-dist/") {
			category = "Go Agent 构建产物"
			references = []string{"节点安装与下载使用"}
		} else if managedTemporary(relative) {
			category = "临时上传"
			references = []string{}
			if canCleanup {
				state = "orphan"
			}
		}
		entries = append(entries, Object{"id": id, "name": relative, "category": category, "sizeBytes": size, "allocatedBytes": allocatedSize, "references": references, "state": state, "canCleanup": canCleanup, "hash": nil, "modifiedAt": info.ModTime().UTC().Format(time.RFC3339Nano), "links": links, "identity": identity})
		if len(entries)%200 == 0 {
			progress(len(entries), "正在核对本地托管文件")
		}
		return nil
	})
	if err != nil {
		return err
	}
	if estimated {
		warnings = append(warnings, "当前文件系统未提供分配块数，分配空间按文件长度估算")
	}
	sort.Slice(entries, func(i, j int) bool { return text(entries[i], "name") < text(entries[j], "name") })
	var diskFreeBytes any
	if available, err := storageAvailableBytes(root); err == nil {
		diskFreeBytes = available
	} else {
		warnings = append(warnings, "磁盘可用空间读取失败："+err.Error())
	}
	payload := Object{"snapshot": Object{"scannedAt": now(), "entries": entries, "logicalBytes": logical, "allocatedBytes": allocated, "hardlinkSavedBytes": saved, "diskFreeBytes": diskFreeBytes, "warnings": warnings}, "paths": paths}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO "StorageCatalogSnapshot"(id,payload,"updatedAt") VALUES($1,$2::jsonb,now()) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,"updatedAt"=now()`, s.storageSnapshotID(), raw)
	return err
}
func (s *Server) storageScan(w http.ResponseWriter, r *http.Request, u Object) (any, error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, fail(500, "扫描连接不支持进度推送")
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	send := func(event Object) {
		raw, _ := json.Marshal(event)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
		flusher.Flush()
	}
	err := s.scanStorage(r.Context(), func(checked int, message string) {
		send(Object{"type": "progress", "checked": checked, "message": message})
	})
	if err != nil {
		send(Object{"type": "error", "message": err.Error()})
		return nil, nil
	}
	snapshot, err := s.storageList(w, r, u)
	if err != nil {
		send(Object{"type": "error", "message": "本地扫描结果读取失败"})
		return nil, nil
	}
	send(Object{"type": "complete", "snapshot": snapshot})
	return nil, nil
}
