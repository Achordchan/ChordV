import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";

/**
 * Waits for tests that drive the real supervisor (deploy/backend/entrypoint.sh).
 *
 * The supervisor has no latency bound for most steps: every state write ends with a
 * global `sync`, journal parsing and approval tokens each spawn node, the health gate
 * polls once per second, and persistence failures retry every 2s for as long as the
 * app lives. On a loaded host (parallel cargo/tsc builds) any of these can stretch far
 * beyond an idle run, so "it should have happened within N seconds" is a bet on host
 * speed, not a property of the supervisor. These waits therefore end on state:
 *   - the expected condition holds (pass);
 *   - the supervisor exited first (fail at once; state written before exit is
 *     re-checked, so an expected exit after persisting a result still passes);
 *   - the supervisor logged that it left the expected path (fail at once).
 * The only wall clock left is a hang guard far beyond any plausible slowdown, for a
 * genuinely stuck supervisor; it is not a latency expectation.
 */
export const SUPERVISOR_HANG_GUARD_MS = 5 * 60_000;

/**
 * Health-gate budget for launches that are EXPECTED to pass (or to fail by exiting).
 * A healthy stub passes on its first successful probe and a crashing stub is caught by
 * the liveness check, so a generous value costs nothing; a short one would turn a slow
 * launch into a rollback and fail the test for the wrong reason. Kept well below the
 * hang guard so a genuinely unhealthy launch still surfaces as a supervisor decision.
 */
export const TEST_HEALTH_TIMEOUT_SECONDS = "120";

/** Supervisor log lines proving a launch that should finalize went down another path. */
export const LEFT_HEALTHY_PATH = /failed to become healthy\+stable|re-gating to retry finalization|auto-rolling back|FATAL:/;

/**
 * For waits on a finalization step the test is holding (or has just released): the
 * supervisor logs "healthy + stable" only AFTER that step's state is on disk, so seeing
 * it while the awaited state is still absent means the step was skipped.
 */
export const SKIPPED_HELD_STEP = new RegExp(`${LEFT_HEALTHY_PATH.source}|healthy \\+ stable \\(last-good\\)`);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function exited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Resolve once `done()` holds. Fails as soon as the supervisor exits without it, or
 * (with `failOn`) as soon as a matching line appears in the log written after this
 * wait began.
 */
export async function waitForSupervisor(
  child: ChildProcess,
  what: string,
  done: () => boolean,
  logs: () => string,
  failOn?: RegExp
): Promise<void> {
  const started = Date.now();
  const from = logs().length;
  for (;;) {
    if (done()) return;
    if (exited(child)) {
      if (done()) return;
      assert.fail(`supervisor exited (code ${child.exitCode}, signal ${child.signalCode}) before ${what}.\n${logs()}`);
    }
    const wrongPath = failOn && logs().slice(from).match(failOn);
    if (wrongPath) assert.fail(`supervisor left the expected path before ${what} ("${wrongPath[0]}").\n${logs()}`);
    assert.ok(Date.now() - started < SUPERVISOR_HANG_GUARD_MS,
      `no ${what} after ${SUPERVISOR_HANG_GUARD_MS / 60_000} min (hang guard, not a latency expectation).\n${logs()}`);
    await sleep(50);
  }
}

/** Resolve once the supervisor process has exited (e.g. a fail-closed interlock). */
export async function waitForSupervisorExit(child: ChildProcess, what: string, logs: () => string): Promise<void> {
  await waitForSupervisor(child, what, () => exited(child), logs);
}
