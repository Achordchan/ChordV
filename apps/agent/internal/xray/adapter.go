// Package xray is the boundary between the agent and the Xray instance it
// provisions users into.
//
// Under B1 that instance is the one 3x-ui already runs, reached over its local
// gRPC API. The API has NO authentication and NO per-method ACL: whatever can
// reach it can also delete the panel's inbounds and rewrite routing. Every use
// here is therefore deliberately narrow — read counters, add and remove users —
// and nothing in this package creates or destroys an inbound.
package xray

import (
	"context"
	"errors"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

// LiveUser is one account currently installed in the inbound.
type LiveUser struct {
	Email string
	Flow  string
}

// Adapter is what the runner needs from Xray. The gRPC implementation lands in
// P2 together with the panel-inbound onboarding; keeping it behind an interface
// is what lets the protocol and metering layers be reviewed and tested without
// dragging in xray-core's protobuf tree.
type Adapter interface {
	// Health reports whether the control API answers at all.
	Health(ctx context.Context) error
	// UptimeSeconds is how long the Xray process has been running. Users added
	// over gRPC live only in memory, so a falling uptime is the signal that they
	// are gone and must be reinstalled.
	UptimeSeconds(ctx context.Context) (int64, error)
	// ListUsers returns the accounts currently installed in the configured
	// inbound — under B1 that includes any the PANEL put there. See
	// commands.Processor for why that matters.
	ListUsers(ctx context.Context) ([]LiveUser, error)
	// EnsureUser installs or updates one account.
	EnsureUser(ctx context.Context, user protocol.DesiredUser) error
	// RemoveUser uninstalls one account by email. Removing an account that is
	// not there must succeed: every caller is a reconcile that may run twice.
	RemoveUser(ctx context.Context, email string) error
	// ReadAbsoluteCounters reads every account's cumulative traffic WITHOUT
	// resetting it. Reset-on-read is what makes two readers steal from each
	// other, and 3x-ui is the other reader.
	ReadAbsoluteCounters(ctx context.Context) ([]protocol.AbsoluteCounter, error)
}

// ErrNotBuilt is what the placeholder adapter returns. It is a distinct error so
// a caller can tell "this build cannot talk to Xray" from "Xray is down".
var ErrNotBuilt = errors.New("本构建尚未包含 Xray gRPC 适配器（P2 提供）")

// Unavailable is the placeholder used until P2 lands the real adapter. It fails
// every call loudly rather than pretending to succeed: an agent that reported
// users as provisioned without installing them would look healthy while serving
// nobody.
type Unavailable struct{}

func (Unavailable) Health(context.Context) error                           { return ErrNotBuilt }
func (Unavailable) UptimeSeconds(context.Context) (int64, error)           { return 0, ErrNotBuilt }
func (Unavailable) ListUsers(context.Context) ([]LiveUser, error)          { return nil, ErrNotBuilt }
func (Unavailable) EnsureUser(context.Context, protocol.DesiredUser) error { return ErrNotBuilt }
func (Unavailable) RemoveUser(context.Context, string) error               { return ErrNotBuilt }
func (Unavailable) ReadAbsoluteCounters(context.Context) ([]protocol.AbsoluteCounter, error) {
	return nil, ErrNotBuilt
}
