package api

import (
	"github.com/Achordchan/ChordV/apps/server/internal/buildinfo"
	"net/http"
)

func (s *Server) tauriUpdate(w http.ResponseWriter, _ *http.Request, _ Object) (any, error) {
	// The old key alone cannot make MyGo NSIS honor Tauri /P /UPDATE /R /ARGS
	// or migrate its installation registry. Keep this production gate closed
	// until an independent Windows installation acceptance exists.
	w.WriteHeader(http.StatusNoContent)
	return nil, nil
}
func (s *Server) systemVersion(_ http.ResponseWriter, _ *http.Request, _ Object) (any, error) {
	return Object{"currentVersion": buildinfo.Version, "commit": buildinfo.Commit, "builtAt": buildinfo.BuiltAt, "runtime": "go", "releaseSource": "github", "localOnly": !s.Config.Production(), "selfUpdateEnabled": false}, nil
}
