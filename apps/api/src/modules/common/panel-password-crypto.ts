import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PANEL_PASSWORD_PREFIX = "enc:v1:";
const KEY_VERSION = "v1";

function isEnabled(value: string | undefined) {
  return (value ?? "").trim().toLowerCase() === "true";
}

function resolveMasterKey(): Buffer | null {
  const raw =
    process.env.CHORDV_PANEL_PASSWORD_MASTER_KEY?.trim() ||
    process.env.CHORDV_SECRET_ENCRYPTION_KEY?.trim() ||
    "";
  const production = process.env.NODE_ENV === "production";
  if (!raw) {
    if (production && !isEnabled(process.env.CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD)) {
      throw new Error(
        "Missing CHORDV_PANEL_PASSWORD_MASTER_KEY (or CHORDV_SECRET_ENCRYPTION_KEY). Refusing plaintext panel passwords in production."
      );
    }
    return null;
  }
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    const normalizedInput = raw.replace(/=+$/, "");
    if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === normalizedInput) {
      return decoded;
    }
  }
  if (production) {
    throw new Error(
      "Invalid panel password master key. Production requires exactly 32 bytes encoded as 64 hexadecimal characters or canonical Base64."
    );
  }
  return createHash("sha256").update(raw).digest();
}
export function isPanelPasswordMasterKeyConfigured() {
  return Boolean(
    process.env.CHORDV_PANEL_PASSWORD_MASTER_KEY?.trim() ||
      process.env.CHORDV_SECRET_ENCRYPTION_KEY?.trim()
  );
}

export function assertPanelPasswordCryptoReadyForProduction() {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (isEnabled(process.env.CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD)) {
    return;
  }
  if (!isPanelPasswordMasterKeyConfigured()) {
    throw new Error(
      "Missing CHORDV_PANEL_PASSWORD_MASTER_KEY (or CHORDV_SECRET_ENCRYPTION_KEY). Set a 32-byte hex/base64 key before starting production."
    );
  }
  // Force key material resolution so invalid formats fail at boot.
  resolveMasterKey();
}

