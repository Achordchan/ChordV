package api

import (
	"github.com/Achordchan/ChordV/apps/server/internal/buildinfo"
	"net/http"
)

func (s *Server) routes(mux *http.ServeMux) {
	s.handle(mux, "POST /api/integrations/achord-connect/webhook", "", s.supportWebhook)
	s.handle(mux, "GET /api/health/ready", "", s.health)
	s.handle(mux, "GET /api/admin/system/version", "admin", s.systemVersion)
	s.handle(mux, "GET /api/health", "", s.health)
	s.handle(mux, "POST /api/auth/login", "", s.login)
	s.handle(mux, "POST /api/auth/admin/login", "", s.login)
	s.handle(mux, "POST /api/auth/refresh", "", s.refresh)
	s.handle(mux, "POST /api/auth/logout", "", s.logout)
	s.handle(mux, "GET /api/admin/events/stream", "admin", s.stream)
	s.handle(mux, "GET /api/client/events/stream", "user", s.stream)
	s.adminRoutes(mux)
	s.clientRoutes(mux)
}
func (s *Server) health(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	if err := s.DB.Ping(r.Context()); err != nil {
		return nil, fail(503, "本地数据库不可用")
	}
	return Object{"status": "ok", "service": "chordv-go-server", "mode": s.Config.RuntimeMode(), "version": buildinfo.Version, "time": now()}, nil
}
