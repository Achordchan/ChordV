// Package apiclient speaks the agent half of the ChordV control-plane API.
package apiclient

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

// Timeouts match the Node agent's. The events stream is deliberately excluded:
// it is long-lived by design and is bounded by its context instead.
const (
	RequestTimeout  = 15 * time.Second
	RegisterTimeout = 30 * time.Second
)

// Error carries the status code so a caller can tell "revoked credential" (401)
// from "control plane is having a bad day" (5xx).
type Error struct {
	Path       string
	StatusCode int
	Body       string
}

func (e *Error) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("Agent API %s 返回 HTTP %d", e.Path, e.StatusCode)
	}
	return fmt.Sprintf("Agent API %s 返回 HTTP %d %s", e.Path, e.StatusCode, e.Body)
}

// Unauthorized reports a credential the control plane no longer accepts.
func (e *Error) Unauthorized() bool {
	return e.StatusCode == http.StatusUnauthorized || e.StatusCode == http.StatusForbidden
}

// Options identify this agent on every authenticated request.
type Options struct {
	BaseURL string
	Token   string
	AgentID string
	NodeID  string
	// HTTPClient is injectable for tests; nil uses a client with RequestTimeout.
	HTTPClient *http.Client
}

// Client is safe for concurrent use.
type Client struct {
	options Options
	http    *http.Client
	// stream has no timeout: an SSE connection is supposed to stay open, and a
	// client-level deadline would tear it down mid-command.
	stream *http.Client
}

// MaxRedirects matches net/http's own default hop limit.
const MaxRedirects = 10

// redirectPolicy refuses any redirect that would carry credentials somewhere
// the operator did not configure.
//
// net/http's default is not safe here. Its shouldCopyHeaderOnRedirect compares
// only the HOSTNAME, so an https://host → http://host redirect keeps the
// Authorization header and puts the agent's long-lived bearer token on the wire
// in plaintext — and a 307/308 during registration replays the POST BODY, which
// carries both the one-time register token and the agent's new secret. The
// AssertSafeAPIBaseURL check in agentcfg constrains the CONFIGURED URL and says
// nothing about where a response may redirect to.
//
// Scheme and hostname must both match the configured base. The port may differ:
// credentials still stay on the same host under the same transport, and a
// control plane moved to another port behind the same name is a legitimate
// deployment. Anything else is refused BEFORE the request is issued, so the
// credentials never leave this process.
func redirectPolicy(baseURL string) func(*http.Request, []*http.Request) error {
	base, parseErr := url.Parse(baseURL)
	return func(request *http.Request, via []*http.Request) error {
		if parseErr != nil {
			return fmt.Errorf("无法解析控制面地址，拒绝跟随重定向: %w", parseErr)
		}
		if len(via) >= MaxRedirects {
			return errors.New("控制面重定向次数过多")
		}
		if request.URL.Scheme != base.Scheme || !strings.EqualFold(request.URL.Hostname(), base.Hostname()) {
			return fmt.Errorf(
				"拒绝把 Agent 凭据跟随重定向到 %s://%s（已配置的控制面是 %s://%s）",
				request.URL.Scheme, request.URL.Host, base.Scheme, base.Host)
		}
		return nil
	}
}

// New builds a client. The caller supplies already-resolved credentials.
func New(options Options) *Client {
	base := options.HTTPClient
	if base == nil {
		base = &http.Client{Timeout: RequestTimeout}
	}
	// Shallow-copy rather than mutate: an injected client belongs to the caller
	// (a test's TLS-trusting client, say), and silently rewriting its redirect
	// policy would be a side effect it never asked for.
	request := *base
	request.CheckRedirect = redirectPolicy(options.BaseURL)
	return &Client{
		options: options,
		http:    &request,
		// The stream deliberately drops the timeout but keeps the policy: an SSE
		// connection is long-lived, not less sensitive.
		stream: &http.Client{Transport: base.Transport, CheckRedirect: redirectPolicy(options.BaseURL)},
	}
}