export function isEncryptedPanelPassword(value: string | null | undefined) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith(PANEL_PASSWORD_PREFIX)) {
    return false;
  }
  // Full structure: enc:v1:v1:<nonce12>:<tag16>:<ciphertext> (base64url).
  // A plaintext that merely starts with "enc:v1:" must NOT be treated as ciphertext.
  const payload = trimmed.slice(PANEL_PASSWORD_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length !== 4) {
    return false;
  }
  const [version, nonceB64, tagB64, dataB64] = parts;
  if (version !== KEY_VERSION || !nonceB64 || !tagB64 || !dataB64) {
    return false;
  }
  try {
    const nonce = Buffer.from(nonceB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    if (nonce.length !== 12 || tag.length !== 16 || data.length < 1) {
      return false;
    }
    // Reject non-canonical base64url that decodes but re-encodes differently.
    if (
      nonce.toString("base64url") !== nonceB64 ||
      tag.toString("base64url") !== tagB64 ||
      data.toString("base64url") !== dataB64
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function canDecryptPanelPasswordWithCurrentKey(value: string) {
  try {
    const key = resolveMasterKey();
    if (!key) {
      return false;
    }
    const payload = value.trim().slice(PANEL_PASSWORD_PREFIX.length);
    const [version, nonceB64, tagB64, dataB64] = payload.split(":");
    if (version !== KEY_VERSION || !nonceB64 || !tagB64 || !dataB64) {
      return false;
    }
    const nonce = Buffer.from(nonceB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    Buffer.concat([decipher.update(data), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

export function encryptPanelPassword(plaintext: string | null | undefined): string | null {
  if (plaintext == null) {
    return null;
  }
  const value = plaintext.trim();
  if (!value) {
    return null;
  }
  // Only skip re-encryption when the value is valid ciphertext for the current key.
  // Structurally valid but unauthenticated payloads (or other-key ciphertexts) are treated as plaintext.
  if (isEncryptedPanelPassword(value) && canDecryptPanelPasswordWithCurrentKey(value)) {
    return value;
  }
  const key = resolveMasterKey();
  if (!key) {
    return value;
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PANEL_PASSWORD_PREFIX}${KEY_VERSION}:${nonce.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptPanelPassword(stored: string | null | undefined): string | null {
  if (stored == null) {
    return null;
  }
  const value = stored.trim();
  if (!value) {
    return null;
  }
  if (!isEncryptedPanelPassword(value)) {
    return value;
  }
  const key = resolveMasterKey();
  if (!key) {
    throw new Error("Encrypted panel password found but CHORDV_PANEL_PASSWORD_MASTER_KEY is not configured.");
  }
  const payload = value.slice(PANEL_PASSWORD_PREFIX.length);
  const [version, nonceB64, tagB64, dataB64] = payload.split(":");
  if (version !== KEY_VERSION || !nonceB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted panel password payload.");
  }
  const nonce = Buffer.from(nonceB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  return plaintext;
}

type PanelPasswordRow = { id: string; panelPassword: string | null };

type PanelPasswordPrisma = {
  node: {
    findMany: (args: any) => Promise<PanelPasswordRow[]>;
    update: (args: any) => Promise<unknown>;
  };
  panelSyncJob: {
    findMany: (args: any) => Promise<PanelPasswordRow[]>;
    update: (args: any) => Promise<unknown>;
  };
  $transaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

type PanelPasswordClassification = "empty" | "plaintext" | "ciphertext" | "corrupt-ciphertext";

function classifyPanelPassword(value: string | null | undefined): PanelPasswordClassification {
  const stored = value?.trim() || "";
  if (!stored) {
    return "empty";
  }
  if (!isEncryptedPanelPassword(stored)) {
    return "plaintext";
  }
  // Structure looks encrypted; only trust it when the current master key can authenticate it.
  if (canDecryptPanelPasswordWithCurrentKey(stored)) {
    return "ciphertext";
  }
  return "corrupt-ciphertext";
}

function isPlaintextPanelPassword(value: string | null | undefined) {
  return classifyPanelPassword(value) === "plaintext";
}

function isCorruptEncryptedPanelPassword(value: string | null | undefined) {
  return classifyPanelPassword(value) === "corrupt-ciphertext";
}

async function collectPanelPasswordRows(prisma: PanelPasswordPrisma) {
  const [nodes, panelSyncJobs] = await Promise.all([
    prisma.node.findMany({
      where: { panelPassword: { not: null } },
      select: { id: true, panelPassword: true }
    }),
    prisma.panelSyncJob.findMany({
      where: { panelPassword: { not: null } },
      select: { id: true, panelPassword: true }
    })
  ]);
  return { nodes, panelSyncJobs };
}

async function collectPlaintextRows(prisma: PanelPasswordPrisma) {
  const rows = await collectPanelPasswordRows(prisma);
  return {
    nodes: rows.nodes.filter((row) => isPlaintextPanelPassword(row.panelPassword)),
    panelSyncJobs: rows.panelSyncJobs.filter((row) => isPlaintextPanelPassword(row.panelPassword))
  };
}

async function collectCorruptEncryptedRows(prisma: PanelPasswordPrisma) {
  const rows = await collectPanelPasswordRows(prisma);
  return {
    nodes: rows.nodes.filter((row) => isCorruptEncryptedPanelPassword(row.panelPassword)),
    panelSyncJobs: rows.panelSyncJobs.filter((row) => isCorruptEncryptedPanelPassword(row.panelPassword))
  };
}

export async function countPlaintextPanelPasswords(prisma: PanelPasswordPrisma) {
  const rows = await collectPlaintextRows(prisma);
  return {
    nodes: rows.nodes.length,
    panelSyncJobs: rows.panelSyncJobs.length,
    total: rows.nodes.length + rows.panelSyncJobs.length
  };
}

export async function countCorruptEncryptedPanelPasswords(prisma: PanelPasswordPrisma) {
  const rows = await collectCorruptEncryptedRows(prisma);
  return {
    nodes: rows.nodes.length,
    panelSyncJobs: rows.panelSyncJobs.length,
    total: rows.nodes.length + rows.panelSyncJobs.length
  };
}

export async function backfillPlaintextPanelPasswords(prisma: PanelPasswordPrisma) {
  if (!isPanelPasswordMasterKeyConfigured()) {
    return {
      nodes: 0,
      panelSyncJobs: 0,
      remainingNodes: 0,
      remainingPanelSyncJobs: 0,
      remaining: 0,
      skipped: true as const
    };
  }

  const corrupt = await collectCorruptEncryptedRows(prisma);
  if (corrupt.nodes.length > 0 || corrupt.panelSyncJobs.length > 0) {
    throw new Error(
      `Corrupt encrypted panel passwords present (structure ok, GCM auth failed): nodes=${corrupt.nodes.map((r) => r.id).join(",") || 0}, panelSyncJobs=${corrupt.panelSyncJobs.map((r) => r.id).join(",") || 0}`
    );
  }

  const plaintext = await collectPlaintextRows(prisma);
  if (plaintext.nodes.length === 0 && plaintext.panelSyncJobs.length === 0) {
    return {
      nodes: 0,
      panelSyncJobs: 0,
      remainingNodes: 0,
      remainingPanelSyncJobs: 0,
      remaining: 0,
      skipped: false as const
    };
  }

  const applyUpdates = async (tx: PanelPasswordPrisma) => {
    let nodesUpdated = 0;
    let jobsUpdated = 0;
    for (const row of plaintext.nodes) {
      const stored = row.panelPassword?.trim() || "";
      const encrypted = encryptPanelPassword(stored);
      if (!encrypted || encrypted === stored) {
        throw new Error(`Failed to encrypt plaintext panel password for node ${row.id}.`);
      }
      await tx.node.update({
        where: { id: row.id },
        data: { panelPassword: encrypted }
      });
      nodesUpdated += 1;
    }
    for (const row of plaintext.panelSyncJobs) {
      const stored = row.panelPassword?.trim() || "";
      const encrypted = encryptPanelPassword(stored);
      if (!encrypted || encrypted === stored) {
        throw new Error(`Failed to encrypt plaintext panel password for panelSyncJob ${row.id}.`);
      }
      await tx.panelSyncJob.update({
        where: { id: row.id },
        data: { panelPassword: encrypted }
      });
      jobsUpdated += 1;
    }
    return { nodesUpdated, jobsUpdated };
  };

  const result =
    typeof prisma.$transaction === "function"
      ? await prisma.$transaction((tx) => applyUpdates(tx))
      : await applyUpdates(prisma);

  const remaining = await countPlaintextPanelPasswords(prisma);
  if (remaining.total > 0) {
    throw new Error(
      `Panel password backfill left plaintext residues: nodes=${remaining.nodes}, panelSyncJobs=${remaining.panelSyncJobs}`
    );
  }

  return {
    nodes: result.nodesUpdated,
    panelSyncJobs: result.jobsUpdated,
    remainingNodes: 0,
    remainingPanelSyncJobs: 0,
    remaining: 0,
    skipped: false as const
  };
}

export async function assertNoPlaintextPanelPasswordsInProduction(prisma: PanelPasswordPrisma) {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (isEnabled(process.env.CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD)) {
    return;
  }
  if (!isPanelPasswordMasterKeyConfigured()) {
    throw new Error(
      "Missing CHORDV_PANEL_PASSWORD_MASTER_KEY (or CHORDV_SECRET_ENCRYPTION_KEY). Set a 32-byte hex/base64 key before starting production."
    );
  }
  const remaining = await countPlaintextPanelPasswords(prisma);
  if (remaining.total > 0) {
    throw new Error(
      `Refusing to start with plaintext panel passwords still present: nodes=${remaining.nodes}, panelSyncJobs=${remaining.panelSyncJobs}`
    );
  }
  const corrupt = await countCorruptEncryptedPanelPasswords(prisma);
  if (corrupt.total > 0) {
    throw new Error(
      `Refusing to start with corrupt encrypted panel passwords that fail authentication under the current master key: nodes=${corrupt.nodes}, panelSyncJobs=${corrupt.panelSyncJobs}`
    );
  }
}
