// Package store is the agent's durable local state: the users it should be
// serving, the metering batches it has not yet had acknowledged, and the
// commands it has already executed.
//
// It is a port of apps/node-agent/src/store.ts. Two properties are worth stating
// up front because everything else follows from them:
//
//   - The database BELONGS TO ONE NODE IDENTITY. It holds another node's desired
//     users, command history and unsettled usage batches, so adopting a foreign
//     one would replay that node's work under this node's credentials.
//   - Metering must never silently under-count. Xray's counters can reset
//     underneath us (3x-ui does it periodically), and a reset that is treated as
//     "no traffic" is invisible: the numbers stay plausible and the money is gone.
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/decimal"
	"github.com/Achordchan/ChordV/apps/agent/internal/durable"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	_ "modernc.org/sqlite"
)

// ForeignStateError reports a database that belongs to another node. Only an
// explicit operator reset may move it aside.
type ForeignStateError struct{ Recorded, Current string }

func (e *ForeignStateError) Error() string {
	return fmt.Sprintf(
		"本地状态库属于节点 %s，与当前身份 %s 不一致：请先归档或迁移本机运行状态"+
			"（停止服务后以 CHORDV_AGENT_RESET_IDENTITY=1 启动一次，旧状态库会被改名保留），再重新接入",
		e.Recorded, e.Current)
}

// Options configure one open store.
type Options struct {
	BootID                  string
	NodeID                  string
	DefaultOfflineAllowance *big.Int
	// ReadOnly opens an EXISTING database without writing to it — no directory
	// creation, no pragma/schema/boot writes. Used by --health, which may run as
	// root: any file this process created there (db, -wal, -shm) would be owned
	// by root and break the unprivileged service's next start.
	ReadOnly bool
}

// Store is not safe for concurrent use by design: the connection pool is capped
// at one so writes serialize exactly as they did under better-sqlite3, and the
// runner funnels every mutation through a single goroutine anyway.
type Store struct {
	db      *sql.DB
	options Options
}

// SampleResult is one metering tick: the batch to upload (nil when nothing
// changed) and the users whose quota ran out during it.
type SampleResult struct {
	Batch         *protocol.UsageBatch
	DisableEmails []string
}

// fileURI turns a filesystem path into a SQLite `file:` URI with the given
// query.
//
// A path is NOT a DSN. modernc.org/sqlite splits the DSN at `?` and reads what
// follows as parameters, so a database under a directory named `agent?x` does
// not merely fail — sql.Open silently creates a file called `agent` and the
// agent's whole state (users, unsettled metering batches, identity binding)
// lives somewhere nobody will look. `#` truncates at the fragment and `%` is
// read as an escape, both with the same shape of outcome. AGENT_DATABASE_PATH is
// operator-configurable, so this is reachable by configuration alone.
//
// url.URL.String escapes all three, so the driver opens exactly the file whose
// ownership and sidecars were checked.
func fileURI(path, query string) string {
	return (&url.URL{Scheme: "file", Path: path, RawQuery: query}).String()
}

// isoMillis matches JavaScript's Date#toISOString exactly — three fractional
// digits and a literal Z. The control plane validates @IsDateString and the two
// agents must produce byte-identical timestamps for the same instant.
func isoMillis(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000Z")
}

