import { ForbiddenException, Injectable, MessageEvent, NotFoundException } from "@nestjs/common";
import { watch, type FSWatcher } from "node:fs";
import { Observable } from "rxjs";
import { AuthSessionService } from "../common/auth-session.service";
import { SystemUpdateService } from "../common/system-update.service";
import { workLifecycle } from "../../work-lifecycle";

/** Application progress is pushed after persistence; supervisor progress comes
 * from its atomic state files. Reconnection always begins with a fresh snapshot. */
@Injectable()
export class SystemUpdateStreamService {
  constructor(private readonly updates: SystemUpdateService, private readonly auth: AuthSessionService) {}

  stream(operationId: string, authorization?: string): Observable<MessageEvent> {
    return new Observable(subscriber => {
      if (workLifecycle.isDraining) { subscriber.complete(); return; }
      let busy = false, dirty = false, last = "";
      let watcher: FSWatcher | undefined;
      const snapshot = async () => {
        if (subscriber.closed) return;
        if (busy) { dirty = true; return; }
        busy = true;
        try {
          const user = await this.auth.authenticateAccessToken(authorization);
          if (user.role !== "admin") throw new ForbiddenException("需要管理员权限");
          const operation = await this.updates.getOperation(operationId);
          if (!operation) throw new NotFoundException("更新任务不存在");
          if (subscriber.closed) return;
          const data = JSON.stringify({ operation });
          if (data !== last) { last = data; subscriber.next({ type: "operation", data }); }
          else subscriber.next({ type: "keepalive", data: "{}" });
          if (operation && ["succeeded", "failed", "rolled_back"].includes(operation.status)) subscriber.complete();
        } catch (error) {
          if (!subscriber.closed) subscriber.error(error);
        } finally {
          busy = false;
          if (dirty && !subscriber.closed) { dirty = false; refresh(); }
        }
      };
      const refresh = () => { void workLifecycle.track(snapshot()); };
      const changes = this.updates.observeOperation(operationId).subscribe({ next: refresh, complete: () => subscriber.complete() });
      const directory = this.updates.operationStateDirectory();
      if (directory) {
        try {
          watcher = watch(directory, (_event, filename) => {
            const name = filename?.toString() ?? "";
            if (!name || name === "phase.json" || name.startsWith("operation-result.")) refresh();
          });
          watcher.on("error", () => { watcher?.close(); watcher = undefined; refresh(); });
        } catch { /* heartbeat snapshots recover if the filesystem cannot be watched */ }
      }
      // Snapshot on heartbeat repairs dropped fs notifications and revalidates
      // authorization. It is bounded by this active stream and terminal outcome.
      const heartbeat = setInterval(refresh, 15_000);
      const offDrain = workLifecycle.onDrain(() => subscriber.complete());
      refresh();
      return () => { clearInterval(heartbeat); changes.unsubscribe(); watcher?.close(); offDrain(); };
    });
  }
}
