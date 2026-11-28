package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}
type Server struct {
	DB                *pgxpool.Pool
	Config            config.Config
	events            *eventHub
	HTTP              *http.Client
	supportPublishMu  sync.Mutex
	attributesMu      sync.Mutex
	contactAttributes supportAttributeState
	resyncMu          sync.Mutex
	resyncPending     map[string]bool
	resyncStop        chan struct{}
	resyncClose       sync.Once
	resyncContext     context.Context
	resyncCancel      context.CancelFunc
	resyncClosed      bool
	resyncWG          sync.WaitGroup
	presenceTimers    presenceTimers
	tasks             *scheduledTasks
	listenerWG        sync.WaitGroup
	storageMu         sync.Mutex
	agentRelease      *agentReleaseSource
}
type Handler func(http.ResponseWriter, *http.Request, Object) (any, error)
type HTTPError struct {
	Status  int
	Message string
}

func (e HTTPError) Error() string           { return e.Message }
func fail(status int, message string) error { return HTTPError{status, message} }
func New(db *pgxpool.Pool, cfg config.Config) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{DB: db, Config: cfg, agentRelease: executableAgentRelease(), events: newEventHub(), tasks: newScheduledTasks(ctx), resyncPending: map[string]bool{}, resyncStop: make(chan struct{}), presenceTimers: presenceTimers{users: map[string]presenceDeadline{}}, resyncContext: ctx, resyncCancel: cancel, HTTP: &http.Client{Timeout: 20 * time.Second}}
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.routes(mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")
		if origin != "" {
			allowed := false
			for _, v := range s.Config.AllowedOrigins {
				if origin == strings.TrimSpace(v) {
					allowed = true
					break
				}
			}
			if !allowed {
				writeError(w, fail(403, "请求来源未获授权"))
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID, X-Request-Id")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		defer func() {
			if v := recover(); v != nil {
				slog.Error("request panic", "path", r.URL.Path, "error", v)
				writeError(w, fail(500, "服务处理失败"))
			}
		}()
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) handle(mux *http.ServeMux, pattern, role string, fn Handler) {
	mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		var user Object
		var err error
		if role != "" {
			user, err = s.authenticate(r)
			if err != nil {
				writeError(w, err)
				return
			}
			if role == "admin" && user["role"] != "admin" {
				writeError(w, fail(403, "需要管理员权限"))
				return
			}
		}
		value, err := fn(w, r, user)
		if err != nil {
			writeError(w, err)
			return
		}
		if value != nil {
			writeJSON(w, 200, value)
		}
	})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, err error) {
	status := 500
	message := "本地服务处理失败"
	var e HTTPError
	if errors.As(err, &e) {
		status = e.Status
		message = e.Message
	} else if errors.Is(err, pgx.ErrNoRows) {
		status = 404
		message = "记录不存在"
	} else {
		var pg *pgconn.PgError
		if errors.As(err, &pg) {
			switch pg.Code {
			case "23505":
				status = 409
				message = "记录已存在"
			case "23503", "22P02", "22003", "23502", "23514":
				status = 400
				message = "提交数据不符合约束"
			}
		}
		if status >= 500 {
			slog.Error("request failed", "error", err)
		}
	}
	writeJSON(w, status, Object{"statusCode": status, "message": message})
}
func body(w http.ResponseWriter, r *http.Request) (Object, error) {
	var v Object
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		if errors.Is(err, io.EOF) {
			return Object{}, nil
		}
		return nil, fail(400, "请求正文必须是 JSON 对象")
	}
	if v == nil {
		return nil, fail(400, "请求正文不能为空")
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, fail(400, "请求正文只能包含一个 JSON 对象")
	}
	return v, nil
}
func one(ctx context.Context, q queryer, sql string, args ...any) (Object, error) {
	var raw []byte
	if err := q.QueryRow(ctx, sql, args...).Scan(&raw); err != nil {
		return nil, err
	}
	var v Object
	err := json.Unmarshal(raw, &v)
	normalizeDates(v)
	return v, err
}
func list(ctx context.Context, q queryer, sql string, args ...any) ([]Object, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var v Object
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		normalizeDates(v)
		out = append(out, v)
	}
	return out, rows.Err()
}
func text(v Object, k string) string { s, _ := v[k].(string); return strings.TrimSpace(s) }
func number(v Object, k string) float64 {
	switch n := v[k].(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}
func boolean(v Object, k string, fallback bool) bool {
	if b, ok := v[k].(bool); ok {
		return b
	}
	return fallback
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func stringValue(v Object, k string) string { s, _ := v[k].(string); return s }
