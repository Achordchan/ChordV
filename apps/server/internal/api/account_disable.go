package api

import "context"

// Callers hold the administrator guard and the current user row in their transaction.
func (s *Server) disableUserAccount(ctx context.Context, q queryer, user Object) (int64, error) {
	if user["role"] == "admin" && user["status"] == "active" {
		var count int
		if err := q.QueryRow(ctx, `SELECT count(*) FROM "User" WHERE role='admin' AND status='active'`).Scan(&count); err != nil {
			return 0, err
		}
		if count <= 1 {
			return 0, fail(409, "至少保留一名启用的管理员")
		}
	}
	id := text(user, "id")
	if _, err := q.Exec(ctx, `UPDATE "User" SET status='disabled',"authVersion"="authVersion"+1,"updatedAt"=now() WHERE id=$1`, id); err != nil {
		return 0, err
	}
	if _, err := q.Exec(ctx, `UPDATE "RefreshToken" SET "revokedAt"=now(),"updatedAt"=now() WHERE "userId"=$1`, id); err != nil {
		return 0, err
	}
	return s.revokeLeases(ctx, q, "userId", id, "account_disabled")
}