// GenerateAgentToken mints the persistent credential the agent will keep.
//
// The AGENT generates it, not the server: the server stores only its hash, so a
// registration whose response is lost between the server's commit and the
// agent's local persistence can be REPLAYED with the same secret and returns
// the same identity. A server-generated token would be unrecoverable there and
// would brick the node. The shape must satisfy the server's
// /^chordv_agent_[A-Za-z0-9_-]{43,128}$/ — 32 random bytes is exactly 43
// unpadded base64url characters.
func GenerateAgentToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return "chordv_agent_" + base64.RawURLEncoding.EncodeToString(buffer), nil
}

// Register performs the unauthenticated one-time-token exchange.
func Register(ctx context.Context, client *http.Client, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
	base := client
	if base == nil {
		base = &http.Client{Timeout: RegisterTimeout}
	}
	// Registration is the MOST redirect-sensitive call in the agent: a 307/308
	// replays the body, which here carries both the one-time register token and
	// the persistent secret this host will be identified by from now on.
	guarded := *base
	guarded.CheckRedirect = redirectPolicy(baseURL)
	client = &guarded
	var result protocol.RegisterResponse
	body, err := json.Marshal(payload)
	if err != nil {
		return result, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/agent/v1/register", bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return result, fmt.Errorf("Agent 注册失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 200))
		return result, fmt.Errorf("Agent 注册失败 HTTP %d %s", response.StatusCode, string(raw))
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return result, fmt.Errorf("Agent 注册响应无法解析: %w", err)
	}
	return result, nil
}

func (c *Client) do(ctx context.Context, method, path string, payload any, out any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.options.BaseURL+path, body)
	if err != nil {
		return err
	}
	c.applyAuth(request)
	response, err := c.http.Do(request)
	if err != nil {
		// A CheckRedirect refusal is the one error path that still hands back a
		// response, with its body OPEN (net/http keeps it for Go 1 compat). Not
		// closing it leaks the connection on every refused redirect.
		if response != nil {
			response.Body.Close()
		}
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 200))
		return &Error{Path: path, StatusCode: response.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(out)
}

// applyAuth sets the three headers the server's AgentAuthGuard checks together.
// The guard compares the id headers against the agent the TOKEN resolves to, so
// all three must describe one identity or the request is rejected as invalid.
func (c *Client) applyAuth(request *http.Request) {
	request.Header.Set("authorization", "Bearer "+c.options.Token)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-chordv-agent-id", c.options.AgentID)
	request.Header.Set("x-chordv-node-id", c.options.NodeID)
}

// GetConfig fetches the full desired state for this node.
func (c *Client) GetConfig(ctx context.Context) (protocol.ConfigSnapshot, error) {
	var snapshot protocol.ConfigSnapshot
	err := c.do(ctx, http.MethodGet, "/api/agent/v1/config", nil, &snapshot)
	return snapshot, err
}

// WhoAmI returns the source address the control plane sees for this agent.
func (c *Client) WhoAmI(ctx context.Context) (protocol.WhoAmI, error) {
	var result protocol.WhoAmI
	err := c.do(ctx, http.MethodGet, "/api/agent/v1/whoami", nil, &result)
	return result, err
}

// Heartbeat reports liveness and returns the server's ack watermark.
func (c *Client) Heartbeat(ctx context.Context, payload protocol.Heartbeat) (protocol.HeartbeatAck, error) {
	var ack protocol.HeartbeatAck
	err := c.do(ctx, http.MethodPost, "/api/agent/v1/heartbeat", payload, &ack)
	return ack, err
}

// UploadBatch delivers one metering batch.
//
// A nil Samples slice marshals to JSON `null`, and the server's
// AgentUsageBatchDto requires @IsArray() — so a batch built with valid metadata
// but no samples would be rejected with a 400 that the agent can only retry
// forever. An empty array is accepted, so normalise here rather than relying on
// every caller to construct the slice.
func (c *Client) UploadBatch(ctx context.Context, batch protocol.UsageBatch) (protocol.UsageBatchAck, error) {
	if batch.Samples == nil {
		batch.Samples = []protocol.UsageSample{}
	}
	var ack protocol.UsageBatchAck
	err := c.do(ctx, http.MethodPost, "/api/agent/v1/usage-batches", batch, &ack)
	return ack, err
}

