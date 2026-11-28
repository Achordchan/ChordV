package api

import (
	"context"
	"reflect"
)

func concurrencyScopeUsers(ctx context.Context, q queryer, kind, id string) ([]string, error) {
	if kind == "user" {
		return []string{id}, nil
	}
	where := `s.id=$1`
	if kind == "plan" {
		where = `s."planId"=$1`
	} else if kind != "subscription" {
		return nil, fail(400, "并发策略范围无效")
	}
	rows, err := list(ctx, q, `WITH targets AS(SELECT s.* FROM "Subscription" s WHERE `+where+`), users AS(
 SELECT "userId" FROM targets UNION SELECT m."userId" FROM "TeamMember" m JOIN targets s ON s."teamId"=m."teamId"
 UNION SELECT l."userId" FROM "NodeSessionLease" l JOIN targets s ON s.id=l."subscriptionId"
 UNION SELECT b."userId" FROM "PanelClientBinding" b JOIN targets s ON s.id=b."subscriptionId"
 ) SELECT jsonb_build_object('id',"userId") FROM users WHERE "userId" IS NOT NULL ORDER BY "userId"`, id)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, row := range rows {
		ids = append(ids, text(row, "id"))
	}
	return ids, nil
}

func concurrencyScopeSnapshot(ctx context.Context, q queryer, kind, id string, users []string) (Object, error) {
	predicate, err := runtimeSubscriptionPredicate("userId", "=ANY($1::text[])")
	if err != nil {
		return nil, err
	}
	if kind == "subscription" {
		predicate = `(` + predicate + `) OR s.id=$2`
	} else if kind == "plan" {
		predicate = `(` + predicate + `) OR s."planId"=$2`
	} else {
		predicate = `(` + predicate + `) AND $2::text IS NOT NULL`
	}
	return one(ctx, q, `SELECT jsonb_build_object('users',to_jsonb($1::text[]),
 'members',coalesce((SELECT jsonb_agg(jsonb_build_object('userId',m."userId",'teamId',m."teamId") ORDER BY m."userId") FROM "TeamMember" m WHERE m."userId"=ANY($1::text[])),'[]'),
 'subscriptions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'userId',s."userId",'teamId',s."teamId",'planId',s."planId") ORDER BY s.id) FROM "Subscription" s WHERE `+predicate+`),'[]'))`, users, id)
}

// Discover before locking, lock the whole subscription set in order, then recheck ownership.
// In particular, a PATCH of a later historical subscription must not hold it before an earlier one.
func lockConcurrencyScope(ctx context.Context, q queryer, kind, id string) error {
	users, err := concurrencyScopeUsers(ctx, q, kind, id)
	if err != nil {
		return err
	}
	before, err := concurrencyScopeSnapshot(ctx, q, kind, id, users)
	if err != nil {
		return err
	}
	ids := []string{}
	for _, raw := range before["subscriptions"].([]any) {
		ids = append(ids, text(raw.(map[string]any), "id"))
	}
	if err = lockRuntimeSubscriptionSet(ctx, q, ids); err != nil {
		return err
	}
	freshUsers, err := concurrencyScopeUsers(ctx, q, kind, id)
	if err != nil {
		return err
	}
	after, err := concurrencyScopeSnapshot(ctx, q, kind, id, freshUsers)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(before, after) {
		return fail(409, "租约归属或套餐在等待期间已变化，请重试")
	}
	return lockRuntimeBindingsAndNodes(ctx, q, ids)
}
