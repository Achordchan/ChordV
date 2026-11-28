package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"

	"github.com/jackc/pgx/v5"
)

const runtimeSubscriptionsSetting = "chordv.runtime_locked_subscription_ids"
const runtimeSubscriptionsHashSetting = "chordv.runtime_locked_subscription_hash"

func runtimeSubscriptionContract(ctx context.Context, q queryer) ([]string, bool, error) {
	tx, ok := q.(pgx.Tx)
	if !ok || tx == nil || tx.Conn() == nil || tx.Conn().PgConn().TxStatus() != 'T' {
		return nil, false, fail(500, "运行锁契约必须在显式事务内执行")
	}
	var raw, digest string
	if err := tx.QueryRow(ctx, `SELECT coalesce(current_setting($1,true),''),coalesce(current_setting($2,true),'')`, runtimeSubscriptionsSetting, runtimeSubscriptionsHashSetting).Scan(&raw, &digest); err != nil {
		return nil, false, err
	}
	if raw == "" && digest == "" {
		return nil, false, nil
	}
	hash := sha256.Sum256([]byte(raw))
	var ids []string
	if raw == "" || digest != hex.EncodeToString(hash[:]) || json.Unmarshal([]byte(raw), &ids) != nil || ids == nil {
		return nil, false, fail(500, "事务订阅锁清单已损坏")
	}
	for i, id := range ids {
		if id == "" || (i > 0 && ids[i-1] >= id) {
			return nil, false, fail(500, "事务订阅锁清单已损坏")
		}
	}
	return ids, true, nil
}

func requireRuntimeSubscriptions(ctx context.Context, q queryer, ids []string) error {
	locked, frozen, err := runtimeSubscriptionContract(ctx, q)
	if err != nil || !frozen {
		return err
	}
	return requireRuntimeSubscriptionSubset(locked, ids)
}

func requireFrozenRuntimeSubscriptions(ctx context.Context, q queryer, ids []string) error {
	locked, frozen, err := runtimeSubscriptionContract(ctx, q)
	if err != nil {
		return err
	}
	if !frozen {
		return fail(500, "事务订阅锁清单尚未冻结")
	}
	return requireRuntimeSubscriptionSubset(locked, ids)
}

func requireRuntimeSubscriptionSubset(locked, ids []string) error {
	for _, id := range ids {
		if _, found := slices.BinarySearch(locked, id); !found {
			return fail(409, "订阅范围在等待期间已变化，请重试")
		}
	}
	return nil
}

// Freeze once before the first Node lock. Nested scopes may only narrow the
// already locked set; local GUCs disappear on commit/rollback and pool reuse.
func freezeRuntimeSubscriptions(ctx context.Context, q queryer, ids []string) error {
	locked, frozen, err := runtimeSubscriptionContract(ctx, q)
	if err != nil {
		return err
	}
	if frozen {
		return requireRuntimeSubscriptionSubset(locked, ids)
	}
	ordered := append([]string{}, ids...)
	slices.Sort(ordered)
	for i, id := range ordered {
		if id == "" || (i > 0 && ordered[i-1] == id) {
			return fail(500, "事务订阅锁清单无效")
		}
	}
	raw, err := json.Marshal(ordered)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(raw)
	_, err = q.Exec(ctx, `SELECT set_config($1,$2,true),set_config($3,$4,true)`, runtimeSubscriptionsSetting, string(raw), runtimeSubscriptionsHashSetting, hex.EncodeToString(hash[:]))
	return err
}

func lockRuntimeSubscriptionSet(ctx context.Context, q queryer, ids []string) error {
	if err := requireRuntimeSubscriptions(ctx, q, ids); err != nil {
		return err
	}
	_, err := list(ctx, q, `SELECT jsonb_build_object('id',id) FROM "Subscription" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, ids)
	return err
}

func readLockedRuntimeSubscription(ctx context.Context, q queryer, id string) (Object, error) {
	sub, err := one(ctx, q, `SELECT to_jsonb(s) FROM "Subscription" s WHERE id=$1`, id)
	if err != nil {
		return nil, err
	}
	return sub, requireFrozenRuntimeSubscriptions(ctx, q, []string{id})
}
