package apiclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

func newTestClient(handler http.Handler) (*Client, func()) {
	server := httptest.NewServer(handler)
	client := New(Options{
		BaseURL: server.URL,
		Token:   "chordv_agent_secret",
		AgentID: "agent-1",
		NodeID:  "node-1",
	})
	return client, server.Close
}

func TestAuthenticatedRequestsCarryAllThreeIdentityHeaders(t *testing.T) {
	// The server's AgentAuthGuard resolves the agent from the TOKEN and then
	// compares both id headers against it. Omitting or mismatching any one is a
	// 401, so all three must describe the same identity on every request.
	var got http.Header
	client, closeServer := newTestClient(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		got = request.Header.Clone()
		writer.Write([]byte(`{"nodeId":"node-1","revision":"1","controlMode":"shadow_direct","users":[]}`))
	}))
	defer closeServer()

	if _, err := client.GetConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got.Get("authorization") != "Bearer chordv_agent_secret" {
		t.Fatalf("authorization = %q", got.Get("authorization"))
	}
	if got.Get("x-chordv-agent-id") != "agent-1" || got.Get("x-chordv-node-id") != "node-1" {
		t.Fatalf("identity headers = %q / %q", got.Get("x-chordv-agent-id"), got.Get("x-chordv-node-id"))
	}
}

func TestEventStreamRequestCarriesIdentityAndAcceptsSSE(t *testing.T) {
	var got http.Header
	client, closeServer := newTestClient(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		got = request.Header.Clone()
	}))
	defer closeServer()

	if err := client.ConsumeEvents(context.Background(), func(protocol.Command) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if got.Get("accept") != "text/event-stream" {
		t.Fatalf("accept = %q", got.Get("accept"))
	}
	// The stream goes through the same guard as everything else; a stream opened
	// without the id headers is rejected and the agent receives no commands.
	if got.Get("authorization") == "" || got.Get("x-chordv-agent-id") != "agent-1" || got.Get("x-chordv-node-id") != "node-1" {
		t.Fatalf("event stream opened without full identity: %v", got)
	}
}

func TestCommandResultOmitsCommandIdFromBody(t *testing.T) {
	// The id travels in the path. AgentCommandResultDto whitelists its fields,
	// and the API runs a whitelisting validation pipe, so an extra property is
	// a 400 — the command would then be retried forever.
	var requestURI string
	var body map[string]any
	client, closeServer := newTestClient(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		// The RAW request line, not URL.Path: the latter is already decoded, so
		// asserting on it cannot tell an escaped id from an injected path.
		requestURI = request.RequestURI
		raw, _ := io.ReadAll(request.Body)
		json.Unmarshal(raw, &body)
		writer.Write([]byte(`{"accepted":true}`))
	}))
	defer closeServer()

	err := client.ReportCommandResult(context.Background(), protocol.CommandResult{
		CommandID: "cmd/with space",
		Status:    protocol.StatusCompleted,
		Result:    map[string]any{"appliedRevision": "7"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := body["commandId"]; present {
		t.Fatalf("body carried commandId, which the server's DTO rejects: %v", body)
	}
	if body["status"] != "completed" {
		t.Fatalf("body = %v", body)
	}
	if requestURI != "/api/agent/v1/commands/cmd%2Fwith%20space/result" {
		// An unescaped id containing a slash would silently address a different
		// route, and the command would never be acknowledged.
		t.Fatalf("request line = %q, want the id escaped into ONE path segment", requestURI)
	}
}

func TestErrorReportsStatusAndRevocation(t *testing.T) {
	client, closeServer := newTestClient(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "Agent 凭据无效或已撤销", http.StatusUnauthorized)
	}))
	defer closeServer()

	_, err := client.Heartbeat(context.Background(), protocol.Heartbeat{})
	apiError, ok := err.(*Error)
	if !ok {
		t.Fatalf("err = %T %v, want *Error", err, err)
	}
	// A revoked credential must be distinguishable from a transient outage, or
	// the agent retries a dead identity forever instead of reporting it.
	if !apiError.Unauthorized() || apiError.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Error = %+v", apiError)
	}
}

func TestGenerateAgentTokenMatchesTheServerPattern(t *testing.T) {
	// Server: /^chordv_agent_[A-Za-z0-9_-]{43,128}$/. A padded or standard
	// base64 alphabet would be rejected at registration.
	pattern := regexp.MustCompile(`^chordv_agent_[A-Za-z0-9_-]{43,128}$`)
	seen := map[string]bool{}
	for i := 0; i < 32; i++ {
		token, err := GenerateAgentToken()
		if err != nil {
			t.Fatal(err)
		}
		if !pattern.MatchString(token) {
			t.Fatalf("token %q does not match the control plane's pattern", token)
		}
		if seen[token] {
			t.Fatalf("GenerateAgentToken repeated a value: %q", token)
		}
		seen[token] = true
	}
}

func TestRegisterSurfacesServerRejection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "注册令牌已失效", http.StatusBadRequest)
	}))
	defer server.Close()

	_, err := Register(context.Background(), nil, server.URL, protocol.RegisterRequest{})
	if err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("Register hid the server's rejection: %v", err)
	}
}

