import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A fresh supervisor token binds approval to this exact application process. */
export class PromotionAdmission {
  private approved = false;
  constructor(
    private readonly token = process.env.CHORDV_SYSTEM_APPROVAL_TOKEN,
    private readonly file = process.env.CHORDV_SYSTEM_APPROVAL_FILE
  ) {}

  isApproved(): boolean {
    if (this.token === undefined) return true; // ordinary unsupervised development
    if (this.approved) return true;
    if (!this.token || !this.file) return false;
    try {
      this.approved = readFileSync(this.file, "utf8") === this.token;
    } catch { return false; } // missing/unreadable/invalid state never admits work
    return this.approved;
  }

  middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = req.url?.split("?", 1)[0];
    const healthProbe = (req.method === "GET" || req.method === "HEAD") &&
      ["/api/health", "/api/health/", "/api/health/ready", "/api/health/ready/"].includes(pathname ?? "");
    if (healthProbe || this.isApproved()) { next(); return; }
    res.writeHead(503, { Connection: "close", "Retry-After": "3" });
    res.end("Service awaiting supervisor approval");
  };
}

export const promotionAdmission = new PromotionAdmission();
