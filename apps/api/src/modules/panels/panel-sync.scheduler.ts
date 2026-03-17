import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DevDataService } from "../common/dev-data.service";

@Injectable()
export class PanelSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PanelSyncScheduler.name);
  private intervalHandle?: NodeJS.Timeout;
  private bootHandle?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly devDataService: DevDataService) {}

  onModuleInit() {
    const autostart = (process.env.CHORDV_PANEL_SYNC_AUTOSTART ?? "true").toLowerCase() === "true";
    if (!autostart) {
      this.logger.log("Panel sync scheduler disabled by CHORDV_PANEL_SYNC_AUTOSTART");
      return;
    }

    const intervalMs = Number(process.env.CHORDV_PANEL_SYNC_INTERVAL_MS ?? 300000);
    const bootDelayMs = Number(process.env.CHORDV_PANEL_SYNC_BOOT_DELAY_MS ?? 15000);

    this.bootHandle = setTimeout(() => {
      void this.run("boot");
    }, bootDelayMs);

    this.intervalHandle = setInterval(() => {
      void this.run("interval");
    }, intervalMs);

    this.logger.log(`Panel sync scheduler enabled, interval=${intervalMs}ms, bootDelay=${bootDelayMs}ms`);
  }

  onModuleDestroy() {
    if (this.bootHandle) {
      clearTimeout(this.bootHandle);
    }

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  private async run(trigger: "boot" | "interval") {
    if (this.running) {
      this.logger.warn(`Skipped panel sync (${trigger}) because previous run is still in progress`);
      return;
    }

    this.running = true;
    try {
      const result = await this.devDataService.synchronizePanels();
      this.logger.log(`Panel sync (${trigger}) finished: ${JSON.stringify(result)}`);
    } catch (error) {
      this.logger.error(`Panel sync (${trigger}) failed`, error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }
}

