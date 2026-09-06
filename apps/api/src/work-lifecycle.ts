import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { finalize } from "rxjs";
import { promotionAdmission } from "./promotion-admission";

/** Explicit accounting, not cancellation: a response/remote-call budget is NOT task completion. */
export class WorkLifecycle implements NestInterceptor {
  private draining = false;
  private readonly active = new Set<symbol>();
  private readonly streamClosers = new Set<() => void>();
  private failure: Error | undefined;
  private recoveryHold?: NodeJS.Timeout;

  fence(error: Error) {
    this.draining = true;
    this.failure = error;
    // Even after app.close() and a lost PG session, do not naturally exit and let
    // the supervisor restart a partially shut down application without an operator.
    this.recoveryHold ??= setInterval(() => undefined, 60_000);
  }

  cancelDrain() {
    this.fence(new DrainCancelledError());
  }

  get isDraining() { return this.draining; }
  assertHealthy() { if (this.failure) throw this.failure; }

  enter(): () => void {
    const token = Symbol();
    this.active.add(token);
    return () => { this.active.delete(token); };
  }

  track<T>(task: Promise<T>): Promise<T> {
    const leave = this.enter();
    // Observe both outcomes without manufacturing an unhandled rejected promise.
    void task.then(leave, leave);
    return task;
  }

  /**
   * Await a task under a time budget. Accounting covers ONLY the waiting
   * window: when the budget expires, the still-pending task is abandoned to
   * its owner (a retry queue, a background logger) instead of holding a work
   * item for as long as the underlying promise happens to take. A
   * never-settling remote call raced against `workLifecycle.track(...)` used
   * to block every self-update drain until the full drain timeout ("N work
   * items remain") and fence the process.
   */
  async awaitWithBudget<T>(
    task: Promise<T>,
    timeoutMs: number,
    makeTimeoutError: () => Error = () => new WorkBudgetExceededError(timeoutMs)
  ): Promise<T> {
    // Enter BEFORE creating the timer: if entry can ever fail, no timer must
    // be left behind unraced — its later rejection would be unhandled.
    const leave = this.enter();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutTask = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(makeTimeoutError()), timeoutMs);
      });
      return await Promise.race([task, timeoutTask]);
    } finally {
      leave();
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Like `awaitWithBudget`, but budget expiry is a NORMAL outcome rather than an
   * error: `onExpiry` runs (the caller's "saved, but X exceeded its budget and
   * will continue in background" warning) and ITS return value resolves the call.
   * Evaluated lazily on expiry only, so a fallback that costs something — or that
   * a successful task would have made wrong — is never built on the happy path.
   * The fallback need NOT share the task's type — the result is the union, as
   * `Promise.race` gave. A failure of the task itself still propagates: call
   * sites keep their own handling for that.
   */
  async awaitWithBudgetElse<T, F = T>(task: Promise<T>, timeoutMs: number, onExpiry: () => F): Promise<T | F> {
    try {
      // Passed explicitly, not left to the default: this method's correctness is
      // the round trip through exactly this error type, not whatever the default is.
      return await this.awaitWithBudget(task, timeoutMs, () => new WorkBudgetExceededError(timeoutMs));
    } catch (error) {
      if (error instanceof WorkBudgetExceededError) return onExpiry();
      throw error;
    }
  }

  all<T extends readonly unknown[] | []>(tasks: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
    // Promise.all rejects early; sibling writes may still be running after that.
    return Promise.all(tasks.map((task) => this.track(Promise.resolve(task)))) as Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  }

  defer(task: () => unknown | Promise<unknown>, delayMs: number): NodeJS.Timeout {
    const leave = this.enter();
    return setTimeout(() => {
      try {
        void Promise.resolve(task()).then(leave, (error) => {
          this.failure = new Error(`Deferred work failed: ${String(error)}`);
          leave();
        });
      } catch (error) {
        this.failure = new Error(`Deferred work failed: ${String(error)}`);
        leave();
      }
    }, delayMs);
  }

  onDrain(close: () => void): () => void {
    if (this.draining) close();
    else this.streamClosers.add(close);
    return () => { this.streamClosers.delete(close); };
  }

  middleware = (_req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (this.draining) {
      res.writeHead(503, { Connection: "close", "Retry-After": "30" });
      res.end("Service draining for restart");
      return;
    }
    const leave = this.enter();
    // Count body reception (including multipart) before Nest's parsers/interceptors.
    res.once("finish", leave);
    res.once("close", leave);
    next();
  };

  intercept(_context: ExecutionContext, next: CallHandler) {
    // A disconnected socket doesn't cancel an async controller or its DB work.
    const leave = this.enter();
    try { return next.handle().pipe(finalize(leave)); }
    catch (error) { leave(); throw error; }
  }

  async drain(server: Server, timeoutMs: number): Promise<void> {
    if (this.draining) throw new Error("Shutdown already started; manual recovery required");
    this.draining = true;
    // Read-only SSE subscriptions are deliberately completed, not awaited forever.
    for (const close of this.streamClosers) close();
    this.streamClosers.clear();
    let closed = false;
    server.close((error?: Error) => {
      // Startup signals may arrive before listen(). That server is already closed;
      // still drain registered work and preserve every other close failure.
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") this.failure = error;
      closed = true;
    });
    server.closeIdleConnections();
    const deadline = Date.now() + timeoutMs;
    while (!closed || this.active.size > 0) {
      // Connections that were active at close() may become idle later (Node 20).
      server.closeIdleConnections();
      if (this.failure) throw this.failure;
      if (Date.now() >= deadline) {
        throw new Error(`Drain timed out after ${timeoutMs}ms (${this.active.size} work items remain); no promotion permitted`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (this.failure) throw this.failure;
  }
}

// One registry for this single-process deployment; utility functions can account for
// underlying promises too, without changing every service's DI constructor.
export const workLifecycle = new WorkLifecycle();

/**
 * Budget expiry for `awaitWithBudget`: the waiting window ended, the task itself
 * was abandoned to its owner (a retry queue, a background logger) and may still
 * be running. Distinguishable so a caller can treat expiry as an expected
 * outcome (see `awaitWithBudgetElse`) without swallowing real task failures.
 */
export class WorkBudgetExceededError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`work budget of ${timeoutMs}ms exceeded`);
  }
}

/**
 * A shutdown interrupted by a repeated signal. Distinct from drain failures:
 * the operator explicitly cancelled, so the caller must keep the process
 * fenced (the supervisor's stop flow owns it) instead of exiting for an
 * automatic same-version restart.
 */
export class DrainCancelledError extends Error {
  constructor() {
    super("Shutdown interrupted by a signal; promotion cancelled");
  }
}

/** Apply under @Cron: reject new ticks before they claim DB jobs; await the actual batch. */
export function DrainableJob(): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    descriptor.value = function (...args: unknown[]) {
      if (workLifecycle.isDraining || !promotionAdmission.isApproved()) return Promise.resolve();
      return workLifecycle.track(Promise.resolve().then(() => original.apply(this, args)));
    };
  };
}

export async function withShutdownDeadline(task: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([task, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Nest shutdown timed out after ${timeoutMs}ms; no promotion permitted`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
