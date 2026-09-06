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
    this.fence(new Error("Shutdown interrupted by a signal; promotion cancelled"));
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
