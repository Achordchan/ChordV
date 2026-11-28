package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"sync"
	"time"
)

type NativeEvent struct {
	Name    string `json:"name"`
	Payload any    `json:"payload"`
}

type runtimeConfig struct {
	SessionID                     string          `json:"sessionId"`
	LeaseID                       string          `json:"leaseId"`
	LeaseExpiresAt                string          `json:"leaseExpiresAt"`
	LeaseHeartbeatIntervalSeconds int             `json:"leaseHeartbeatIntervalSeconds"`
	LeaseGraceSeconds             int             `json:"leaseGraceSeconds"`
	Node                          nodeSummary     `json:"node"`
	Mode                          string          `json:"mode"`
	LocalHTTPPort                 int             `json:"localHttpPort"`
	LocalSocksPort                int             `json:"localSocksPort"`
	RoutingProfile                string          `json:"routingProfile"`
	GeneratedAt                   string          `json:"generatedAt"`
	Features                      runtimeFeatures `json:"features"`
	CustomRoutingRules            []routingRule   `json:"customRoutingRules"`
	Outbound                      runtimeOutbound `json:"outbound"`
}

type nodeSummary struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	ServerHost  string   `json:"serverHost"`
	ServerPort  int      `json:"serverPort"`
	CountryCode *string  `json:"countryCode"`
	Region      string   `json:"region"`
	Provider    string   `json:"provider"`
	Tags        []string `json:"tags"`
	IsActive    *bool    `json:"isActive,omitempty"`
	Recommended bool     `json:"recommended"`
	LatencyMs   int      `json:"latencyMs"`
	Protocol    string   `json:"protocol"`
	Security    string   `json:"security"`
}

type runtimeOutbound struct {
	Protocol         string `json:"protocol"`
	Server           string `json:"server"`
	Port             int    `json:"port"`
	UUID             string `json:"uuid"`
	Flow             string `json:"flow"`
	RealityPublicKey string `json:"realityPublicKey"`
	ShortID          string `json:"shortId"`
	ServerName       string `json:"serverName"`
	Fingerprint      string `json:"fingerprint"`
	SpiderX          string `json:"spiderX"`
	MLDSA65Verify    string `json:"mldsa65Verify,omitempty"`
}

type runtimeFeatures struct {
	BlockAds        bool `json:"blockAds"`
	ChinaDirect     bool `json:"chinaDirect"`
	AIServicesProxy bool `json:"aiServicesProxy"`
}

type routingRule struct {
	ID        string  `json:"id"`
	UserID    string  `json:"userId"`
	Name      *string `json:"name"`
	Value     string  `json:"value"`
	MatchType string  `json:"matchType"`
	Action    string  `json:"action"`
	Enabled   bool    `json:"enabled"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

type runtimeState struct {
	Status          string         `json:"status"`
	ActiveSessionID *string        `json:"activeSessionId"`
	ActiveNodeID    *string        `json:"activeNodeId"`
	ActiveNodeName  *string        `json:"activeNodeName"`
	ConfigPath      *string        `json:"configPath"`
	LogPath         *string        `json:"logPath"`
	XrayBinaryPath  *string        `json:"xrayBinaryPath"`
	ActivePID       *int           `json:"activePid"`
	LastError       *string        `json:"lastError"`
	PlatformTarget  string         `json:"platformTarget"`
	LastStartedAt   *string        `json:"lastStartedAt"`
	Config          *runtimeConfig `json:"-"`
	process         *exec.Cmd
	processDone     chan struct{}
	processErr      error
	heartbeatCancel context.CancelFunc
	watchdog        *proxyWatchdog
}

type componentItem struct {
	ID               string  `json:"id"`
	Revision         *string `json:"revision"`
	VersionLabel     *string `json:"versionLabel"`
	Component        string  `json:"component"`
	FileName         string  `json:"fileName"`
	FileSizeBytes    *int64  `json:"fileSizeBytes"`
	SourceFormat     string  `json:"sourceFormat"`
	ArchiveEntryName *string `json:"archiveEntryName"`
	ChecksumSHA256   *string `json:"checksumSha256"`
}

type downloadProgress struct {
	Phase           string  `json:"phase"`
	Component       string  `json:"component,omitempty"`
	FileName        *string `json:"fileName"`
	DownloadedBytes int64   `json:"downloadedBytes"`
	TotalBytes      *int64  `json:"totalBytes"`
	LocalPath       *string `json:"localPath"`
	Message         *string `json:"message"`
}

type DesktopService struct {
	releaseBindings releaseBindingCache
	cfg             appConfig
	mu              sync.Mutex
	runtime         runtimeState
	operationMu     sync.Mutex
	installing      bool
	macUpdateMu     sync.Mutex
	macUpdate       *macUpdateHandoff
	updateHealth    *macUpdateHealthClient
	sessions        sessionStore
	streamsMu       sync.Mutex
	streams         map[string]*eventStreamHandle
	downloadMu      sync.Mutex
	downloadCancel  context.CancelFunc
	pendingMu       sync.Mutex
	pending         *pendingInstaller
	emit            func(NativeEvent)
	shell           *desktopShell
	ctx             context.Context
	cancel          context.CancelFunc
	lastNudge       time.Time
	authorizedMu    sync.Mutex
	authorized      map[string]releaseAssetGrant
	startupDone     chan struct{}
	startupErr      error
	apiTransport    *http.Transport
}

func newDesktopService(cfg appConfig) *DesktopService {
	ctx, cancel := context.WithCancel(context.Background())
	return &DesktopService{cfg: cfg, runtime: runtimeState{Status: "idle", PlatformTarget: platformName()}, streams: map[string]*eventStreamHandle{}, sessions: sessionStore{retired: map[string]bool{}}, ctx: ctx, cancel: cancel, emit: func(NativeEvent) {}, authorized: map[string]releaseAssetGrant{}, apiTransport: newAPITransport()}
}

func (s *DesktopService) publish(name string, payload any) {
	s.emit(NativeEvent{Name: name, Payload: payload})
}
func decode(input json.RawMessage, target any) error {
	if len(input) == 0 || string(input) == "null" {
		input = []byte("{}")
	}
	return json.Unmarshal(input, target)
}
func pointer[T any](value T) *T { return &value }
