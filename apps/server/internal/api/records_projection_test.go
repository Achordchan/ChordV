package api

import (
	"context"
	"encoding/json"
	"testing"
)

func TestRecordHelpersReturnWholeRowWithResultNamedColumn(t *testing.T) {
	a := newTestAPI(t)
	ctx := context.Background()
	if _, err := a.server.DB.Exec(ctx, `CREATE TABLE "ResultProjectionFixture"(id text PRIMARY KEY,"businessKey" text UNIQUE NOT NULL,"createdAt" timestamptz NOT NULL,"updatedAt" timestamptz NOT NULL,result jsonb)`); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		value any
	}{
		{"sql-null", nil},
		{"object", Object{"id": "payload-id-not-row-id", "nested": Object{"ok": true}}},
		{"array", []any{"first", float64(2), Object{"ok": true}}},
		{"number", float64(42)},
		{"string", "payload-not-record"},
		{"boolean", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			check := func(t *testing.T, row Object, err error, id, businessKey string) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
				if text(row, "id") != id || text(row, "businessKey") != businessKey || text(row, "createdAt") == "" || text(row, "updatedAt") == "" {
					t.Fatal("记录帮助函数必须返回完整行，不能返回result列", row)
				}
				if _, present := row["result"]; !present {
					t.Fatal("完整行必须包含result列，即使它为NULL")
				}
				actual, _ := json.Marshal(row["result"])
				expected, _ := json.Marshal(test.value)
				if string(actual) != string(expected) {
					t.Fatalf("result内容改变 actual=%s expected=%s", actual, expected)
				}
			}
			t.Run("insert", func(t *testing.T) {
				businessKey := newID()
				row, err := insert(ctx, a.server.DB, "ResultProjectionFixture", Object{"businessKey": businessKey, "result": test.value})
				if err != nil {
					t.Fatal(err)
				}
				if text(row, "id") == "" || text(row, "id") == "payload-id-not-row-id" {
					t.Fatal("insert返回了载荷ID，而非真实记录ID", row)
				}
				check(t, row, nil, text(row, "id"), businessKey)
			})
			for _, method := range []string{"update", "updateKey"} {
				t.Run(method, func(t *testing.T) {
					id, businessKey := newID(), newID()
					if _, err := a.server.DB.Exec(ctx, `INSERT INTO "ResultProjectionFixture" VALUES($1,$2,now(),now(),'{}')`, id, businessKey); err != nil {
						t.Fatal(err)
					}
					var row Object
					var err error
					if method == "update" {
						row, err = update(ctx, a.server.DB, "ResultProjectionFixture", id, Object{"result": test.value}, "result")
					} else {
						row, err = updateKey(ctx, a.server.DB, "ResultProjectionFixture", "businessKey", businessKey, Object{"result": test.value}, "result")
					}
					check(t, row, err, id, businessKey)
				})
			}
		})
	}
}
