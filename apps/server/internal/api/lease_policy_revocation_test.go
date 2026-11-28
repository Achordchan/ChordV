package api

import (
	"testing"
	"time"
)

func TestLeasePolicyExplicitRevocationNeverUsesGraceToRenewHTTP(t *testing.T) {
	for _, kind := range []string{"node", "subscription", "user"} {
		t.Run(kind, func(t *testing.T) {
			f := newLeasePolicyFixture(t, false, 1)
			at := time.Now().UTC()
			lease := f.seed(t, "grace", 0, at.Add(-time.Hour), at.Add(-time.Minute), at.Add(-60*time.Second))
			switch kind {
			case "node":
				f.a.call("PATCH", "/api/admin/nodes/"+text(f.nodes[0], "id"), Object{"isActive": false}, 200)
			case "subscription":
				f.a.call("PATCH", "/api/admin/subscriptions/"+text(f.sub, "id"), Object{"state": "paused"}, 200)
			case "user":
				f.a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"status": "disabled"}, 200)
			}
			client := &testAPI{t: t, server: f.a.server, http: f.a.http, token: f.userToken}
			status, response := routingContractRequest(t, client, "POST", "/api/client/session/heartbeat", Object{"sessionId": lease["sessionId"]})
			if kind == "user" {
				if status != 401 {
					t.Fatal("账号停用立即失去鉴权，不能以租约宽限续租", status, response)
				}
			} else if status != 200 || response["status"] != "revoked" {
				t.Fatal("明确节点/订阅撤权必须typed终态而非active续租", status, response)
			}
			if f.row(t, text(lease, "id"))["expiresAt"] != lease["expiresAt"] {
				t.Fatal("明确撤权不得延长expiresAt")
			}
		})
	}
}
