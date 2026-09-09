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
