package api

import (
	"context"
	"time"
)

func (s *Server) waitBindingInstalled(ctx context.Context, id string, events <-chan Object) error {
	deadline, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		state, err := one(deadline, s.DB, `SELECT jsonb_build_object('bindingStatus',b.status,'commandStatus',j.status) FROM "PanelClientBinding" b LEFT JOIN "NodeCommandJob" j ON j."bindingId"=b.id AND j."targetRevision"=(SELECT max("targetRevision") FROM "NodeCommandJob" WHERE "bindingId"=b.id AND "commandType" IN('ENSURE_USER','ENABLE_USER')) AND j."commandType" IN('ENSURE_USER','ENABLE_USER') WHERE b.id=$1 ORDER BY j."createdAt" DESC LIMIT 1`, id)
		if err != nil {
			return err
		}
		if state["bindingStatus"] != "active" {
			return fail(409, "节点账号已停用，不能继续建立连接")
		}
		if state["commandStatus"] == "completed" {
			return nil
		}
		if state["commandStatus"] == "failed" || state["commandStatus"] == "cancelled" {
			return fail(503, "节点账号同步未完成，请在后台查看同步任务")
		}
		select {
		case <-deadline.Done():
			return fail(503, "节点尚未确认账号同步，未建立连接；请检查本地 Agent 后重试")
		case <-s.resyncStop:
			return fail(503, "本地服务正在退出")
		case <-events:
		}
	}
}