// ReportCommandResult acknowledges one command. The id travels in the PATH, so
// it is stripped from the body to match the server's AgentCommandResultDto,
// which whitelists its fields and would reject an extra one.
func (c *Client) ReportCommandResult(ctx context.Context, result protocol.CommandResult) error {
	body := struct {
		Status string         `json:"status"`
		Result map[string]any `json:"result,omitempty"`
		Error  string         `json:"error,omitempty"`
	}{Status: result.Status, Result: result.Result, Error: result.Error}
	path := "/api/agent/v1/commands/" + url.PathEscape(result.CommandID) + "/result"
	return c.do(ctx, http.MethodPost, path, body, nil)
}

// ConsumeEvents streams commands until ctx is cancelled or the stream ends.
// onCommand runs inline: the server may deliver commands whose order matters,
// so they are handled one at a time rather than fanned out.
func (c *Client) ConsumeEvents(ctx context.Context, onCommand func(protocol.Command) error) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.options.BaseURL+"/api/agent/v1/events", nil)
	if err != nil {
		return err
	}
	request.Header.Set("accept", "text/event-stream")
	request.Header.Set("authorization", "Bearer "+c.options.Token)
	request.Header.Set("x-chordv-agent-id", c.options.AgentID)
	request.Header.Set("x-chordv-node-id", c.options.NodeID)
	response, err := c.stream.Do(request)
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 200))
		return &Error{Path: "/api/agent/v1/events", StatusCode: response.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	return readEventStream(ctx, response.Body, onCommand)
}

// MaxFrameBytes bounds one SSE frame. Without it a stream that never emits a
// blank line would grow the buffer without limit on a memory-constrained VPS.
const MaxFrameBytes = 1 << 20

func readEventStream(ctx context.Context, body io.Reader, onCommand func(protocol.Command) error) error {
	reader := make([]byte, 4096)
	var buffer strings.Builder
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		read, err := body.Read(reader)
		if read > 0 {
			buffer.Write(reader[:read])
			// Normalise the WHOLE buffer, not the chunk: a CRLF can straddle a
			// read boundary, and half of it would otherwise survive into the
			// frame and corrupt the field name it precedes.
			normalized := strings.ReplaceAll(buffer.String(), "\r\n", "\n")
			buffer.Reset()
			for {
				boundary := strings.Index(normalized, "\n\n")
				if boundary < 0 {
					break
				}
				frame := normalized[:boundary]
				normalized = normalized[boundary+2:]
				command, ok := ParseSSEFrame(frame)
				if !ok {
					continue
				}
				if err := onCommand(command); err != nil {
					return err
				}
			}
			if len(normalized) > MaxFrameBytes {
				return fmt.Errorf("SSE 单帧超过 %d 字节，判定为异常流", MaxFrameBytes)
			}
			buffer.WriteString(normalized)
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// ParseSSEFrame turns one raw frame into a command, reporting false for frames
// that carry no command (keepalives, comments, malformed payloads). A frame the
// agent cannot understand is skipped rather than fatal: the stream also carries
// the keepalives that prove the connection is alive.
func ParseSSEFrame(frame string) (protocol.Command, bool) {
	var command protocol.Command
	var data []string
	for _, line := range strings.Split(strings.ReplaceAll(frame, "\r", ""), "\n") {
		switch {
		case strings.HasPrefix(line, "event:"):
			if strings.TrimSpace(line[len("event:"):]) == "keepalive" {
				return command, false
			}
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimLeft(line[len("data:"):], " "))
		}
	}
	if len(data) == 0 {
		return command, false
	}
	if err := json.Unmarshal([]byte(strings.Join(data, "\n")), &command); err != nil {
		return protocol.Command{}, false
	}
	// The same four fields the Node agent requires. A command missing any of
	// them cannot be executed OR reported against, so it is not a command.
	if command.CommandID == "" || command.Type == "" || command.TargetRevision == "" || command.Payload == nil {
		return protocol.Command{}, false
	}
	return command, true
}