// --- SSE framing -----------------------------------------------------------

func TestParseSSEFrameSkipsNonCommands(t *testing.T) {
	// Keepalives prove the connection is alive; treating one as a malformed
	// command would tear down a healthy stream every interval.
	if _, ok := ParseSSEFrame("event: keepalive\ndata: {}"); ok {
		t.Fatal("keepalive frame was parsed as a command")
	}
	if _, ok := ParseSSEFrame(": comment only"); ok {
		t.Fatal("comment frame was parsed as a command")
	}
	if _, ok := ParseSSEFrame("data: not json"); ok {
		t.Fatal("malformed JSON was parsed as a command")
	}
	// Each of these is unexecutable OR unreportable, so it is not a command.
	for _, body := range []string{
		`{"type":"ENSURE_USER","targetRevision":"1","payload":{}}`,
		`{"commandId":"c1","targetRevision":"1","payload":{}}`,
		`{"commandId":"c1","type":"ENSURE_USER","payload":{}}`,
		`{"commandId":"c1","type":"ENSURE_USER","targetRevision":"1"}`,
	} {
		if _, ok := ParseSSEFrame("data: " + body); ok {
			t.Fatalf("incomplete command was accepted: %s", body)
		}
	}
}

func TestParseSSEFrameJoinsMultiLineData(t *testing.T) {
	frame := "event: command\ndata: {\"commandId\":\"c1\",\"type\":\"ENSURE_USER\",\n" +
		"data: \"targetRevision\":\"7\",\"payload\":{\"bindingId\":\"b1\"}}"
	command, ok := ParseSSEFrame(frame)
	if !ok {
		t.Fatal("a command split across two data lines was dropped")
	}
	if command.CommandID != "c1" || command.TargetRevision != "7" {
		t.Fatalf("command = %+v", command)
	}
	if command.Payload["bindingId"] != "b1" {
		t.Fatalf("payload = %v", command.Payload)
	}
}

// chunkReader hands out fixed-size pieces so a frame boundary — and a CRLF —
// can be forced to straddle two reads, which is what a real socket does.
type chunkReader struct {
	data []byte
	size int
}

func (r *chunkReader) Read(buffer []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	size := r.size
	if size > len(r.data) {
		size = len(r.data)
	}
	if size > len(buffer) {
		size = len(buffer)
	}
	copy(buffer, r.data[:size])
	r.data = r.data[size:]
	return size, nil
}

func TestReadEventStreamHandlesCRLFSplitAcrossReads(t *testing.T) {
	// A CRLF straddling a read boundary would leave a stray \r glued to the next
	// field name if only the newly-arrived chunk were normalised.
	stream := "event: keepalive\r\n\r\n" +
		"data: {\"commandId\":\"c1\",\"type\":\"REFRESH_QUOTA\",\"targetRevision\":\"3\",\"payload\":{}}\r\n\r\n" +
		"data: {\"commandId\":\"c2\",\"type\":\"REFRESH_QUOTA\",\"targetRevision\":\"4\",\"payload\":{}}\r\n\r\n"

	for _, size := range []int{1, 2, 3, 7, 64, 4096} {
		var seen []string
		err := readEventStream(context.Background(), &chunkReader{data: []byte(stream), size: size}, func(command protocol.Command) error {
			seen = append(seen, command.CommandID)
			return nil
		})
		if err != nil {
			t.Fatalf("chunk size %d: %v", size, err)
		}
		if len(seen) != 2 || seen[0] != "c1" || seen[1] != "c2" {
			t.Fatalf("chunk size %d delivered %v, want [c1 c2]", size, seen)
		}
	}
}

func TestReadEventStreamStopsOnHandlerError(t *testing.T) {
	stream := "data: {\"commandId\":\"c1\",\"type\":\"REFRESH_QUOTA\",\"targetRevision\":\"3\",\"payload\":{}}\n\n" +
		"data: {\"commandId\":\"c2\",\"type\":\"REFRESH_QUOTA\",\"targetRevision\":\"4\",\"payload\":{}}\n\n"
	count := 0
	err := readEventStream(context.Background(), strings.NewReader(stream), func(protocol.Command) error {
		count++
		return io.ErrUnexpectedEOF
	})
	if err == nil {
		t.Fatal("a failing handler did not stop the stream")
	}
	// Commands are handled inline BECAUSE their order matters; continuing past a
	// failure would apply a later command on top of state an earlier one never
	// reached.
	if count != 1 {
		t.Fatalf("handler ran %d times after failing once", count)
	}
}

func TestReadEventStreamRefusesAnUnboundedFrame(t *testing.T) {
	// A stream that never emits a blank line would otherwise grow the buffer
	// without limit on a memory-constrained VPS.
	err := readEventStream(context.Background(), strings.NewReader(strings.Repeat("x", MaxFrameBytes+1024)), func(protocol.Command) error {
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "SSE") {
		t.Fatalf("err = %v, want an oversized-frame refusal", err)
	}
}

func TestReadEventStreamStopsWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := readEventStream(ctx, strings.NewReader("data: {}\n\n"), func(protocol.Command) error { return nil })
	if err == nil {
		t.Fatal("a cancelled context did not stop the stream")
	}
}