// Open prepares the store, applying the identity binding and boot bookkeeping.
func Open(path string, options Options) (*Store, error) {
	// Resolve BEFORE anything looks at the path. A relative path has no valid
	// `file:` URI: url.URL renders `data/node-agent.db` as `file://data/…`,
	// where SQLite reads `data` as an AUTHORITY rather than a directory and
	// refuses to open. Resolving here also guarantees that the ownership check,
	// the sidecar check and the URI all name one file.
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if options.ReadOnly {
		return openReadOnly(path, options)
	}
	if err := durable.EnsureDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", fileURI(path, ""))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, options: options}
	// Anything that REJECTS the database must not leave its connection open: the
	// caller may go on to archive the files and reopen a replacement at the same
	// path, and a live connection would keep checkpointing into the new
	// database's sidecar paths.
	if err := store.prepare(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) prepare() error {
	for _, pragma := range []string{
		// WAL for concurrent readers; FULL because this database is the only
		// record of usage that has not been paid for yet — a lost transaction is
		// lost money, and the write rate is a handful per five seconds.
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = FULL",
		"PRAGMA foreign_keys = ON",
	} {
		if _, err := s.db.Exec(pragma); err != nil {
			return fmt.Errorf("%s 失败: %w", pragma, err)
		}
	}
	if err := s.migrate(); err != nil {
		return err
	}
	if err := s.assertOwnIdentity(); err != nil {
		return err
	}
	if err := s.backfillSnapshotRevision(); err != nil {
		return err
	}
	if err := s.backfillProvisioned(); err != nil {
		return err
	}
	return s.initializeBoot()
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS meta_v2 (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS desired_users_v2 (
			binding_id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			uuid TEXT NOT NULL,
			flow TEXT NOT NULL,
			enabled INTEGER NOT NULL,
			revision TEXT NOT NULL,
			quota_remaining TEXT NOT NULL,
			offline_allowance TEXT NOT NULL,
			offline_used TEXT NOT NULL DEFAULT '0',
			generation TEXT NOT NULL DEFAULT '0',
			counter_initialized INTEGER NOT NULL DEFAULT 0,
			uplink TEXT NOT NULL DEFAULT '0',
			downlink TEXT NOT NULL DEFAULT '0',
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS usage_batches_v2 (
			boot_id TEXT NOT NULL,
			sequence TEXT NOT NULL,
			sampled_at TEXT NOT NULL,
			payload TEXT NOT NULL,
			PRIMARY KEY (boot_id, sequence)
		);
		CREATE TABLE IF NOT EXISTS binding_tombstones_v2 (
			binding_id TEXT PRIMARY KEY,
			revision TEXT NOT NULL,
			recorded_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS pending_removals_v2 (
			email TEXT PRIMARY KEY,
			recorded_at TEXT NOT NULL
		);
		-- Accounts THIS agent installed. Deliberately separate from
		-- desired_users_v2: under B1 a stored desired-user record does NOT prove
		-- ChordV provisioned the account. See ProvisionedAccounts.
		CREATE TABLE IF NOT EXISTS provisioned_accounts_v2 (
			email TEXT PRIMARY KEY,
			binding_id TEXT NOT NULL,
			recorded_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS commands_v2 (
			command_id TEXT PRIMARY KEY,
			command_type TEXT NOT NULL,
			target_revision TEXT NOT NULL,
			payload TEXT NOT NULL,
			result TEXT,
			completed_at TEXT
		);
	`)
	return err
}

// assertOwnIdentity closes every variant of "new identity, old state": an
// interrupted reset, an installer that replaced an env-only identity, a restored
// backup, a hand-copied data directory.
func (s *Store) assertOwnIdentity() error {
	recorded, err := s.meta("node_id")
	if err != nil {
		return err
	}
	if recorded != "" && recorded != s.options.NodeID {
		return &ForeignStateError{Recorded: recorded, Current: s.options.NodeID}
	}
	if recorded == "" {
		// Databases created before this check simply adopt their current identity.
		return s.setMeta("node_id", s.options.NodeID)
	}
	return nil
}

// backfillSnapshotRevision gives an OLDER database a safe snapshot watermark.
//
// A database written before the watermark existed has none, and reading it as 0
// would let a delayed per-binding command from long ago pass the staleness gate
// and recreate a binding that a full snapshot has since removed. config_revision
// is at least as high as any snapshot that database ever applied, so adopting it
// errs toward REFUSING work: a wrongly-skipped install is repaired by the next
// reconcile, whereas a resurrected revoked account is not.
//
// A brand-new database has config_revision "0" and is untouched by this.
func (s *Store) backfillSnapshotRevision() error {
	existing, err := s.meta("snapshot_revision")
	if err != nil || existing != "" {
		return err
	}
	applied, err := s.ConfigRevision()
	if err != nil {
		return err
	}
	// A fresh database must PERSIST the zero, not just read as zero. Returning
	// early here would leave the key absent, so the next open — after individual
	// commands have moved config_revision but before any snapshot has arrived —
	// would mistake this database for an old one and backfill the watermark from
	// that per-command progress. A failed install at revision 5 followed by a
	// success at 6 and a restart would then have its retry skipped and cached as
	// completed: exactly the confusion the watermark exists to prevent.
	return s.setMeta("snapshot_revision", applied)
}

// backfillProvisioned hands an OLDER database the provisioning evidence it never
// recorded, without inventing any.
//
// A database written before provisioned_accounts_v2 existed has an empty table
// even for accounts the agent really did install. Ownership would then start
// from nothing: the first snapshot that omits a revoked binding classifies its
// live account as a stranger and — with unknown-user removal off — leaves it
// serving, while snapshot replacement deletes the only record of it. Nothing
// afterwards can revoke it.
//
// The one mode where the desired set IS the provisioning record is
// direct_primary: getConfig filters that snapshot to source === "direct", so
// every row in it is ChordV's. In any other mode the rows include the PANEL's
// bindings, and claiming them is the exact accident provisioned_accounts_v2
// exists to prevent — so nothing is claimed there.
//
// The current mode is not proof that the agent never provisioned anything: a
// node that ran in direct_primary and has since been moved to shadow_direct or
// rollback_pending really does own accounts. So the desired set is only ONE of
// two sources, and the other is the command history — which is never pruned:
//
//   - a completed ENSURE_USER installed the account it names;
//   - a completed RECONCILE_USERS whose payload carried controlMode
//     direct_primary installed every user in it.
//
// Both are records of what this agent DID, so neither can claim a panel account.
// They can name accounts since removed, which costs one no-op RemoveUser — the
// same trade RecordProvisioned already makes.
//
// When the picture is still ambiguous — desired rows exist, the mode is not
// direct_primary, and the history yielded nothing — the migration is NOT marked
// done. Leaving it open lets a later promotion complete it rather than freezing
// a node into permanent unownership.
func (s *Store) backfillProvisioned() error {
	done, err := s.meta("provisioned_backfilled")
	if err != nil || done != "" {
		return err
	}
	mode, err := s.ControlMode()
	if err != nil {
		return err
	}
	recovered, err := s.provisionedFromHistory()
	if err != nil {
		return err
	}
	if mode == protocol.ModeDirectPrimary {
		result, err := s.db.Exec(`
			INSERT INTO provisioned_accounts_v2(email, binding_id, recorded_at)
			SELECT email, binding_id, ? FROM desired_users_v2
			WHERE email NOT LIKE ? || '%'
			ON CONFLICT(email) DO NOTHING`, isoMillis(time.Now()), reassignPlaceholder)
		if err != nil {
			return err
		}
		adopted, err := result.RowsAffected()
		if err != nil {
			return err
		}
		recovered += int(adopted)
		return s.setMeta("provisioned_backfilled", "1")
	}
	var rows int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM desired_users_v2`).Scan(&rows); err != nil {
		return err
	}
	if rows == 0 || recovered > 0 {
		return s.setMeta("provisioned_backfilled", "1")
	}
	// Deliberately left unfinished: see above.
	return nil
}

// provisionedFromHistory REPLAYS the command log in order and adopts what this
// agent still owns at the end of it, reporting how many claims it added.
//
// Adopting every historical install would be wrong, and dangerously so: an old
// install proves HISTORICAL ownership, not current. If ChordV removed an account
// and a panel administrator later reused that email, unconditional adoption
// hands the panel's live account to ChordV — and the next direct reconcile
// deletes it, RemoveUnknownUsers notwithstanding. Exactly the accident the whole
// provisioning table exists to prevent, reintroduced through the migration.
//
// So releases count as much as claims, and ownership is tracked PER BINDING:
//
//   - ENSURE_USER claims the email for its binding, releasing whatever address
//     that binding held before (which is what a rename is);
//   - REMOVE_USER releases the binding's claim outright;
//   - DISABLE_USER releases nothing — the record survives and a later enable
//     puts the same account back, which is the live rule too;
//   - a direct_primary RECONCILE_USERS is a full statement: it claims every
//     binding it names and releases every binding it does not.
//
// Ordered by TARGET REVISION, not by completion.
//
// "completed" does not mean "changed something": a command the staleness guards
// skipped reports completed too, because from the control plane's side it is
// settled. Replaying in completion order therefore lets a delayed install at
// revision 5, which arrived after the removal at 6 and did nothing, re-claim the
// address it never reinstalled — and if the panel has since reused it, the next
// direct reconcile deletes the panel's account.
//
// Revision order is the order the live guards enforce, so replaying in it gives
// the same outcome those guards produced: the stale install sorts BEFORE the
// removal that superseded it, and the removal wins. Completion time and row
// order only break ties within one revision.
func (s *Store) provisionedFromHistory() (int, error) {
	rows, err := s.db.Query(`
		SELECT command_type, target_revision, payload FROM commands_v2
		WHERE completed_at IS NOT NULL AND result LIKE '%"status":"completed"%'
		  AND command_type IN ('ENSURE_USER', 'ENABLE_USER', 'REMOVE_USER', 'RECONCILE_USERS')
		ORDER BY completed_at ASC, rowid ASC`)
	if err != nil {
		return 0, err
	}
	type event struct {
		kind     string
		revision string
		raw      string
	}
	var history []event
	for rows.Next() {
		var entry event
		if err := rows.Scan(&entry.kind, &entry.revision, &entry.raw); err != nil {
			rows.Close()
			return 0, err
		}
		history = append(history, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	// A stable sort keeps the completion/row order the query established as the
	// tiebreaker within a revision.
	var sortErr error
	sort.SliceStable(history, func(i, j int) bool {
		order, err := decimal.Cmp(history[i].revision, history[j].revision)
		if err != nil && sortErr == nil {
			sortErr = err
		}
		return order < 0
	})
	if sortErr != nil {
		return 0, sortErr
	}
	owned := map[string]string{} // bindingId -> the email it currently holds
	for _, entry := range history {
		kind, raw := entry.kind, entry.raw
		// The column holds the whole marshalled Command, not just its payload.
		var stored protocol.Command
		if err := json.Unmarshal([]byte(raw), &stored); err != nil {
			continue // an unreadable payload is not evidence, but is not fatal either
		}
		payload := stored.Payload
		switch protocol.CommandType(kind) {
		// ENABLE_USER runs through the very same install/rename path as
		// ENSURE_USER (see the processor's apply switch), so it claims and
		// releases identically. Leaving it out made an ensure-then-enable rename
		// recover the OLD address: the revoked new one would be left serving,
		// and a panel account that reused the old one could be deleted.
		case protocol.CommandEnsureUser, protocol.CommandEnableUser:
			id, _ := payload["bindingId"].(string)
			if email := payloadEmail(payload); id != "" && email != "" {
				owned[id] = email
			}
		case protocol.CommandRemoveUser:
			if id, _ := payload["bindingId"].(string); id != "" {
				delete(owned, id)
				continue
			}
			// Addressed by email only: release whichever binding holds it.
			if email := payloadEmail(payload); email != "" {
				for id, held := range owned {
					if held == email {
						delete(owned, id)
					}
				}
			}
		case protocol.CommandReconcileUsers:
			if value, _ := payload["controlMode"].(string); protocol.ControlMode(value) != protocol.ModeDirectPrimary {
				continue
			}
			items, present := payload["users"].([]any)
			if !present {
				// No user set at all: a mode-only instruction, which says
				// nothing about who owns what.
				continue
			}
			next := map[string]string{}
			for _, item := range items {
				user, _ := item.(map[string]any)
				id, _ := user["bindingId"].(string)
				if email := payloadEmail(user); id != "" && email != "" {
					next[id] = email
				}
			}
			owned = next
		}
	}
	added := 0
	for id, email := range owned {
		result, err := s.db.Exec(`
			INSERT INTO provisioned_accounts_v2(email, binding_id, recorded_at) VALUES(?, ?, ?)
			ON CONFLICT(email) DO NOTHING`, email, id, isoMillis(time.Now()))
		if err != nil {
			return 0, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		added += int(affected)
	}
	return added, nil
}

func payloadEmail(payload map[string]any) string {
	if email, _ := payload["email"].(string); email != "" {
		return email
	}
	email, _ := payload["userKey"].(string)
	return email
}

// RecordBindingTombstone remembers the revision at which a binding was DELETED.
//
// Deleting the desired-user row also deletes the revision that staleForEnable
// compares against. Without a tombstone, an install that failed at revision 5,
// followed by a REMOVE_USER at 6, lets the retry of that install pass every
// guard and reinstall an account the control plane has revoked.
func (s *Store) RecordBindingTombstone(bindingID, revision string) error {
	normalized, err := decimal.Normalize(revision)
	if err != nil {
		return err
	}
	// Compared in Go, not in SQL. SQLite's CAST … AS INTEGER saturates at the
	// signed 64-bit maximum, so two protocol-valid revisions above it compare
	// EQUAL and a later deletion could not raise the floor — leaving an enable
	// between the two deletion revisions free to pass the staleness guard.
	// Everything else in this agent already compares revisions with big.Int;
	// reaching for a SQL cast here was the inconsistency.
	return s.transact(func(tx *sql.Tx) error {
		return recordTombstoneTx(tx, bindingID, normalized)
	})
}

func recordTombstoneTx(tx *sql.Tx, bindingID, normalized string) error {
	var current string
	switch err := tx.QueryRow(
		`SELECT revision FROM binding_tombstones_v2 WHERE binding_id = ?`, bindingID).Scan(&current); {
	case errors.Is(err, sql.ErrNoRows):
		current = ""
	case err != nil:
		return err
	}
	if current != "" {
		order, err := decimal.Cmp(normalized, current)
		if err != nil {
			return err
		}
		if order <= 0 {
			return nil
		}
	}
	_, err := tx.Exec(`
		INSERT INTO binding_tombstones_v2(binding_id, revision, recorded_at) VALUES(?, ?, ?)
		ON CONFLICT(binding_id) DO UPDATE SET revision = excluded.revision, recorded_at = excluded.recorded_at`,
		bindingID, normalized, isoMillis(time.Now()))
	return err
}

// ApplyTerminal records a binding's tombstone AND retires its local row in one
// transaction.
//
// The two must not be separable. The tombstone is what makes a re-delivered
// terminal command idempotent: once it is at the command's revision, the guard
// treats the command as already applied. So a crash — or any failed write —
// between a standalone tombstone and the row change leaves the tombstone saying
// "done" while the row is still enabled at an older revision. The redelivery
// then returns early and reports completed, and the next reconcile happily
// reinstalls the enabled row: the account comes back with nothing left that
// disagrees.
//
// Committing them together means a retry either finds the whole transition or
// none of it, and in the "none" case does the work again.
func (s *Store) ApplyTerminal(bindingID, revision string, remove bool) error {
	normalized, err := decimal.Normalize(revision)
	if err != nil {
		return err
	}
	return s.transact(func(tx *sql.Tx) error {
		if bindingID == "" {
			return errors.New("终态命令缺少 bindingId")
		}
		if err := recordTombstoneTx(tx, bindingID, normalized); err != nil {
			return err
		}
		if remove {
			_, err := tx.Exec(`DELETE FROM desired_users_v2 WHERE binding_id = ?`, bindingID)
			return err
		}
		// Same revision guard SetUserEnabled applies, kept inside the
		// transaction so it sees the row the tombstone is being written against.
		var current string
		switch err := tx.QueryRow(
			`SELECT revision FROM desired_users_v2 WHERE binding_id = ?`, bindingID).Scan(&current); {
		case errors.Is(err, sql.ErrNoRows):
			return nil
		case err != nil:
			return err
		}
		stale, err := decimal.Less(normalized, current)
		if err != nil || stale {
			return err
		}
		_, err = tx.Exec(
			`UPDATE desired_users_v2 SET enabled = 0, revision = ?, updated_at = ? WHERE binding_id = ?`,
			normalized, isoMillis(time.Now()), bindingID)
		return err
	})
}

// BindingTombstone reports the revision at which a binding was deleted, or "0".
func (s *Store) BindingTombstone(bindingID string) (string, error) {
	var revision string
	switch err := s.db.QueryRow(
		`SELECT revision FROM binding_tombstones_v2 WHERE binding_id = ?`, bindingID).Scan(&revision); {
	case err == nil:
		return revision, nil
	case errors.Is(err, sql.ErrNoRows):
		return "0", nil
	default:
		return "0", err
	}
}

// ClearBindingTombstone forgets a binding that has legitimately come back.
func (s *Store) ClearBindingTombstone(bindingID string) error {
	_, err := s.db.Exec(`DELETE FROM binding_tombstones_v2 WHERE binding_id = ?`, bindingID)
	return err
}

func (s *Store) initializeBoot() error {
	return s.transact(func(tx *sql.Tx) error {
		if err := setMetaTx(tx, "boot_id", s.options.BootID); err != nil {
			return err
		}
		key := sequenceKey(s.options.BootID)
		current, err := metaTx(tx, key)
		if err != nil {
			return err
		}
		if current == "" {
			// Sequences are per boot and start at 1: the control plane's
			// contiguity check is (bootId, sequence), and a boot that started at
			// 0 or skipped would stall accounting for that boot forever.
			return setMetaTx(tx, key, "1")
		}
		return nil
	})
}

func sequenceKey(bootID string) string { return "next_sequence:" + bootID }
func baselineKey(bootID string) string { return "baseline_emitted:" + bootID }

// Close releases the connection.
func (s *Store) Close() error { return s.db.Close() }

// --- meta -------------------------------------------------------------------

type querier interface {
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
}

func metaFrom(q querier, key string) (string, error) {
	var value string
	switch err := q.QueryRow(`SELECT value FROM meta_v2 WHERE key = ?`, key).Scan(&value); {
	case err == nil:
		return value, nil
	case errors.Is(err, sql.ErrNoRows):
		return "", nil
	default:
		return "", err
	}
}

func setMetaFrom(q querier, key, value string) error {
	_, err := q.Exec(
		`INSERT INTO meta_v2(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value)
	return err
}

func (s *Store) meta(key string) (string, error)    { return metaFrom(s.db, key) }
func (s *Store) setMeta(key, value string) error    { return setMetaFrom(s.db, key, value) }
func metaTx(tx *sql.Tx, key string) (string, error) { return metaFrom(tx, key) }
func setMetaTx(tx *sql.Tx, key, value string) error { return setMetaFrom(tx, key, value) }

func (s *Store) transact(body func(*sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := body(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// --- configuration ----------------------------------------------------------

// ConfigRevision is the highest revision this agent has applied.
func (s *Store) ConfigRevision() (string, error) {
	value, err := s.meta("config_revision")
	if err != nil || value == "" {
		return "0", err
	}
	return value, nil
}

// SnapshotRevision is the revision of the last FULL desired-state snapshot this
// node applied.
//
// It is deliberately separate from ConfigRevision, which advances on every
// completed command. Only a snapshot supersedes a per-binding instruction: if
// binding A's install fails at revision 5 and binding B's succeeds at 6, A's
// retry is still live work — the control plane never said anything new about A.
// Comparing it against the global applied-revision watermark would skip it as
// "already superseded" and cache that as a success, leaving A uninstalled for
// good.
func (s *Store) SnapshotRevision() (string, error) {
	value, err := s.meta("snapshot_revision")
	if err != nil || value == "" {
		return "0", err
	}
	return value, nil
}

// AdvanceConfigRevision moves the watermark forward only.
func (s *Store) AdvanceConfigRevision(revision string) error {
	next, err := decimal.Normalize(revision)
	if err != nil {
		return err
	}
	current, err := s.ConfigRevision()
	if err != nil {
		return err
	}
	greater, err := decimal.Less(current, next)
	if err != nil || !greater {
		return err
	}
	return s.setMeta("config_revision", next)
}

// ControlMode decides whether this agent may write to Xray at all. An
// unrecognised or absent value falls back to shadow_direct — the mode that may
// NOT write — so a corrupt row can never grant write access by accident.
func (s *Store) ControlMode() (protocol.ControlMode, error) {
	value, err := s.meta("control_mode")
	if err != nil {
		return protocol.ModeShadowDirect, err
	}
	if !protocol.IsControlMode(value) {
		return protocol.ModeShadowDirect, nil
	}
	return protocol.ControlMode(value), nil
}

// ConfigSnapshot reassembles what this agent believes it should be serving.
func (s *Store) ConfigSnapshot() (protocol.ConfigSnapshot, error) {
	revision, err := s.ConfigRevision()
	if err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	mode, err := s.ControlMode()
	if err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	users, err := s.ListDesiredUsers()
	if err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	return protocol.ConfigSnapshot{
		NodeID: s.options.NodeID, Revision: revision, ControlMode: mode, Users: users,
	}, nil
}

// ApplyConfigSnapshot adopts a snapshot from the control plane, reporting false
// when it is older than what is already applied.
func (s *Store) ApplyConfigSnapshot(snapshot protocol.ConfigSnapshot) (bool, error) {
	if snapshot.NodeID != s.options.NodeID {
		return false, errors.New("Agent 配置 nodeId 与本机凭据不一致")
	}
	revision, err := decimal.Normalize(snapshot.Revision)
	if err != nil {
		return false, err
	}
	current, err := s.ConfigRevision()
	if err != nil {
		return false, err
	}
	older, err := decimal.Less(revision, current)
	if err != nil {
		return false, err
	}
	if older {
		return false, nil
	}
	err = s.transact(func(tx *sql.Tx) error {
		if err := replaceDesiredUsersTx(tx, snapshot.Users, revision, s.options.DefaultOfflineAllowance); err != nil {
			return err
		}
		if err := setMetaTx(tx, "control_mode", string(snapshot.ControlMode)); err != nil {
			return err
		}
		// The snapshot watermark moves ONLY here. See SnapshotRevision.
		if err := setMetaTx(tx, "snapshot_revision", revision); err != nil {
			return err
		}
		return setMetaTx(tx, "config_revision", revision)
	})
	return err == nil, err
}

// ReplaceDesiredUsers makes the stored set exactly the given one.
func (s *Store) ReplaceDesiredUsers(users []protocol.DesiredUser, revision string) error {
	normalized, err := decimal.Normalize(revision)
	if err != nil {
		return err
	}
	return s.transact(func(tx *sql.Tx) error {
		return replaceDesiredUsersTx(tx, users, normalized, s.options.DefaultOfflineAllowance)
	})
}

func replaceDesiredUsersTx(tx *sql.Tx, users []protocol.DesiredUser, revision string, fallback *big.Int) error {
	keep := make(map[string]bool, len(users))
	for _, user := range users {
		keep[user.BindingID] = true
		if err := upsertDesiredUserTx(tx, user, fallback); err != nil {
			return err
		}
	}
	rows, err := tx.Query(`SELECT binding_id FROM desired_users_v2`)
	if err != nil {
		return err
	}
	var existing []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		existing = append(existing, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, id := range existing {
		if keep[id] {
			continue
		}
		// A snapshot that stops naming a binding is revoking it, and the row
		// about to be deleted is the binding's whole local history. Without a
		// floor, an enable arriving at this snapshot's own revision finds
		// neither a row nor a tombstone and reinstalls what the snapshot just
		// revoked.
		//
		// Written HERE, in the same transaction and from the same list, rather
		// than by the caller beforehand. A floor that lands while the deletion
		// does not is worse than no floor: the enabled row survives next to a
		// tombstone that now makes every later instruction about the binding
		// look superseded, so the stale enabled row is what a merge preserves —
		// and the revoked account goes back in.
		if err := recordTombstoneTx(tx, id, revision); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM desired_users_v2 WHERE binding_id = ?`, id); err != nil {
			return err
		}
	}
	return setMetaTx(tx, "config_revision", revision)
}

// UpsertDesiredUser writes a user, ignoring anything not newer than what is
// stored: commands and snapshots race, and an older revision must never undo a
// newer one.
func (s *Store) UpsertDesiredUser(user protocol.DesiredUser) error {
	return s.transact(func(tx *sql.Tx) error {
		return upsertDesiredUserTx(tx, user, s.options.DefaultOfflineAllowance)
	})
}

func upsertDesiredUserTx(tx *sql.Tx, user protocol.DesiredUser, fallback *big.Int) error {
	revision, err := decimal.Normalize(user.Revision)
	if err != nil {
		return err
	}
	current, err := userByBindingID(tx, user.BindingID)
	if err != nil {
		return err
	}
	if current != nil {
		newer, err := decimal.Less(current.Revision, revision)
		if err != nil {
			return err
		}
		if !newer {
			return nil
		}
	}
	quota, err := decimal.Normalize(user.QuotaRemainingBytes)
	if err != nil {
		return err
	}
	allowanceRaw := user.OfflineAllowanceBytes
	if allowanceRaw == "" {
		allowanceRaw = fallback.String()
	}
	allowance, err := decimal.Normalize(allowanceRaw)
	if err != nil {
		return err
	}
	enabled := 0
	if user.Enabled {
		enabled = 1
	}
	// The INSERT resets the counter columns; the UPDATE branch deliberately does
	// NOT touch them. A user re-sent by the control plane keeps its metering
	// baseline, or every config refresh would re-emit the whole counter as fresh
	// traffic.
	_, err = tx.Exec(`
		INSERT INTO desired_users_v2(
			binding_id, email, uuid, flow, enabled, revision, quota_remaining,
			offline_allowance, offline_used, generation, counter_initialized, uplink, downlink, updated_at
		) VALUES(?, ?, ?, ?, ?, ?, ?, ?, '0', '0', 0, '0', '0', ?)
		ON CONFLICT(binding_id) DO UPDATE SET
			email = excluded.email, uuid = excluded.uuid, flow = excluded.flow,
			enabled = excluded.enabled, revision = excluded.revision,
			quota_remaining = excluded.quota_remaining,
			offline_allowance = excluded.offline_allowance, updated_at = excluded.updated_at
	`, user.BindingID, user.Email, user.UUID, user.Flow, enabled, revision, quota, allowance, isoMillis(time.Now()))
	if err != nil {
		return err
	}
	// A CHANGED EMAIL is the exception to that rule, and it must be handled here
	// rather than by the caller.
	//
	// Xray addresses accounts by email, so a rename is a different account with
	// its own counter starting at zero. Keeping the old baseline makes the next
	// sample compute current − old_baseline. The reset detector cannot save us:
	// it fires only when the reading goes DOWN, so if the new account has moved
	// more bytes than the old baseline before the first sample, nothing looks
	// wrong and the difference is all that gets billed.
	//
	// So the rename explicitly starts a new generation from a zero baseline —
	// exactly the state a detected reset produces, which makes the next sample
	// bill the new account's counter in full.
	//
	// In the same transaction as the row change on purpose: a rename that lands
	// without its baseline reset is the under-billing this is here to prevent.
	//
	// KNOWN LOSS, and it is not fixable from the store: whatever the OLD account
	// moved between the last sample and its uninstall is never observed by
	// anyone. It is bounded by one sampling interval and it under-counts, which
	// is the safe direction.
	if current == nil || current.Email == user.Email {
		return nil
	}
	generation, err := decimal.Parse(current.Generation)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`
		UPDATE desired_users_v2
		SET generation = ?, uplink = '0', downlink = '0', counter_initialized = 1
		WHERE binding_id = ?`,
		new(big.Int).Add(generation, big.NewInt(1)).String(), user.BindingID)
	return err
}

// UpdateQuota applies a REFRESH_QUOTA, clearing the offline debt the old quota
// accrued.
func (s *Store) UpdateQuota(bindingID, quotaRemaining, revision string) error {
	quota, err := decimal.Normalize(quotaRemaining)
	if err != nil {
		return err
	}
	next, err := decimal.Normalize(revision)
	if err != nil {
		return err
	}
	current, err := userByBindingID(s.db, bindingID)
	if err != nil || current == nil {
		return err
	}
	stale, err := decimal.Less(next, current.Revision)
	if err != nil || stale {
		return err
	}
	_, err = s.db.Exec(
		`UPDATE desired_users_v2 SET quota_remaining = ?, revision = ?, offline_used = '0', updated_at = ? WHERE binding_id = ?`,
		quota, next, isoMillis(time.Now()), bindingID)
	return err
}

// SetUserEnabled records an enable/disable that a command carried.
func (s *Store) SetUserEnabled(bindingID string, enabled bool, revision string) error {
	next, err := decimal.Normalize(revision)
	if err != nil {
		return err
	}
	current, err := userByBindingID(s.db, bindingID)
	if err != nil || current == nil {
		return err
	}
	stale, err := decimal.Less(next, current.Revision)
	if err != nil || stale {
		return err
	}
	flag := 0
	if enabled {
		flag = 1
	}
	_, err = s.db.Exec(
		`UPDATE desired_users_v2 SET enabled = ?, revision = ?, updated_at = ? WHERE binding_id = ?`,
		flag, next, isoMillis(time.Now()), bindingID)
	return err
}

// DeleteUser removes a user outright (REMOVE_USER).
func (s *Store) DeleteUser(bindingID string) error {
	_, err := s.db.Exec(`DELETE FROM desired_users_v2 WHERE binding_id = ?`, bindingID)
	return err
}

// userRow is the full stored shape, including the metering columns that never
// travel in the protocol.
type userRow struct {
	protocol.DesiredUser
	OfflineUsed        string
	Generation         string
	CounterInitialized bool
	Uplink             string
	Downlink           string
}

const userColumns = `binding_id, email, uuid, flow, enabled, revision, quota_remaining,
	offline_allowance, offline_used, generation, counter_initialized, uplink, downlink`

func scanUser(scan func(...any) error) (*userRow, error) {
	var row userRow
	var enabled, initialized int
	err := scan(&row.BindingID, &row.Email, &row.UUID, &row.Flow, &enabled, &row.Revision,
		&row.QuotaRemainingBytes, &row.OfflineAllowanceBytes, &row.OfflineUsed,
		&row.Generation, &initialized, &row.Uplink, &row.Downlink)
	if err != nil {
		return nil, err
	}
	row.Enabled = enabled == 1
	row.CounterInitialized = initialized == 1
	return &row, nil
}

func userByBindingID(q querier, bindingID string) (*userRow, error) {
	row, err := scanUser(q.QueryRow(`SELECT `+userColumns+` FROM desired_users_v2 WHERE binding_id = ?`, bindingID).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

func userByEmail(q querier, email string) (*userRow, error) {
	row, err := scanUser(q.QueryRow(`SELECT `+userColumns+` FROM desired_users_v2 WHERE email = ?`, email).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// UserByBindingID exposes the stored user, or nil.
func (s *Store) UserByBindingID(bindingID string) (*protocol.DesiredUser, error) {
	row, err := userByBindingID(s.db, bindingID)
	if err != nil || row == nil {
		return nil, err
	}
	user := row.DesiredUser
	return &user, nil
}

// ListDesiredUsers returns every stored user, ordered by email for stable output.
func (s *Store) ListDesiredUsers() ([]protocol.DesiredUser, error) {
	rows, err := s.db.Query(`SELECT ` + userColumns + ` FROM desired_users_v2 ORDER BY email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []protocol.DesiredUser{}
	for rows.Next() {
		row, err := scanUser(rows.Scan)
		if err != nil {
			return nil, err
		}
		users = append(users, row.DesiredUser)
	}
	return users, rows.Err()
}

// HasUsageDisabledUsers reports users this AGENT disabled for running out of
// quota or offline allowance — as opposed to ones the control plane disabled.
// The distinction decides whether a backend snapshot may re-enable them.
func (s *Store) HasUsageDisabledUsers() (bool, error) {
	rows, err := s.db.Query(
		`SELECT quota_remaining, offline_used, offline_allowance FROM desired_users_v2 WHERE enabled = 0`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var quota, used, allowance string
		if err := rows.Scan(&quota, &used, &allowance); err != nil {
			return false, err
		}
		quotaValue, err := decimal.Parse(quota)
		if err != nil {
			return false, err
		}
		usedValue, err := decimal.Parse(used)
		if err != nil {
			return false, err
		}
		allowanceValue, err := decimal.Parse(allowance)
		if err != nil {
			return false, err
		}
		if quotaValue.Sign() == 0 || (usedValue.Sign() > 0 && usedValue.Cmp(allowanceValue) >= 0) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// RestoreBackendConfirmedUsers re-enables users once the backend has confirmed
// their quota, taking the LOWER of the two figures.
//
// The agent's own count is authoritative for traffic it metered while offline
// and the backend has not seen yet; the backend's is authoritative for purchases
// and for traffic metered on other nodes. Taking the minimum can only
// under-serve, never over-serve — the safe direction when the two disagree.
func (s *Store) RestoreBackendConfirmedUsers(users []protocol.DesiredUser) error {
	return s.transact(func(tx *sql.Tx) error {
		for _, user := range users {
			row, err := userByBindingID(tx, user.BindingID)
			if err != nil {
				return err
			}
			if row == nil {
				continue
			}
			local, err := decimal.Parse(row.QuotaRemainingBytes)
			if err != nil {
				return err
			}
			backend, err := decimal.Parse(user.QuotaRemainingBytes)
			if err != nil {
				return err
			}
			confirmed := local
			if backend.Cmp(local) < 0 {
				confirmed = backend
			}
			enabled := 0
			if user.Enabled && confirmed.Sign() > 0 {
				enabled = 1
			}
			if _, err := tx.Exec(
				`UPDATE desired_users_v2 SET enabled = ?, quota_remaining = ?, offline_used = '0', updated_at = ? WHERE binding_id = ?`,
				enabled, confirmed.String(), isoMillis(time.Now()), user.BindingID); err != nil {
				return err
			}
		}
		return nil
	})
}

// --- metering ---------------------------------------------------------------

// RecordSample folds one reading of Xray's absolute counters into local state
// and, when anything moved, produces the batch to upload.
//
// A user whose counters did not move contributes nothing to the batch. The Node
// agent emitted them anyway, which at a five-second interval is 17,280 batches a
// day per node — every one of them an fsync, because this database runs
// synchronous=FULL — carrying deltas of zero. Suppressing them changes no
// accounting: deltas are additive, sequence numbers are still contiguous
// (a batch is skipped, never a number), and the three things the control plane
// actually needs — a user's first reading, traffic, and a counter reset — are
// all still emitted. See folded.emit.
func (s *Store) RecordSample(counters []protocol.AbsoluteCounter, sampledAt time.Time, backendOnline bool) (SampleResult, error) {
	var result SampleResult
	err := s.transact(func(tx *sql.Tx) error {
		samples := []protocol.UsageSample{}
		var disable []string
		for _, counter := range counters {
			row, err := userByEmail(tx, counter.Email)
			if err != nil {
				return err
			}
			// A counter for a user we do not own, or one already disabled, is not
			// ours to bill.
			if row == nil || !row.Enabled {
				continue
			}
			sample, shouldDisable, err := foldCounter(row, counter, backendOnline)
			if err != nil {
				return err
			}
			enabled := 1
			if shouldDisable {
				enabled = 0
				disable = append(disable, row.Email)
			}
			if _, err := tx.Exec(`
				UPDATE desired_users_v2 SET generation = ?, counter_initialized = 1,
					uplink = ?, downlink = ?, quota_remaining = ?, offline_used = ?, enabled = ?, updated_at = ?
				WHERE binding_id = ?`,
				sample.generation, sample.uplink, sample.downlink, sample.quota, sample.offline,
				enabled, isoMillis(sampledAt), row.BindingID); err != nil {
				return err
			}
			// The row update above runs unconditionally — it is what settles the
			// offline debt when the backend comes back, and what disables an
			// exhausted user — but an idle user's sample carries nothing new.
			if sample.emit {
				samples = append(samples, sample.UsageSample)
			}
		}
		// Written but never read, here and in the Node agent. It is kept so the
		// two implementations leave an identical meta table: during the canary a
		// node may be rolled back from this agent to the Node one on the SAME
		// data directory, and an unfamiliar store is not what anyone wants to
		// meet while rolling back.
		if len(counters) > 0 {
			if err := setMetaTx(tx, baselineKey(s.options.BootID), "1"); err != nil {
				return err
			}
		}
		result.DisableEmails = disable
		if len(samples) == 0 {
			return nil
		}
		key := sequenceKey(s.options.BootID)
		raw, err := metaTx(tx, key)
		if err != nil {
			return err
		}
		if raw == "" {
			raw = "1"
		}
		sequence, err := decimal.Parse(raw)
		if err != nil {
			return err
		}
		batch := protocol.UsageBatch{
			BootID: s.options.BootID, Sequence: sequence.String(),
			SampledAt: isoMillis(sampledAt), Samples: samples,
		}
		payload, err := json.Marshal(batch)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT INTO usage_batches_v2(boot_id, sequence, sampled_at, payload) VALUES(?, ?, ?, ?)`,
			batch.BootID, batch.Sequence, batch.SampledAt, string(payload)); err != nil {
			return err
		}
		if err := setMetaTx(tx, key, new(big.Int).Add(sequence, big.NewInt(1)).String()); err != nil {
			return err
		}
		result.Batch = &batch
		return nil
	})
	return result, err
}

// folded carries the protocol sample, the columns to persist, and whether the
// sample carries anything the control plane does not already know.
type folded struct {
	protocol.UsageSample
	generation, uplink, downlink, quota, offline string
	// emit is false for an idle user whose counters have not moved since the
	// last tick. Bookkeeping still runs for them; only the wire payload is
	// suppressed. See RecordSample for why that is safe.
	emit bool
}

// foldCounter is the heart of metering, and the one place a mistake silently
// costs money rather than raising an error.
func foldCounter(row *userRow, counter protocol.AbsoluteCounter, backendOnline bool) (folded, bool, error) {
	currentUp, err := decimal.Parse(counter.UplinkBytes)
	if err != nil {
		return folded{}, false, err
	}
	currentDown, err := decimal.Parse(counter.DownlinkBytes)
	if err != nil {
		return folded{}, false, err
	}
	previousUp, err := decimal.Parse(row.Uplink)
	if err != nil {
		return folded{}, false, err
	}
	previousDown, err := decimal.Parse(row.Downlink)
	if err != nil {
		return folded{}, false, err
	}
	generation, err := decimal.Parse(row.Generation)
	if err != nil {
		return folded{}, false, err
	}

	// A counter that went DOWN was reset underneath us — 3x-ui resets Xray's
	// statistics periodically, and Xray itself starts from zero after a restart.
	rolledBack := row.CounterInitialized && (currentUp.Cmp(previousUp) < 0 || currentDown.Cmp(previousDown) < 0)
	if rolledBack {
		generation = new(big.Int).Add(generation, big.NewInt(1))
	}

	deltaUp, deltaDown := big.NewInt(0), big.NewInt(0)
	switch {
	case !row.CounterInitialized:
		// First observation only establishes the baseline: the counter may
		// already hold traffic from before this agent existed, and billing it
		// now would charge the user twice.
	case rolledBack:
		// After a reset the CURRENT value is the whole of the new generation's
		// traffic. Discarding this first sample — the intuitive "wait for the
		// next delta" — loses one interval on every reset, which is a steady,
		// invisible under-count rather than a one-off.
		deltaUp, deltaDown = currentUp, currentDown
	default:
		deltaUp = new(big.Int).Sub(currentUp, previousUp)
		deltaDown = new(big.Int).Sub(currentDown, previousDown)
	}
	delta := new(big.Int).Add(deltaUp, deltaDown)

	quota, err := decimal.Parse(row.QuotaRemainingBytes)
	if err != nil {
		return folded{}, false, err
	}
	nextQuota := big.NewInt(0)
	if quota.Cmp(delta) > 0 {
		nextQuota = new(big.Int).Sub(quota, delta)
	}

	offlineUsed, err := decimal.Parse(row.OfflineUsed)
	if err != nil {
		return folded{}, false, err
	}
	// Reaching the backend settles the debt: everything metered since the last
	// contact is on its way, so the offline budget starts over.
	nextOffline := big.NewInt(0)
	if !backendOnline {
		nextOffline = new(big.Int).Add(offlineUsed, delta)
	}
	allowance, err := decimal.Parse(row.OfflineAllowanceBytes)
	if err != nil {
		return folded{}, false, err
	}
	// The offline allowance bounds how much a node may serve on its own word
	// while it cannot reach the control plane — the ceiling on what a network
	// partition can cost.
	shouldDisable := nextQuota.Sign() == 0 || (!backendOnline && nextOffline.Cmp(allowance) >= 0)

	return folded{
		UsageSample: protocol.UsageSample{
			BindingID:          row.BindingID,
			CounterGeneration:  generation.String(),
			UplinkBytes:        currentUp.String(),
			DownlinkBytes:      currentDown.String(),
			UplinkDeltaBytes:   deltaUp.String(),
			DownlinkDeltaBytes: deltaDown.String(),
		},
		generation: generation.String(),
		uplink:     currentUp.String(),
		downlink:   currentDown.String(),
		quota:      nextQuota.String(),
		offline:    nextOffline.String(),
		// Three things are worth telling the control plane, and idleness is not
		// one of them: this user's first reading (their baseline), any traffic,
		// and a counter reset (the generation bump explains the discontinuity
		// that follows). Everything else repeats what it already has.
		emit: !row.CounterInitialized || rolledBack || delta.Sign() > 0,
	}, shouldDisable, nil
}

// ListPendingBatches returns unacknowledged batches in insertion order.
func (s *Store) ListPendingBatches(limit int) ([]protocol.UsageBatch, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT payload FROM usage_batches_v2 ORDER BY rowid LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	batches := []protocol.UsageBatch{}
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		var batch protocol.UsageBatch
		if err := json.Unmarshal([]byte(payload), &batch); err != nil {
			return nil, err
		}
		batches = append(batches, batch)
	}
	return batches, rows.Err()
}

// AckThrough drops the batches the control plane has accounted for.
func (s *Store) AckThrough(bootID, ackThrough string) (int, error) {
	ack, err := decimal.Parse(ackThrough)
	if err != nil {
		return 0, err
	}
	rows, err := s.db.Query(`SELECT sequence FROM usage_batches_v2 WHERE boot_id = ?`, bootID)
	if err != nil {
		return 0, err
	}
	var sequences []string
	for rows.Next() {
		var sequence string
		if err := rows.Scan(&sequence); err != nil {
			rows.Close()
			return 0, err
		}
		sequences = append(sequences, sequence)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	removed := 0
	err = s.transact(func(tx *sql.Tx) error {
		for _, sequence := range sequences {
			value, err := decimal.Parse(sequence)
			if err != nil {
				return err
			}
			if value.Cmp(ack) > 0 {
				continue
			}
			outcome, err := tx.Exec(`DELETE FROM usage_batches_v2 WHERE boot_id = ? AND sequence = ?`, bootID, sequence)
			if err != nil {
				return err
			}
			affected, err := outcome.RowsAffected()
			if err != nil {
				return err
			}
			removed += int(affected)
		}
		return nil
	})
	return removed, err
}

// PendingBatchCount is the heartbeat's queue depth.
func (s *Store) PendingBatchCount() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM usage_batches_v2`).Scan(&count)
	return count, err
}

// Watermark is the highest unacknowledged sequence within one boot.
type Watermark struct {
	BootID          string `json:"bootId"`
	SequenceThrough string `json:"sequenceThrough"`
}

// PendingBatchWatermarks reports, per boot, how far the local queue reaches.
// A terminal user command carries these so the control plane knows which
// batches must still settle before it may consider the user gone.
func (s *Store) PendingBatchWatermarks() ([]Watermark, error) {
	rows, err := s.db.Query(`SELECT boot_id, sequence FROM usage_batches_v2 ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	order := []string{}
	highest := map[string]*big.Int{}
	for rows.Next() {
		var bootID, sequence string
		if err := rows.Scan(&bootID, &sequence); err != nil {
			return nil, err
		}
		value, err := decimal.Parse(sequence)
		if err != nil {
			return nil, err
		}
		current, seen := highest[bootID]
		if !seen {
			order = append(order, bootID)
			highest[bootID] = value
			continue
		}
		if value.Cmp(current) > 0 {
			highest[bootID] = value
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	watermarks := make([]Watermark, 0, len(order))
	for _, bootID := range order {
		watermarks = append(watermarks, Watermark{BootID: bootID, SequenceThrough: highest[bootID].String()})
	}
	return watermarks, nil
}

// OldestPendingSampledAt exposes how far the queue has fallen behind.
func (s *Store) OldestPendingSampledAt() (string, error) {
	var value sql.NullString
	if err := s.db.QueryRow(`SELECT MIN(sampled_at) FROM usage_batches_v2`).Scan(&value); err != nil {
		return "", err
	}
	return value.String, nil
}

// --- pending removals -------------------------------------------------------

// RecordPendingRemoval remembers that an account WAS this node's, so it can
// still be uninstalled after the desired-user record naming it is gone.
//
// A snapshot applied while this node may not write Xray (shadow_direct,
// xui_primary, rollback_pending) erases the record of every account it drops,
// yet those accounts stay installed in the shared inbound. Without this the next
// promotion to direct_primary would classify them as accounts it has never heard
// of — which, under the panel-shared inbound, means "leave them alone" — and a
// revoked subscription would serve forever.
//
// The table is additive: the Node agent neither reads nor writes it, so a
// rollback to that implementation on the same data directory still works.
func (s *Store) RecordPendingRemoval(emails []string) error {
	if len(emails) == 0 {
		return nil
	}
	return s.transact(func(tx *sql.Tx) error {
		for _, email := range emails {
			if _, err := tx.Exec(
				`INSERT INTO pending_removals_v2(email, recorded_at) VALUES(?, ?) ON CONFLICT(email) DO NOTHING`,
				email, isoMillis(time.Now())); err != nil {
				return err
			}
		}
		return nil
	})
}

// PendingRemovals lists accounts known to be this node's but no longer in the
// desired set.
func (s *Store) PendingRemovals() ([]string, error) {
	rows, err := s.db.Query(`SELECT email FROM pending_removals_v2 ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	emails := []string{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		emails = append(emails, email)
	}
	return emails, rows.Err()
}

// ClearPendingRemoval forgets accounts that have been dealt with — uninstalled,
// or handed back a desired-user record of their own.
func (s *Store) ClearPendingRemoval(emails []string) error {
	if len(emails) == 0 {
		return nil
	}
	return s.transact(func(tx *sql.Tx) error {
		for _, email := range emails {
			if _, err := tx.Exec(`DELETE FROM pending_removals_v2 WHERE email = ?`, email); err != nil {
				return err
			}
		}
		return nil
	})
}

// reassignPlaceholder parks an email that another binding is taking over. The
// NUL byte cannot occur in an address the control plane sends, so a parked row
// can never collide with a real one.
const reassignPlaceholder = "\x00reassign:"

// ApplyDesiredUsers writes a whole desired set in ONE transaction, resolving the
// email hand-offs inside it.
//
// desired_users_v2 has a UNIQUE email, and the control plane may legitimately
// move an address between bindings — including swapping two. Upserting one row
// at a time then fails on the first user whose new email another row still
// holds, and by that point Reconcile's rename pass has already uninstalled the
// accounts: both users are offline and every retry reproduces it exactly.
//
// So every row whose email is being taken over is parked on a placeholder first,
// and only then are the users written. A cycle is no different from a chain once
// nobody holds a contested address. Because it is one transaction, a failure
// leaves no row parked.
//
// A parked row that the new set does not name at all keeps its placeholder until
// ApplyConfigSnapshot deletes it moments later. That is safe only because
// ownership lives in provisioned_accounts_v2 rather than in the row's email — a
// crash in between leaves the account still claimed, and the next reconcile
// retires it.
func (s *Store) ApplyDesiredUsers(users []protocol.DesiredUser) error {
	return s.transact(func(tx *sql.Tx) error {
		taker := make(map[string]string, len(users))
		for _, user := range users {
			taker[user.Email] = user.BindingID
		}
		rows, err := tx.Query(`SELECT binding_id, email FROM desired_users_v2`)
		if err != nil {
			return err
		}
		type held struct{ id, email string }
		var current []held
		for rows.Next() {
			var row held
			if err := rows.Scan(&row.id, &row.email); err != nil {
				rows.Close()
				return err
			}
			current = append(current, row)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		for _, row := range current {
			if to, contested := taker[row.email]; !contested || to == row.id {
				continue
			}
			if _, err := tx.Exec(
				`UPDATE desired_users_v2 SET email = ? WHERE binding_id = ?`,
				reassignPlaceholder+row.id, row.id); err != nil {
				return err
			}
		}
		for _, user := range users {
			if err := upsertDesiredUserTx(tx, user, s.options.DefaultOfflineAllowance); err != nil {
				return err
			}
		}
		return nil
	})
}

// --- provisioning evidence --------------------------------------------------

// RecordProvisioned notes that THIS agent installed an account in Xray.
//
// The distinction this table exists for: under B1 the inbound is shared with the
// 3x-ui panel, and a stored desired-user record does NOT prove ChordV owns the
// account it names. The control plane's getConfig includes PANEL-sourced
// bindings while a node is in xui_primary or shadow_direct, and filters them out
// only in direct_primary. So a node that observed a snapshot in shadow mode has
// desired-user rows for the panel's own accounts — and on promotion the filtered
// set omits them. Deriving ownership from those rows would classify the panel's
// accounts as ChordV leftovers and uninstall them, with RemoveUnknownUsers off
// and nothing to warn anybody.
//
// Provisioning is the fact that survives that: this agent called EnsureUser for
// this email. Nothing the control plane says can manufacture it.
//
// Recorded BEFORE the install, on purpose. If the install then fails we claim an
// account that does not exist, and the worst that costs is one RemoveUser for an
// account Xray does not have — which the adapter contract says succeeds. The
// opposite order risks an installed account nothing claims, which under a shared
// inbound serves forever.
func (s *Store) RecordProvisioned(bindingID, email string) error {
	if email == "" {
		return nil
	}
	_, err := s.db.Exec(`
		INSERT INTO provisioned_accounts_v2(email, binding_id, recorded_at) VALUES(?, ?, ?)
		ON CONFLICT(email) DO UPDATE SET binding_id = excluded.binding_id`,
		email, bindingID, isoMillis(time.Now()))
	return err
}

// ForgetProvisioned drops the claim on accounts that are no longer installed.
func (s *Store) ForgetProvisioned(emails []string) error {
	if len(emails) == 0 {
		return nil
	}
	return s.transact(func(tx *sql.Tx) error {
		for _, email := range emails {
			if _, err := tx.Exec(`DELETE FROM provisioned_accounts_v2 WHERE email = ?`, email); err != nil {
				return err
			}
		}
		return nil
	})
}

// ProvisionedAccounts lists the emails this agent has installed.
func (s *Store) ProvisionedAccounts() ([]string, error) {
	rows, err := s.db.Query(`SELECT email FROM provisioned_accounts_v2 ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	emails := []string{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		emails = append(emails, email)
	}
	return emails, rows.Err()
}

// --- commands ---------------------------------------------------------------

// BeginCommand records a command and reports a previously COMPLETED result for
// it, which the caller must return verbatim instead of executing again.
//
// A FAILED result is cleared instead: the control plane redelivers commands, and
// a transient failure (Xray still starting, a lost connection) must be allowed
// to succeed on a later attempt.
func (s *Store) BeginCommand(command protocol.Command) (*protocol.CommandResult, error) {
	revision, err := decimal.Normalize(command.TargetRevision)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(command)
	if err != nil {
		return nil, err
	}
	var stored sql.NullString
	err = s.db.QueryRow(`SELECT result FROM commands_v2 WHERE command_id = ?`, command.CommandID).Scan(&stored)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return nil, err
	case stored.Valid && stored.String != "":
		var result protocol.CommandResult
		if err := json.Unmarshal([]byte(stored.String), &result); err != nil {
			return nil, err
		}
		if result.Status == protocol.StatusCompleted {
			return &result, nil
		}
		_, err = s.db.Exec(
			`UPDATE commands_v2 SET command_type = ?, target_revision = ?, payload = ?, result = NULL, completed_at = NULL WHERE command_id = ?`,
			string(command.Type), revision, string(payload), command.CommandID)
		return nil, err
	}
	_, err = s.db.Exec(
		`INSERT OR IGNORE INTO commands_v2(command_id, command_type, target_revision, payload) VALUES(?, ?, ?, ?)`,
		command.CommandID, string(command.Type), revision, string(payload))
	return nil, err
}

// CompleteCommand stores the outcome so a redelivery is answered from it.
func (s *Store) CompleteCommand(result protocol.CommandResult) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE commands_v2 SET result = ?, completed_at = ? WHERE command_id = ?`,
		string(encoded), isoMillis(time.Now()), result.CommandID)
	return err
}

// --- health -----------------------------------------------------------------

// HealthSnapshot is what `--health` prints.
func (s *Store) HealthSnapshot() (map[string]any, error) {
	bootID := s.options.BootID
	if s.options.ReadOnly {
		// A read-only probe reports the boot the SERVICE recorded, not its own.
		recorded, err := s.meta("boot_id")
		if err != nil {
			return nil, err
		}
		bootID = recorded
	}
	revision, err := s.ConfigRevision()
	if err != nil {
		return nil, err
	}
	users, err := s.ListDesiredUsers()
	if err != nil {
		return nil, err
	}
	pending, err := s.PendingBatchCount()
	if err != nil {
		return nil, err
	}
	oldest, err := s.OldestPendingSampledAt()
	if err != nil {
		return nil, err
	}
	var journalMode string
	if err := s.db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		return nil, err
	}
	return map[string]any{
		"journalMode":            journalMode,
		"bootId":                 bootID,
		"configRevision":         revision,
		"desiredUsers":           len(users),
		"pendingBatches":         pending,
		"oldestPendingSampledAt": oldest,
	}, nil
}

func openReadOnly(path string, options Options) (*Store, error) {
	// A read-only connection to a WAL database still needs the -shm segment, and
	// SQLite would CREATE it when missing. Checking that the segment exists is
	// NOT enough: the service may stop and remove its sidecars between the check
	// and the open. So the invariant is OWNERSHIP — this process must BE the
	// database's owner, i.e. the service user. Then whatever the race produces
	// belongs to the service either way, and a probe run as root (or as any
	// other account) is refused before SQLite is touched.
	owner, err := fileOwner(path)
	if err != nil {
		return nil, errors.New("本地状态库不存在（服务尚未启动过），健康检查不创建任何文件")
	}
	if effective := os.Geteuid(); effective != owner {
		return nil, fmt.Errorf(
			"健康检查必须以状态库所属用户（uid %d）运行，当前 uid %d："+
				"否则 SQLite 可能在数据目录里创建不属于服务的 WAL 文件", owner, effective)
	}
	if _, err := os.Stat(path + "-shm"); err != nil {
		return nil, errors.New("本地状态库未处于运行状态（缺少 WAL 共享段），健康检查不创建任何文件")
	}
	// Build the URI rather than concatenating it (see fileURI): otherwise the
	// probe would open a DIFFERENT file than the one whose ownership and WAL
	// sidecar it just checked.
	db, err := sql.Open("sqlite", fileURI(path, "mode=ro"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, options: options}
	// The probe must reach the SAME verdict as a start would: a database
	// belonging to another node makes the service refuse to boot, so reporting it
	// healthy would hide exactly the state that keeps it down. Read the recorded
	// identity only — the probe never adopts one.
	recorded, err := store.meta("node_id")
	if err != nil {
		db.Close()
		return nil, err
	}
	if recorded != "" && recorded != options.NodeID {
		db.Close()
		return nil, &ForeignStateError{Recorded: recorded, Current: options.NodeID}
	}
	return store, nil
}
