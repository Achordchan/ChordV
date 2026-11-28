package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"
)

const teamListSQL = `SELECT to_jsonb(t)||jsonb_build_object(
 'ownerDisplayName',u."displayName",'ownerEmail',u.email,
 'memberCount',(SELECT count(*) FROM "TeamMember" m WHERE m."teamId"=t.id),
 'currentSubscription',(SELECT jsonb_build_object('id',s.id,'planId',p.id,'planName',p.name,
   'totalTrafficGb',s."totalTrafficGb",'usedTrafficGb',s."usedTrafficGb",'remainingTrafficGb',s."remainingTrafficGb",'expireAt',s."expireAt",'state',s.state)
   FROM "Subscription" s JOIN "Plan" p ON p.id=s."planId" WHERE s."teamId"=t.id ORDER BY s."expireAt" DESC LIMIT 1),
 'members',coalesce((SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('email',mu.email,'displayName',mu."displayName"))
   FROM "TeamMember" m JOIN "User" mu ON mu.id=m."userId" WHERE m."teamId"=t.id),'[]'::jsonb))
FROM "Team" t JOIN "User" u ON u.id=t."ownerUserId"`

func (s *Server) teams(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	teams, err := list(r.Context(), s.DB, teamListSQL+` ORDER BY t."createdAt" DESC`)
	if err != nil {
		return nil, err
	}
	if err = attachTeamUsage(r.Context(), s.DB, teams); err != nil {
		return nil, err
	}
	return teams, nil
}
func (s *Server) teamResult(r *http.Request, id string) (Object, error) {
	team, err := one(r.Context(), s.DB, teamListSQL+` WHERE t.id=$1`, id)
	if err != nil {
		return nil, err
	}
	if err = attachTeamUsage(r.Context(), s.DB, []Object{team}); err != nil {
		return nil, err
	}
	return team, nil
}
func (s *Server) createTeam(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "name", "ownerUserId"); err != nil {
		return nil, err
	}
	if err = enum(input, "status", "active", "disabled"); err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	owner, err := one(r.Context(), tx, `SELECT to_jsonb(u) FROM "User" u WHERE id=$1 AND status='active' FOR UPDATE`, input["ownerUserId"])
	if err != nil {
		return nil, err
	}
	var occupied bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "TeamMember" WHERE "userId"=$1) OR EXISTS(SELECT 1 FROM "Subscription" WHERE "userId"=$1 AND state='active' AND "expireAt">now() AND "remainingTrafficGb">0)`, owner["id"]).Scan(&occupied); err != nil {
		return nil, err
	}
	if occupied {
		return nil, fail(409, "该账号已有团队或有效个人订阅，请先处理归属")
	}
	data := pick(input, "name", "ownerUserId", "status")
	if _, ok := data["status"]; !ok {
		data["status"] = "active"
	}
	team, err := insert(r.Context(), tx, "Team", data)
	if err != nil {
		return nil, err
	}
	if _, err = insert(r.Context(), tx, "TeamMember", Object{"teamId": team["id"], "userId": owner["id"], "role": "owner"}); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("teams", "")
	return s.teamResult(r, text(team, "id"))
}
func (s *Server) updateTeam(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = enum(input, "status", "active", "disabled"); err != nil {
		return nil, err
	}
	id := r.PathValue("teamId")
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	old, err := one(r.Context(), tx, `SELECT to_jsonb(t) FROM "Team" t WHERE id=$1 FOR NO KEY UPDATE`, id)
	if err != nil {
		return nil, err
	}
	subs, err := list(r.Context(), tx, `SELECT to_jsonb(s) FROM "Subscription" s WHERE "teamId"=$1 ORDER BY s.id FOR UPDATE`, id)
	if err != nil {
		return nil, err
	}
	if ownerID := text(input, "ownerUserId"); ownerID != "" && ownerID != old["ownerUserId"] {
		if _, err = one(r.Context(), tx, `SELECT to_jsonb(m) FROM "TeamMember" m JOIN "User" u ON u.id=m."userId" WHERE m."teamId"=$1 AND m."userId"=$2 AND u.status='active' FOR UPDATE OF m`, id, ownerID); err != nil {
			return nil, fail(400, "新负责人必须是该团队的启用成员")
		}
		if _, err = tx.Exec(r.Context(), `UPDATE "TeamMember" SET role=CASE WHEN "userId"=$2 THEN 'owner'::"TeamMemberRole" ELSE 'member'::"TeamMemberRole" END,"updatedAt"=now() WHERE "teamId"=$1`, id, ownerID); err != nil {
			return nil, err
		}
	}
	if _, err = update(r.Context(), tx, "Team", id, input, "name", "ownerUserId", "status"); err != nil {
		return nil, err
	}
	if err = lockRuntimeBindingsAndNodes(r.Context(), tx, runtimeSubscriptionIDs(subs)); err != nil {
		return nil, err
	}
	for _, sub := range subs {
		if err = s.syncSubscriptionBindings(r.Context(), tx, text(sub, "id")); err != nil {
			return nil, err
		}
		if input["status"] == "disabled" {
			if _, err = s.revokeLeases(r.Context(), tx, "subscriptionId", text(sub, "id"), "team_access_revoked"); err != nil {
				return nil, err
			}
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("teams", "")
	return s.teamResult(r, id)
}
func (s *Server) addMember(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "userId"); err != nil {
		return nil, err
	}
	if text(input, "role") == "owner" {
		return nil, fail(400, "请在团队设置中变更负责人")
	}
	id := r.PathValue("teamId")
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err = one(r.Context(), tx, `SELECT to_jsonb(u) FROM "User" u WHERE id=$1 AND status='active' FOR NO KEY UPDATE`, input["userId"]); err != nil {
		return nil, err
	}
	if _, err = one(r.Context(), tx, `SELECT to_jsonb(t) FROM "Team" t WHERE id=$1`, id); err != nil {
		return nil, err
	}
	var active bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "Subscription" WHERE "userId"=$1 AND state='active' AND "expireAt">now() AND "remainingTrafficGb">0)`, input["userId"]).Scan(&active); err != nil {
		return nil, err
	}
	if active {
		return nil, fail(409, "该账号仍有有效个人订阅")
	}
	if _, err = insert(r.Context(), tx, "TeamMember", Object{"teamId": id, "userId": input["userId"], "role": "member"}); err != nil {
		return nil, err
	}
	if err = s.syncUserSubscriptions(r.Context(), tx, text(input, "userId")); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("teams", text(input, "userId"))
	return s.teamResult(r, id)
}
func (s *Server) updateMember(w http.ResponseWriter, r *http.Request, u Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = enum(input, "role", "owner", "member"); err != nil {
		return nil, err
	}
	if text(input, "role") == "owner" {
		member, err := one(r.Context(), s.DB, `SELECT to_jsonb(m) FROM "TeamMember" m WHERE id=$1 AND "teamId"=$2`, r.PathValue("memberId"), r.PathValue("teamId"))
		if err != nil {
			return nil, err
		}
		r.Body, _ = marshalBody(Object{"ownerUserId": member["userId"]})
		return s.updateTeam(w, r, u)
	}
	member, err := one(r.Context(), s.DB, `SELECT to_jsonb(m) FROM "TeamMember" m WHERE id=$1 AND "teamId"=$2`, r.PathValue("memberId"), r.PathValue("teamId"))
	if err != nil {
		return nil, err
	}
	if member["role"] == "owner" {
		return nil, fail(409, "请先变更团队负责人")
	}
	return s.teamResult(r, r.PathValue("teamId"))
}
func (s *Server) removeMember(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return s.removeTeamMember(r)
}
func (s *Server) removeTeamMember(r *http.Request) (any, error) {
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if err = lockTeamSubscriptions(r.Context(), tx, r.PathValue("teamId")); err != nil {
		return nil, err
	}
	member, err := one(r.Context(), tx, `SELECT to_jsonb(m) FROM "TeamMember" m WHERE id=$1 AND "teamId"=$2 FOR UPDATE`, r.PathValue("memberId"), r.PathValue("teamId"))
	if err != nil {
		return nil, err
	}
	if member["role"] == "owner" {
		return nil, fail(409, "不能移除负责人，请先变更负责人")
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM "TeamMember" WHERE id=$1`, member["id"]); err != nil {
		return nil, err
	}
	if _, err = s.revokeTeamMemberLeases(r.Context(), tx, text(member, "teamId"), text(member, "userId"), "team_member_removed"); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("teams", text(member, "userId"))
	return Object{"ok": true}, nil
}
func (s *Server) teamUsage(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	id := r.PathValue("teamId")
	if _, err := one(r.Context(), s.DB, `SELECT jsonb_build_object('id',id) FROM "Team" WHERE id=$1`, id); err != nil {
		return nil, err
	}
	usage, err := loadTeamUsage(r.Context(), s.DB, []string{id})
	if err != nil {
		return nil, err
	}
	return usage[id], nil
}
func (s *Server) convertSubscription(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "targetTeamId"); err != nil {
		return nil, err
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	initial, err := one(ctx, tx, `SELECT to_jsonb(s) FROM "Subscription" s WHERE id=$1 AND "teamId" IS NULL AND "userId" IS NOT NULL`, r.PathValue("subscriptionId"))
	if err != nil {
		return nil, err
	}
	if _, err = one(ctx, tx, `SELECT to_jsonb(u) FROM "User" u WHERE id=$1 AND status='active' FOR NO KEY UPDATE`, initial["userId"]); err != nil {
		return nil, err
	}
	team, err := one(ctx, tx, `SELECT to_jsonb(t) FROM "Team" t WHERE id=$1 AND status='active' FOR NO KEY UPDATE`, input["targetTeamId"])
	if err != nil {
		return nil, err
	}
	const targetSQL = `SELECT to_jsonb(s) FROM "Subscription" s WHERE "teamId"=$1 AND state='active' AND "expireAt">now() AND "remainingTrafficGb">0 ORDER BY "expireAt" DESC,id DESC LIMIT 1`
	target, err := one(ctx, tx, targetSQL, team["id"])
	if err == pgx.ErrNoRows {
		return nil, fail(409, "目标团队没有可用团队订阅")
	}
	if err != nil {
		return nil, err
	}
	ids := []string{text(initial, "id"), text(target, "id")}
	if err = lockRuntimeSubscriptionSet(ctx, tx, ids); err != nil {
		return nil, err
	}
	sub, err := one(ctx, tx, `SELECT to_jsonb(s) FROM "Subscription" s WHERE id=$1`, initial["id"])
	if err == pgx.ErrNoRows {
		return nil, fail(409, "订阅归属在等待期间已变化，请重试")
	}
	if err != nil {
		return nil, err
	}
	if sub["teamId"] != nil || sub["userId"] != initial["userId"] {
		return nil, fail(409, "订阅归属在等待期间已变化，请重试")
	}
	teamSub, err := one(ctx, tx, targetSQL, team["id"])
	if err == pgx.ErrNoRows {
		return nil, fail(409, "目标团队可用订阅在等待期间已变化，请重试")
	}
	if err != nil {
		return nil, err
	}
	if teamSub["id"] != target["id"] {
		return nil, fail(409, "目标团队可用订阅在等待期间已变化，请重试")
	}
	var member bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "TeamMember" WHERE "userId"=$1)`, sub["userId"]).Scan(&member); err != nil {
		return nil, err
	}
	if member {
		return nil, fail(409, "该账号已属于团队")
	}
	if _, err = insert(ctx, tx, "TeamMember", Object{"teamId": team["id"], "userId": sub["userId"], "role": "member"}); err != nil {
		return nil, err
	}
	if err = lockRuntimeBindingsAndNodes(ctx, tx, ids); err != nil {
		return nil, err
	}
	if _, err = update(ctx, tx, "Subscription", text(sub, "id"), Object{"state": "expired", "expireAt": now(), "remainingTrafficGb": 0, "sourceAction": "adjusted", "lastSyncedAt": now()}, "state", "expireAt", "remainingTrafficGb", "sourceAction", "lastSyncedAt"); err != nil {
		return nil, err
	}
	if _, err = s.revokeLeases(ctx, tx, "subscriptionId", text(sub, "id"), "team_access_revoked"); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE "SupportTicket" SET status='closed',"closedAt"=now(),"updatedAt"=now() WHERE "userId"=$1 AND "teamId" IS NULL AND status<>'closed'`, sub["userId"]); err != nil {
		return nil, err
	}
	if err = s.syncSubscriptionBindings(ctx, tx, text(teamSub, "id")); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.changed("subscriptions", text(sub, "userId"))
	return Object{"ok": true, "deletedSubscriptionId": sub["id"], "teamId": team["id"], "teamName": team["name"], "teamSubscriptionId": teamSub["id"], "message": "个人订阅已停用，账号已转入团队。"}, nil
}
