import assert from "node:assert/strict";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";

// Rate limits are read at module load; set tight limits before importing the service.
process.env.CHORDV_SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_LIMIT = "1";
process.env.CHORDV_SUPPORT_TICKET_ATTACHMENT_DAILY_BYTES_LIMIT = "100";

async function main() {
  const { ClientTicketService } = await import("../src/modules/common/client-ticket.service");

  function createInstance<T>(prototype: object, overrides: Record<string, unknown> = {}) {
    return Object.assign(Object.create(prototype), overrides) as T & Record<string, unknown>;
  }

  function signToken(tokenId: string, userId: string, ticketId: string, expiresAt: number) {
    const secret =
      process.env.CHORDV_SUPPORT_TICKET_ATTACHMENT_TOKEN_SECRET?.trim() ||
      process.env.CHORDV_JWT_SECRET?.trim() ||
      "chordv-dev-support-ticket-attachment-secret";
    return createHash("sha256").update(`${tokenId}.${userId}.${ticketId}.${expiresAt}.${secret}`).digest("hex");
  }

  function makeUploadToken(userId: string, ticketId: string) {
    const tokenId = randomBytes(8).toString("hex");
    const expiresAt = Date.now() + 30 * 60 * 1000;
    return {
      tokenId,
      expiresAt,
      uploadToken: `${tokenId}.${expiresAt}.${signToken(tokenId, userId, ticketId, expiresAt)}`
    };
  }

  function createMemoryPrisma() {
    const pending = new Map<string, any>();
    const rate = new Map<string, { key: string; count: number; updatedAt?: Date }>();
    let pendingChain: Promise<void> = Promise.resolve();

    const withPendingLock = async <T,>(fn: () => Promise<T>) => {
      const run = pendingChain.then(fn, fn);
      pendingChain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    };

    const makePendingApi = (undo: Array<() => void>) => ({
      findMany: async () => [...pending.values()],
      findUnique: async ({ where }: any) => pending.get(where.tokenId) ?? null,
      create: async ({ data }: any) => {
        const prev = pending.has(data.tokenId) ? structuredClone(pending.get(data.tokenId)) : null;
        pending.set(data.tokenId, { ...data });
        undo.push(() => {
          if (prev == null) pending.delete(data.tokenId);
          else pending.set(data.tokenId, prev);
        });
        return data;
      },
      updateMany: async ({ where, data }: any) =>
        withPendingLock(async () => {
          const row = pending.get(where.tokenId);
          if (!row) return { count: 0 };
          if (where.userId != null && row.userId !== where.userId) return { count: 0 };
          if (where.ticketId != null && row.ticketId !== where.ticketId) return { count: 0 };
          if (where.consumed === false && row.consumed !== false) return { count: 0 };
          if (where.url != null && row.url !== where.url) return { count: 0 };
          if (where.expiresAt?.gt instanceof Date && !(row.expiresAt > where.expiresAt.gt)) return { count: 0 };
          const prev = structuredClone(row);
          pending.set(where.tokenId, { ...row, ...data });
          undo.push(() => pending.set(where.tokenId, prev));
          return { count: 1 };
        }),
      deleteMany: async ({ where }: any) =>
        withPendingLock(async () => {
          const ids = where?.tokenId?.in ?? (where?.tokenId ? [where.tokenId] : [...pending.keys()]);
          let count = 0;
          for (const id of ids) {
            const row = pending.get(id);
            if (!row) continue;
            if (where?.consumed === false && row.consumed !== false) continue;
            const prev = structuredClone(row);
            if (pending.delete(id)) {
              undo.push(() => pending.set(id, prev));
              count += 1;
            }
          }
          return { count };
        }),
      delete: async ({ where }: any) =>
        withPendingLock(async () => {
          const row = pending.get(where.tokenId) ?? null;
          if (row) {
            const prev = structuredClone(row);
            pending.delete(where.tokenId);
            undo.push(() => pending.set(where.tokenId, prev));
          }
          return row;
        })
    });

    const rateLimitBucket = {
      findUnique: async ({ where }: any) => rate.get(where.key) ?? null,
      upsert: async ({ where, create }: any) => {
        const existing = rate.get(where.key);
        if (existing) return existing;
        const row = { key: create.key, count: create.count ?? 0, updatedAt: new Date() };
        rate.set(where.key, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const existing = rate.get(where.key) ?? { key: where.key, count: 0 };
        const next = { ...existing, ...data, updatedAt: new Date() };
        rate.set(where.key, next);
        return next;
      },
      updateMany: async ({ where, data }: any) => {
        const existing = rate.get(where.key);
        if (!existing) return { count: 0 };
        if (typeof where.count?.lte === "number" && existing.count > where.count.lte) return { count: 0 };
        if (typeof where.count?.gte === "number" && existing.count < where.count.gte) return { count: 0 };
        let nextCount = existing.count;
        if (typeof data.count === "number") nextCount = data.count;
        else if (typeof data.count?.increment === "number") nextCount = existing.count + data.count.increment;
        else if (typeof data.count?.decrement === "number") nextCount = existing.count - data.count.decrement;
        rate.set(where.key, { ...existing, count: nextCount, updatedAt: new Date() });
        return { count: 1 };
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [key, row] of [...rate.entries()]) {
          const matches = (where?.OR ?? []).some((clause: any) => {
            const prefix = clause?.key?.startsWith;
            if (typeof prefix !== "string" || !key.startsWith(prefix)) {
              return false;
            }
            const staleBefore = clause?.updatedAt?.lt;
            return !(staleBefore instanceof Date) || (row.updatedAt instanceof Date && row.updatedAt < staleBefore);
          });
          if (!matches) continue;
          rate.delete(key);
          count += 1;
        }
        return { count };
      }
    };

    const rootUndo: Array<() => void> = [];
    const rootPending = makePendingApi(rootUndo);

    return {
      supportTicket: {
        findFirst: async () => ({
          id: "ticket_1",
          status: "waiting_user",
          userId: "user_1",
          title: "t",
          source: "client",
          subscriptionId: null,
          teamId: null,
          lastMessageAt: new Date(),
          closedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          team: null,
          messages: [],
          readStates: []
        })
      },
      supportTicketPendingAttachment: rootPending,
      rateLimitBucket,
      $transaction: async (fn: any) => {
        const undo: Array<() => void> = [];
        const txPending = makePendingApi(undo);
        try {
          return await fn({
            supportTicketPendingAttachment: txPending,
            rateLimitBucket,
            supportTicketMessage: { create: async ({ data }: any) => ({ id: data.id }) },
            supportTicketAttachment: { create: async () => ({}) },
            supportTicket: { update: async () => ({}) },
            supportTicketReadState: { upsert: async () => ({}) }
          });
        } catch (error) {
          for (const step of undo.reverse()) step();
          throw error;
        }
      },
      __pending: pending,
      __rate: rate
    };
  }

  async function testUploadCleansRemoteWhenPendingCreateFails() {
    const deleted: string[] = [];
    const prisma = createMemoryPrisma();
    prisma.supportTicketPendingAttachment.create = async () => {
      throw new Error("pending insert failed");
    };
    const service = createInstance(ClientTicketService.prototype, {
      authSessionService: { authenticateAccessToken: async () => ({ id: "user_1" }) },
      prisma,
      imageBedService: {
        assertSupportTicketAttachment: () => undefined,
        uploadSupportTicketAttachment: async () => ({
          url: "https://image.achord.cn/file/support-tickets/a.png",
          providerFileId: "support-tickets/a.png",
          fileName: "a.png",
          mimeType: "image/png",
          fileSizeBytes: BigInt(10)
        }),
        deleteUploadedSupportTicketAttachmentBestEffort: async (uploaded: any) => {
          deleted.push(uploaded.providerFileId ?? uploaded.url);
          return true;
        }
      }
    });

    await assert.rejects(
      () =>
        service.uploadClientSupportTicketAttachment(
          "ticket_1",
          { path: "tmp.png", originalname: "a.png", mimetype: "image/png", size: 10 },
          "token"
        ),
      (error) => error instanceof ServiceUnavailableException
    );
    assert.deepEqual(deleted, ["support-tickets/a.png"], "pending-create failure must remote-delete exactly once");
    assert.equal([...prisma.__rate.values()].every((row) => row.count === 0), true);
  }


  async function testUploadRequestDoesNotWaitForExpiredRemoteCleanup() {
    const prisma = createMemoryPrisma();
    prisma.__pending.set("expired_token", {
      tokenId: "expired_token",
      userId: "user_2",
      ticketId: "ticket_old",
      url: "https://image.achord.cn/file/support-tickets/expired.png",
      providerFileId: "support-tickets/expired.png",
      fileName: "expired.png",
      mimeType: "image/png",
      fileSizeBytes: BigInt(10),
      consumed: false,
      createdAt: new Date(0),
      expiresAt: new Date(1)
    });
    let cleanupCalls = 0;
    const service = createInstance(ClientTicketService.prototype, {
      authSessionService: { authenticateAccessToken: async () => ({ id: "user_1" }) },
      prisma,
      imageBedService: {
        assertSupportTicketAttachment: () => undefined,
        uploadSupportTicketAttachment: async () => ({
          url: "https://image.achord.cn/file/support-tickets/new.png",
          providerFileId: "support-tickets/new.png",
          fileName: "new.png",
          mimeType: "image/png",
          fileSizeBytes: BigInt(10)
        }),
        deleteUploadedSupportTicketAttachmentBestEffort: async () => {
          cleanupCalls += 1;
          return true;
        }
      }
    });

    const uploaded = await service.uploadClientSupportTicketAttachment(
      "ticket_1",
      { path: "tmp.png", originalname: "new.png", mimetype: "image/png", size: 10 },
      "token"
    );

    assert.ok(uploaded.uploadToken);
    assert.equal(cleanupCalls, 0, "user upload request must not synchronously run expired remote cleanup");
    assert.equal(prisma.__pending.has("expired_token"), true, "background janitor owns expired cleanup");
  }

  async function testUrlMismatchDoesNotConsumeOrRemoteDelete() {
    const deleted: string[] = [];
    const prisma = createMemoryPrisma();
    const token = makeUploadToken("user_1", "ticket_1");
    prisma.__pending.set(token.tokenId, {
      tokenId: token.tokenId,
      userId: "user_1",
      ticketId: "ticket_1",
      url: "https://image.achord.cn/file/support-tickets/real.png",
      providerFileId: "support-tickets/real.png",
      fileName: "real.png",
      mimeType: "image/png",
      fileSizeBytes: BigInt(12),
      consumed: false,
      createdAt: new Date(),
      expiresAt: new Date(token.expiresAt)
    });

    const service = createInstance(ClientTicketService.prototype, {
      authSessionService: { authenticateAccessToken: async () => ({ id: "user_1" }) },
      prisma,
      imageBedService: {
        deleteUploadedSupportTicketAttachmentBestEffort: async (uploaded: any) => {
          deleted.push(uploaded.providerFileId ?? uploaded.url);
          return true;
        }
      },
      getClientSupportTicketDetailAfterWrite: async () => ({ id: "ticket_1" }),
      publishTicketEventBestEffort: () => undefined,
      buildClientSupportTicketWriteFallback: () => ({ id: "ticket_1" })
    });

    await assert.rejects(
      () =>
        service.replyClientSupportTicket(
          "ticket_1",
          {
            body: "hi",
            attachment: {
              uploadToken: token.uploadToken,
              url: "https://image.achord.cn/file/support-tickets/forged.png",
              fileName: "real.png",
              mimeType: "image/png",
              fileSizeBytes: "12"
            }
          } as any,
          "token"
        ),
      (error) => error instanceof BadRequestException
    );
    assert.equal(prisma.__pending.has(token.tokenId), true, "pending must remain after URL mismatch rollback");
    assert.equal(prisma.__pending.get(token.tokenId).consumed, false);
    assert.deepEqual(deleted, [], "must not remote-delete when DB claim rolls back");
  }

  async function testDbFailureDoesNotRemoteDeleteClaimedFile() {
    const deleted: string[] = [];
    const prisma = createMemoryPrisma();
    const token = makeUploadToken("user_1", "ticket_1");
    prisma.__pending.set(token.tokenId, {
      tokenId: token.tokenId,
      userId: "user_1",
      ticketId: "ticket_1",
      url: "https://image.achord.cn/file/support-tickets/keep.png",
      providerFileId: "support-tickets/keep.png",
      fileName: "keep.png",
      mimeType: "image/png",
      fileSizeBytes: BigInt(12),
      consumed: false,
      createdAt: new Date(),
      expiresAt: new Date(token.expiresAt)
    });

    const originalTx = prisma.$transaction;
    prisma.$transaction = async (fn: any) => {
      return originalTx(async (tx: any) => {
        const result = await fn({
          ...tx,
          supportTicketMessage: {
            create: async () => {
              throw new Error("message insert failed");
            }
          }
        });
        return result;
      });
    };

    const service = createInstance(ClientTicketService.prototype, {
      authSessionService: { authenticateAccessToken: async () => ({ id: "user_1" }) },
      prisma,
      imageBedService: {
        deleteUploadedSupportTicketAttachmentBestEffort: async (uploaded: any) => {
          deleted.push(uploaded.providerFileId ?? uploaded.url);
          return true;
        }
      },
      getClientSupportTicketDetailAfterWrite: async () => ({ id: "ticket_1" }),
      publishTicketEventBestEffort: () => undefined,
      buildClientSupportTicketWriteFallback: () => ({ id: "ticket_1" })
    });

    await assert.rejects(
      () =>
        service.replyClientSupportTicket(
          "ticket_1",
          {
            body: "hi",
            attachment: {
              uploadToken: token.uploadToken,
              url: "https://image.achord.cn/file/support-tickets/keep.png",
              fileName: "keep.png",
              mimeType: "image/png",
              fileSizeBytes: "12"
            }
          } as any,
          "token"
        ),
      (error) => error instanceof ServiceUnavailableException
    );
    assert.equal(prisma.__pending.has(token.tokenId), true, "pending restored after tx rollback");
    assert.equal(prisma.__pending.get(token.tokenId).consumed, false);
    assert.deepEqual(deleted, [], "remote file must survive rolled-back claim");
  }

  async function testConcurrentQuotaIsAtomic() {
    const prisma = createMemoryPrisma();
    const service = createInstance(ClientTicketService.prototype, {
      authSessionService: { authenticateAccessToken: async () => ({ id: "user_1" }) },
      prisma,
      imageBedService: {
        assertSupportTicketAttachment: () => undefined,
        uploadSupportTicketAttachment: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            url: "https://image.achord.cn/file/support-tickets/b.png",
            providerFileId: "support-tickets/b.png",
            fileName: "b.png",
            mimeType: "image/png",
            fileSizeBytes: BigInt(10)
          };
        },
        deleteUploadedSupportTicketAttachmentBestEffort: async () => true
      }
    });

    const file = { path: "tmp.png", originalname: "b.png", mimetype: "image/png", size: 10 };
    const results = await Promise.allSettled([
      service.uploadClientSupportTicketAttachment("ticket_1", file, "token"),
      service.uploadClientSupportTicketAttachment("ticket_1", file, "token")
    ]);
    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter((item) => item.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].status === "rejected" && rejected[0].reason instanceof BadRequestException);
  }

  async function testSameTokenConcurrentConsumeDoesNotDeleteWinnerFile() {
    const deleted: string[] = [];
    const prisma = createMemoryPrisma();
    const token = makeUploadToken("user_1", "ticket_1");
    prisma.__pending.set(token.tokenId, {
      tokenId: token.tokenId,
      userId: "user_1",
      ticketId: "ticket_1",
      url: "https://image.achord.cn/file/support-tickets/shared.png",
      providerFileId: "support-tickets/shared.png",
      fileName: "shared.png",
      mimeType: "image/png",
      fileSizeBytes: BigInt(12),
      consumed: false,
      createdAt: new Date(),
      expiresAt: new Date(token.expiresAt)
    });

    let claimGate: Promise<void> | null = null;
    let releaseGate: (() => void) | null = null;
    const originalUpdateMany = prisma.supportTicketPendingAttachment.updateMany;
    // Patch root API used outside pure snapshot is insufficient; gate inside transaction clone via wrapper on $transaction
    const originalTx = prisma.$transaction;
    prisma.$transaction = async (fn: any) => {
      return originalTx(async (tx: any) => {
        const realUpdateMany = tx.supportTicketPendingAttachment.updateMany;
        tx.supportTicketPendingAttachment.updateMany = async (args: any) => {
          if (!claimGate) {
            claimGate = new Promise((resolve) => {
              releaseGate = resolve;
            });
            await new Promise((resolve) => setTimeout(resolve, 15));
            const result = await realUpdateMany(args);
            releaseGate?.();
            return result;
          }
          await claimGate;
          return realUpdateMany(args);
        };
        return fn(tx);
      });
    };

    const service = createInstance(ClientTicketService.prototype, {
      authSessionService: { authenticateAccessToken: async () => ({ id: "user_1" }) },
      prisma,
      imageBedService: {
        deleteUploadedSupportTicketAttachmentBestEffort: async (uploaded: any) => {
          deleted.push(uploaded.providerFileId ?? uploaded.url);
          return true;
        }
      },
      getClientSupportTicketDetailAfterWrite: async () => ({ id: "ticket_1" }),
      publishTicketEventBestEffort: () => undefined,
      buildClientSupportTicketWriteFallback: () => ({ id: "ticket_1" })
    });

    const payload = {
      body: "hi",
      attachment: {
        uploadToken: token.uploadToken,
        url: "https://image.achord.cn/file/support-tickets/shared.png",
        fileName: "shared.png",
        mimeType: "image/png",
        fileSizeBytes: "12"
      }
    };

    const results = await Promise.allSettled([
      service.replyClientSupportTicket("ticket_1", payload as any, "token"),
      service.replyClientSupportTicket("ticket_1", payload as any, "token")
    ]);
    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter((item) => item.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one consumer should win");
    assert.equal(rejected.length, 1, "loser must fail");
    assert.ok(rejected[0].status === "rejected" && rejected[0].reason instanceof BadRequestException);
    assert.deepEqual(deleted, [], "loser must not remote-delete winner image");
    assert.equal(prisma.__pending.has(token.tokenId), false);
  }

  async function testMultipartReplyRefundsQuotaOnUploadFailure() {
    const prisma = createMemoryPrisma();
    const service = createInstance(ClientTicketService.prototype, {
      authSessionService: { authenticateAccessToken: async () => ({ id: "user_1" }) },
      prisma,
      logger: { warn: () => undefined, error: () => undefined, log: () => undefined },
      imageBedService: {
        assertSupportTicketAttachment: () => undefined,
        uploadSupportTicketAttachment: async () => {
          throw new Error("upload boom");
        },
        deleteUploadedSupportTicketAttachmentBestEffort: async () => true
      },
      getClientSupportTicketDetailAfterWrite: async () => ({ id: "ticket_1" }),
      publishTicketEventBestEffort: () => undefined,
      buildClientSupportTicketWriteFallback: () => ({ id: "ticket_1" })
    });

    await assert.rejects(
      () =>
        service.replyClientSupportTicketWithAttachment(
          "ticket_1",
          { body: null },
          { path: "tmp.png", originalname: "c.png", mimetype: "image/png", size: 10 },
          "token"
        ),
      (error) => error instanceof ServiceUnavailableException
    );
    assert.equal([...prisma.__rate.values()].every((row) => row.count === 0), true, "multipart upload failure must refund quota");
  }

  async function testMultipartQuotaReservationSettlesOnlyOnce() {
    const prisma = createMemoryPrisma();
    const originalTransaction = prisma.$transaction.bind(prisma);
    let transactionCount = 0;
    prisma.$transaction = async (fn: any) => {
      transactionCount += 1;
      if (transactionCount === 3) {
        for (const [key, row] of prisma.__rate.entries()) {
          prisma.__rate.set(key, {
            ...row,
            count: key.startsWith("ticket-att-rate:") ? 1 : 10
          });
        }
        throw new Error("message save failed after another reservation");
      }
      return originalTransaction(fn);
    };

    const service = createInstance(ClientTicketService.prototype, {
      authSessionService: { authenticateAccessToken: async () => ({ id: "user_1" }) },
      prisma,
      logger: { warn: () => undefined, error: () => undefined, log: () => undefined },
      imageBedService: {
        assertSupportTicketAttachment: () => undefined,
        uploadSupportTicketAttachment: async () => {
          throw new Error("upload boom");
        },
        deleteUploadedSupportTicketAttachmentBestEffort: async () => true
      }
    });

    await assert.rejects(
      () =>
        service.replyClientSupportTicketWithAttachment(
          "ticket_1",
          { body: "keep text reply" },
          { path: "tmp.png", originalname: "c.png", mimetype: "image/png", size: 10 },
          "token"
        ),
      (error) => error instanceof ServiceUnavailableException
    );

    const rateRow = [...prisma.__rate.entries()].find(([key]) => key.startsWith("ticket-att-rate:"))?.[1];
    const dailyRow = [...prisma.__rate.entries()].find(([key]) => key.startsWith("ticket-att-daily:"))?.[1];
    assert.equal(rateRow?.count, 1, "second reservation must survive the first request's later DB failure");
    assert.equal(dailyRow?.count, 10, "daily bytes for the second reservation must not be refunded twice");
  }
  async function testQuotaReleaseUsesReservedKeysAcrossWindowBoundary() {
    const prisma = createMemoryPrisma();
    // Manually reserve using old keys, then release must hit same keys even if "now" moved.
    const userId = "user_1";
    const oldNow = Date.now() - SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_WINDOW_MS_SAFE();
    const windowStart = oldNow - (oldNow % (60 * 60 * 1000));
    const rateKey = `ticket-att-rate:${userId}:${windowStart}`;
    const day = new Date(oldNow).toISOString().slice(0, 10);
    const dailyKey = `ticket-att-daily:${userId}:${day}`;
    prisma.__rate.set(rateKey, { key: rateKey, count: 1 });
    prisma.__rate.set(dailyKey, { key: dailyKey, count: 10 });

    // Import release through a side channel by exercising upload fail path after monkeypatching Date.
    // Instead call release by reusing service upload path: assert then fail upload after advancing time.
    const realDateNow = Date.now;
    let now = oldNow;
    Date.now = () => now as number;
    try {
      const service = createInstance(ClientTicketService.prototype, {
        authSessionService: { authenticateAccessToken: async () => ({ id: userId }) },
        prisma,
        imageBedService: {
          assertSupportTicketAttachment: () => undefined,
          uploadSupportTicketAttachment: async () => {
            // Cross hour boundary before failure cleanup runs.
            now = oldNow + 60 * 60 * 1000 + 5;
            throw new Error("boom");
          },
          deleteUploadedSupportTicketAttachmentBestEffort: async () => true
        }
      });
      // Clear preseed and use real assert from code path.
      prisma.__rate.clear();
      await assert.rejects(
        () =>
          service.uploadClientSupportTicketAttachment(
            "ticket_1",
            { path: "tmp.png", originalname: "d.png", mimetype: "image/png", size: 10 },
            "token"
          ),
        () => true
      );
      assert.equal([...prisma.__rate.values()].every((row) => row.count === 0), true, "release must target reserved keys, not current window");
    } finally {
      Date.now = realDateNow;
    }
  }

  async function testJanitorKeepsCurrentUtcDailyBucket() {
    const prisma = createMemoryPrisma();
    const now = Date.UTC(2026, 6, 18, 12, 0, 0);
    const currentDailyKey = "ticket-att-daily:user_1:2026-07-18";
    const previousDailyKey = "ticket-att-daily:user_1:2026-07-17";
    const staleHourlyKey = "ticket-att-rate:user_1:" + (now - 3 * 60 * 60 * 1000);
    prisma.__rate.set(currentDailyKey, {
      key: currentDailyKey,
      count: 90,
      updatedAt: new Date(now - 3 * 60 * 60 * 1000)
    });
    prisma.__rate.set(previousDailyKey, {
      key: previousDailyKey,
      count: 90,
      updatedAt: new Date(Date.UTC(2026, 6, 17, 23, 59, 59))
    });
    prisma.__rate.set(staleHourlyKey, {
      key: staleHourlyKey,
      count: 1,
      updatedAt: new Date(now - 3 * 60 * 60 * 1000)
    });

    const service = createInstance(ClientTicketService.prototype, {
      prisma,
      imageBedService: {
        deleteUploadedSupportTicketAttachmentBestEffort: async () => true
      },
      logger: {
        warn: () => undefined
      }
    });
    const realDateNow = Date.now;
    Date.now = () => now;
    try {
      await (service as any).pruneExpiredPendingAttachmentsAndCleanup();
    } finally {
      Date.now = realDateNow;
    }

    assert.equal(prisma.__rate.has(currentDailyKey), true, "current UTC daily bucket must survive janitor");
    assert.equal(prisma.__rate.has(previousDailyKey), false, "previous UTC daily bucket should be pruned");
    assert.equal(prisma.__rate.has(staleHourlyKey), false, "hourly bucket older than two windows should be pruned");
  }
  function SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_WINDOW_MS_SAFE() {
    return 60 * 60 * 1000;
  }

  await testUploadCleansRemoteWhenPendingCreateFails();
  await testUploadRequestDoesNotWaitForExpiredRemoteCleanup();
  await testUrlMismatchDoesNotConsumeOrRemoteDelete();
  await testDbFailureDoesNotRemoteDeleteClaimedFile();
  await testConcurrentQuotaIsAtomic();
  await testSameTokenConcurrentConsumeDoesNotDeleteWinnerFile();
  await testMultipartReplyRefundsQuotaOnUploadFailure();
  await testMultipartQuotaReservationSettlesOnlyOnce();
  await testQuotaReleaseUsesReservedKeysAcrossWindowBoundary();
  await testJanitorKeepsCurrentUtcDailyBucket();
  console.log("client-ticket-attachment-hardening.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});