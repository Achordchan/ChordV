package api

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func batchCleanupCatalog(a *testAPI) (Object, []string, []string) {
	a.t.Helper()
	files := []string{cleanupFixtureFile(a, "batch-first.part"), cleanupFixtureFile(a, "batch-second.part")}
	for _, file := range files {
		if err := os.WriteFile(file, []byte("real fresh batch file"), 0600); err != nil {
			a.t.Fatal(err)
		}
	}
	a.request("POST", "/api/admin/storage/scan", nil, 200)
	catalog, err := a.server.storageState(context.Background())
	if err != nil {
		a.t.Fatal(err)
	}
	ids := []string{}
	for _, raw := range catalog["snapshot"].(map[string]any)["entries"].([]any) {
		entry := raw.(map[string]any)
		// Model a stale catalog decision only. Real file ctime is untouched;
		// execution would still reject these fresh files at the live check.
		entry["canCleanup"], entry["state"] = true, "orphan"
		ids = append(ids, text(entry, "id"))
	}
	return catalog, ids, files
}

func saveBatchCleanupCatalog(a *testAPI, catalog Object) {
	a.t.Helper()
	raw, err := json.Marshal(catalog)
	if err == nil {
		_, err = a.server.DB.Exec(context.Background(), `UPDATE "StorageCatalogSnapshot" SET payload=$2::jsonb WHERE id=$1`, a.server.storageSnapshotID(), raw)
	}
	if err != nil {
		a.t.Fatal(err)
	}
}

func cleanupJobsState(a *testAPI) string {
	a.t.Helper()
	var state string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY id),'[]'::jsonb)::text FROM "FileCleanupJob" j`).Scan(&state); err != nil {
		a.t.Fatal(err)
	}
	return state
}

func TestFileCleanupInvalidBatchHasNoPartialEffects(t *testing.T) {
	for _, kind := range []string{"unknown-second-id", "uncleanable-second-entry", "unsafe-second-path", "existing-first-job"} {
		t.Run(kind, func(t *testing.T) {
			a := newTestAPI(t)
			catalog, ids, files := batchCleanupCatalog(a)
			switch kind {
			case "unknown-second-id", "existing-first-job":
				ids[1] = newID()
			case "uncleanable-second-entry":
				catalog["snapshot"].(map[string]any)["entries"].([]any)[1].(map[string]any)["canCleanup"] = false
			case "unsafe-second-path":
				catalog["paths"].(map[string]any)[ids[1]] = "../outside"
			}
			if kind == "existing-first-job" {
				job := cleanupFixtureJob(a, files[0], time.Now().Add(time.Hour))
				if _, err := update(context.Background(), a.server.DB, "FileCleanupJob", text(job, "id"), Object{"attempts": 3, "revision": 7, "lastError": "previous private failure"}, "attempts", "revision", "lastError"); err != nil {
					t.Fatal(err)
				}
			}
			saveBatchCleanupCatalog(a, catalog)
			before := cleanupJobsState(a)
			a.call("POST", "/api/admin/storage/cleanup", Object{"ids": ids}, 400)
			if after := cleanupJobsState(a); after != before {
				t.Fatal("整批输入被拒绝，却已修改前面目标的清理任务")
			}
			for _, file := range files {
				if data, err := os.ReadFile(file); err != nil || string(data) != "real fresh batch file" {
					t.Fatal("被拒绝的批次触碰了真实文件", err)
				}
			}
		})
	}
}

func TestFileCleanupValidBatchStillRecordsEachLiveFailure(t *testing.T) {
	a := newTestAPI(t)
	catalog, ids, _ := batchCleanupCatalog(a)
	saveBatchCleanupCatalog(a, catalog)
	a.call("POST", "/api/admin/storage/cleanup", Object{"ids": ids}, 200)
	state := a.call("GET", "/api/admin/storage", nil, 200)
	jobs := state["cleanupJobs"].([]any)
	if len(jobs) != 2 {
		t.Fatal("整批预校验不能跳过合法目标的实际执行", len(jobs))
	}
	for _, raw := range jobs {
		job := raw.(map[string]any)
		if job["attempts"] != float64(1) || text(job, "lastError") == "" {
			t.Fatal("合法批次必须逐个经过实时文件保护并记录状态")
		}
	}
}