// --- redirect safety -------------------------------------------------------

// TestRedirectMustNotDowngradeCredentialTransport is the regression for the
// review's security finding. net/http's shouldCopyHeaderOnRedirect compares only
// the HOSTNAME, so an https://host → http://host redirect keeps Authorization
// and puts the agent's long-lived bearer token on the wire in plaintext.
func TestRedirectMustNotDowngradeCredentialTransport(t *testing.T) {
	leaked := make(chan string, 4)
	plaintext := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		leaked <- request.Header.Get("authorization")
		writer.Write([]byte(`{}`))
	}))
	defer plaintext.Close()

	secure := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, plaintext.URL+request.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer secure.Close()

	client := New(Options{
		BaseURL:    secure.URL, // https://127.0.0.1:<port>
		Token:      "chordv_agent_secret",
		AgentID:    "agent-1",
		NodeID:     "node-1",
		HTTPClient: secure.Client(), // trusts the test certificate
	})

	if _, err := client.GetConfig(context.Background()); err == nil {
		t.Fatal("the agent followed a downgrading redirect instead of refusing it")
	}
	if _, err := client.Heartbeat(context.Background(), protocol.Heartbeat{}); err == nil {
		t.Fatal("heartbeat followed a downgrading redirect")
	}
	if err := client.ConsumeEvents(context.Background(), func(protocol.Command) error { return nil }); err == nil {
		t.Fatal("the event stream followed a downgrading redirect")
	}
	select {
	case value := <-leaked:
		t.Fatalf("the bearer token reached a plaintext endpoint: %q", value)
	default:
	}
}

// TestRegisterRedirectDoesNotReplayTheSecrets covers the worst case: a 307/308
// replays the BODY, which during registration carries both the one-time
// register token and the persistent secret this host will be known by.
func TestRegisterRedirectDoesNotReplayTheSecrets(t *testing.T) {
	leaked := make(chan string, 4)
	plaintext := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		leaked <- string(raw)
		writer.Write([]byte(`{"accepted":true,"agentId":"a","nodeId":"n"}`))
	}))
	defer plaintext.Close()

	secure := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, plaintext.URL+request.URL.Path, http.StatusPermanentRedirect)
	}))
	defer secure.Close()

	_, err := Register(context.Background(), secure.Client(), secure.URL, protocol.RegisterRequest{
		RegisterToken: "one-time-secret",
		AgentToken:    "chordv_agent_secret",
	})
	if err == nil {
		t.Fatal("registration followed a downgrading redirect")
	}
	select {
	case body := <-leaked:
		t.Fatalf("registration secrets reached a plaintext endpoint: %s", body)
	default:
	}
}

func TestRedirectPolicyAllowsOnlyTheConfiguredControlPlane(t *testing.T) {
	policy := redirectPolicy("https://v.achord.cn")
	request := func(target string) *http.Request {
		parsed, err := url.Parse(target)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Request{URL: parsed}
	}
	// Same scheme and host: a benign proxy redirect (a trailing slash, a moved
	// port behind the same name) must keep working.
	for _, target := range []string{"https://v.achord.cn/api/agent/v1/config/", "https://V.ACHORD.CN:8443/x"} {
		if err := policy(request(target), nil); err != nil {
			t.Fatalf("policy rejected a same-origin redirect to %s: %v", target, err)
		}
	}
	// A downgrade, a different host, or a hop to an attacker-chosen name must
	// all be refused BEFORE the credentials are sent.
	for _, target := range []string{
		"http://v.achord.cn/api/agent/v1/config",
		"https://evil.example/api/agent/v1/config",
		"http://169.254.169.254/latest/meta-data",
	} {
		if err := policy(request(target), nil); err == nil {
			t.Fatalf("policy allowed credentials to follow a redirect to %s", target)
		}
	}
	// The hop limit still applies, or a redirect loop spins forever.
	if err := policy(request("https://v.achord.cn/x"), make([]*http.Request, MaxRedirects)); err == nil {
		t.Fatal("policy allowed an unbounded redirect chain")
	}
}

func TestUsageBatchWithoutSamplesEncodesAnEmptyArray(t *testing.T) {
	// AgentUsageBatchDto requires @IsArray(); a nil slice marshals to `null` and
	// is rejected with a 400 the agent can only retry forever.
	var body map[string]json.RawMessage
	client, closeServer := newTestClient(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		json.Unmarshal(raw, &body)
		writer.Write([]byte(`{"accepted":true,"duplicate":false,"ackThrough":"0"}`))
	}))
	defer closeServer()

	_, err := client.UploadBatch(context.Background(), protocol.UsageBatch{
		BootID: "boot-1", Sequence: "1", SampledAt: "2026-09-09T00:00:00.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := string(body["samples"]); got != "[]" {
		t.Fatalf("samples encoded as %s, want []", got)
	}
}
