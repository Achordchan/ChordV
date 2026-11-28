//go:build darwin

package main

import (
	"bufio"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const macUpdateHealthTimeout = 60 * time.Second
const macHealthSocketEnv = "CHORDV_MAC_UPDATE_HEALTH_SOCKET"
const macHealthIDEnv = "CHORDV_MAC_UPDATE_HEALTH_ID"
const macHealthServerPIDEnv = "CHORDV_MAC_UPDATE_HEALTH_SERVER_PID"

type macHealthMessage struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Challenge string `json:"challenge,omitempty"`
	Error     string `json:"error,omitempty"`
}

func readMacHealthMessage(reader *bufio.Reader) (macHealthMessage, error) {
	var message macHealthMessage
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return message, err
	}
	if len(line) > 4096 {
		return message, errors.New("更新健康消息过大")
	}
	decoder := json.NewDecoder(strings.NewReader(string(line)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&message); err != nil {
		return message, err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return message, errors.New("更新健康消息包含多余内容")
	}
	return message, nil
}

func writeMacHealthMessage(conn net.Conn, message macHealthMessage) error {
	return json.NewEncoder(conn).Encode(message)
}

func macHealthEqual(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

type macUpdateHealthClient struct {
	mu          sync.Mutex
	conn        *net.UnixConn
	reader      *bufio.Reader
	id          string
	challenge   string
	nativeReady bool
	nativeError error
	appReady    bool
	sent        bool
	completed   bool
	err         error
	done        chan error
}

func dialMacUpdateHealth(verifyPeer func(pid int, operation string) error) (*macUpdateHealthClient, error) {
	socket, id, server := os.Getenv(macHealthSocketEnv), os.Getenv(macHealthIDEnv), os.Getenv(macHealthServerPIDEnv)
	// Do not let children accidentally inherit a health session they do not own.
	for _, key := range []string{macHealthSocketEnv, macHealthIDEnv, macHealthServerPIDEnv} {
		_ = os.Unsetenv(key)
	}
	if socket == "" && id == "" && server == "" {
		return nil, nil
	}
	if len(id) == 0 || len(id) > 128 || strings.IndexFunc(id, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_')
	}) >= 0 {
		return nil, errors.New("更新健康会话ID无效")
	}
	pid, err := strconv.Atoi(server)
	if err != nil || pid <= 1 {
		return nil, errors.New("更新健康服务进程无效")
	}
	if err = macHealthPrivateSocket(socket); err != nil {
		return nil, err
	}
	conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = conn.Close()
		}
	}()
	if err = conn.SetDeadline(time.Now().Add(macUpdateHealthTimeout)); err != nil {
		return nil, err
	}
	peer, uid, err := macHealthPeer(conn)
	if err != nil || peer != pid || uid != uint32(os.Getuid()) {
		return nil, errors.New("更新健康服务端内核身份不一致")
	}
	if err = verifyPeer(peer, id); err != nil {
		return nil, err
	}
	if err = writeMacHealthMessage(conn, macHealthMessage{Kind: "hello", ID: id}); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(conn, 4096)
	keep = true
	client := &macUpdateHealthClient{conn: conn, reader: reader, id: id, done: make(chan error, 1)}
	go client.awaitChallengeAndConfirmation()
	return client, nil
}

func (c *macUpdateHealthClient) NativeReady(startupErr error) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.completed {
		return
	}
	if startupErr != nil {
		// Keep the connection open until the helper has authenticated its peer.
		// Closing before accept can discard peer credentials on a queued Unix socket.
		c.nativeError = startupErr
		c.sendReadyLocked()
		return
	}
	c.nativeReady = true
	c.sendReadyLocked()
}

func (c *macUpdateHealthClient) AppReady() error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	if c.completed {
		return nil
	}
	c.appReady = true
	c.sendReadyLocked()
	return c.err
}

func (c *macUpdateHealthClient) sendReadyLocked() {
	if c.sent || c.challenge == "" {
		return
	}
	if c.nativeError != nil {
		c.sent = true
		_ = writeMacHealthMessage(c.conn, macHealthMessage{Kind: "failed", ID: c.id, Challenge: c.challenge, Error: fmt.Sprintf("%.1024s", c.nativeError.Error())})
		c.finishLocked(fmt.Errorf("新应用原生启动失败：%w", c.nativeError))
		return
	}
	if !c.nativeReady || !c.appReady {
		return
	}
	c.sent = true
	if err := writeMacHealthMessage(c.conn, macHealthMessage{Kind: "ready", ID: c.id, Challenge: c.challenge}); err != nil {
		c.finishLocked(err)
		return
	}
}

func (c *macUpdateHealthClient) awaitChallengeAndConfirmation() {
	challenge, err := readMacHealthMessage(c.reader)
	raw, decodeErr := hex.DecodeString(challenge.Challenge)
	if err == nil && (challenge.Kind != "challenge" || !macHealthEqual(challenge.ID, c.id) || challenge.Error != "" || decodeErr != nil || len(raw) != 32) {
		err = errors.New("更新健康挑战无效")
	}
	c.mu.Lock()
	if c.completed {
		c.mu.Unlock()
		return
	}
	if err != nil {
		c.finishLocked(err)
		c.mu.Unlock()
		return
	}
	c.challenge = challenge.Challenge
	c.sendReadyLocked()
	if c.completed {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	reply, err := readMacHealthMessage(c.reader)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.completed {
		return
	}
	if err == nil && (!c.sent || reply.Kind != "healthy" || !macHealthEqual(reply.ID, c.id) || !macHealthEqual(reply.Challenge, c.challenge) || reply.Error != "") {
		err = errors.New("独立安装进程未确认新应用健康")
	}
	c.finishLocked(err)
}

func (c *macUpdateHealthClient) finishLocked(err error) {
	if c.completed {
		return
	}
	c.completed = true
	c.err = err
	_ = c.conn.Close()
	c.done <- err
	close(c.done)
}

func (c *macUpdateHealthClient) Done() <-chan error {
	if c == nil {
		return nil
	}
	return c.done
}
func (c *macUpdateHealthClient) Close() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.completed {
		c.finishLocked(errors.New("新应用在健康确认前关闭"))
	}
}
