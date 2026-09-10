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

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

// LiveUser is one account currently installed in the inbound.
type LiveUser struct {
	Email string
	Flow  string
	// UUID is the account's identity, and it is what distinguishes an account
	// this agent installed from one the 3x-ui panel created at the same address.
	// Email alone cannot: the inbound is shared, and the panel writes to it
	// independently. An adapter that cannot report it must leave this empty
	// rather than guess — the callers treat "" as "cannot tell".
	UUID string
}

// Expectation is what the caller observed at an address before deciding to
// change it, carried into the mutation so the adapter can re-check it as late as
// possible.
//
// THIS IS A NARROWING, NOT A GUARANTEE, and the distinction is load-bearing.
// The processor decides what to do from a ListUsers snapshot, and the 3x-ui
// panel writes to the same inbound independently — so between the observation
// and the mutation the panel can create, replace or remove an account. A
// preflight alone therefore cannot deliver the protection the collision guard
// advertises: it can only be right about a past moment.
//
// xray-core's handler service offers no compare-and-swap, so an adapter cannot
// close this window either; the honest contract is that it re-reads immediately
// before mutating and refuses on a mismatch, which shrinks the race to the
// width of one gRPC call. Closing it properly needs serialisation shared with
// the panel — recorded in the PRD as an open item, because it is a deployment
// decision rather than an agent one.
type Expectation struct {
	// UUID is the identity the caller expects to find. "" means it did not know
	// one and the adapter must not use identity to refuse.
	UUID string
	// Absent says the caller expects NO account at this address — the state that
	// makes an install safe under the shared inbound.
	Absent bool
}

// Adapter is the runner's Xray boundary. GRPC is the production implementation;
// the interface keeps state/command tests independent of the upstream service.
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
	// EnsureUser installs or updates one account, and `expect` says what the
	// caller believed was at that address when it decided to. See Expectation.
	EnsureUser(ctx context.Context, user protocol.DesiredUser, expect Expectation) error
	// RemoveUser uninstalls one account by email. Removing an account that is
	// not there must succeed: every caller is a reconcile that may run twice.
	// `expect` carries the same identity check as EnsureUser.
	RemoveUser(ctx context.Context, email string, expect Expectation) error
	// ReadAbsoluteCounters reads every account's cumulative traffic WITHOUT
	// resetting it. Reset-on-read is what makes two readers steal from each
	// other, and 3x-ui is the other reader.
	ReadAbsoluteCounters(ctx context.Context) ([]protocol.AbsoluteCounter, error)
}
