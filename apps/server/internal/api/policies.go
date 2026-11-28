package api

import "net/http"

func (s *Server) policy(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	row, err := one(r.Context(), s.DB, `SELECT jsonb_build_object('defaultMode',p."defaultMode",'modes',p.modes,'features',jsonb_build_object('blockAds',p."blockAds",'chinaDirect',p."chinaDirect",'aiServicesProxy',p."aiServicesProxy"),'customRoutingRules','[]'::jsonb) FROM "PolicyProfile" p WHERE id='default'`)
	return row, err
}
func (s *Server) savePolicy(w http.ResponseWriter, r *http.Request, u Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	for _, field := range []string{"blockAds", "chinaDirect", "aiServicesProxy"} {
		if value, provided := input[field]; provided {
			if _, valid := value.(bool); !valid {
				return nil, fail(400, field+" 必须是布尔值")
			}
		}
	}
	if err = enum(input, "defaultMode", "rule", "global", "direct"); err != nil {
		return nil, err
	}
	old, err := one(r.Context(), s.DB, `SELECT to_jsonb(p) FROM "PolicyProfile" p WHERE id='default'`)
	if err != nil {
		return nil, err
	}
	merged := Object{}
	for key, v := range old {
		merged[key] = v
	}
	for key, v := range input {
		merged[key] = v
	}
	modes, err := stringArray(merged["modes"], 3)
	if err != nil || len(modes) == 0 {
		return nil, fail(400, "至少保留一种连接模式")
	}
	contains := false
	for _, mode := range modes {
		if mode != "rule" && mode != "global" && mode != "direct" {
			return nil, fail(400, "连接模式无效")
		}
		contains = contains || mode == merged["defaultMode"]
	}
	if !contains {
		return nil, fail(400, "默认模式必须在允许模式中")
	}
	if _, err = update(r.Context(), s.DB, "PolicyProfile", "default", input, "defaultMode", "modes", "blockAds", "chinaDirect", "aiServicesProxy"); err != nil {
		return nil, err
	}
	s.changed("policies", "")
	return s.policy(w, r, u)
}
