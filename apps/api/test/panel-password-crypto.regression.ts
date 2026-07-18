import assert from "node:assert/strict";
import {
  assertNoPlaintextPanelPasswordsInProduction,
  assertPanelPasswordCryptoReadyForProduction,
  backfillPlaintextPanelPasswords,
  countCorruptEncryptedPanelPasswords,
  countPlaintextPanelPasswords,
  decryptPanelPassword,
  encryptPanelPassword,
  isEncryptedPanelPassword,
  isPanelPasswordMasterKeyConfigured
} from "../src/modules/common/panel-password-crypto";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withEnvAsync(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}



function testStructurallyValidButUnauthenticatedPayloadIsReencrypted() {
  withEnv(
    {
      NODE_ENV: "test",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: "a".repeat(64),
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    () => {
      const nonce = Buffer.alloc(12, 1).toString("base64url");
      const tag = Buffer.alloc(16, 2).toString("base64url");
      const data = Buffer.alloc(8, 3).toString("base64url");
      const fake = `enc:v1:v1:${nonce}:${tag}:${data}`;
      assert.equal(isEncryptedPanelPassword(fake), true, "structure-only check still recognizes shape");
      const encrypted = encryptPanelPassword(fake);
      assert.ok(encrypted);
      assert.notEqual(encrypted, fake, "unauthenticated payload must be re-encrypted as plaintext");
      assert.equal(decryptPanelPassword(encrypted), fake);
    }
  );
}

function testLiteralPrefixIsNotTreatedAsCiphertext() {
  withEnv(
    {
      NODE_ENV: "test",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: "a".repeat(64),
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    () => {
      const literal = "enc:v1:literal-password";
      assert.equal(isEncryptedPanelPassword(literal), false);
      const encrypted = encryptPanelPassword(literal);
      assert.ok(encrypted);
      assert.notEqual(encrypted, literal);
      assert.equal(isEncryptedPanelPassword(encrypted), true);
      assert.equal(decryptPanelPassword(encrypted), literal);
    }
  );
}

function testEncryptDecryptRoundTrip() {
  withEnv(
    {
      NODE_ENV: "test",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: "a".repeat(64),
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    () => {
      const encrypted = encryptPanelPassword("s3cret-password");
      assert.ok(encrypted);
      assert.equal(isEncryptedPanelPassword(encrypted), true);
      assert.equal(decryptPanelPassword(encrypted), "s3cret-password");
      assert.equal(encryptPanelPassword(encrypted), encrypted, "encrypt must be idempotent for ciphertext");
      assert.equal(isPanelPasswordMasterKeyConfigured(), true);
    }
  );
}

function testMissingKeyReturnsPlaintextOutsideProduction() {
  withEnv(
    {
      NODE_ENV: "development",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: undefined,
      CHORDV_SECRET_ENCRYPTION_KEY: undefined,
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    () => {
      assert.equal(encryptPanelPassword("plain"), "plain");
      assert.equal(decryptPanelPassword("plain"), "plain");
      assert.equal(isPanelPasswordMasterKeyConfigured(), false);
    }
  );
}

function testProductionRequiresMasterKey() {
  withEnv(
    {
      NODE_ENV: "production",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: undefined,
      CHORDV_SECRET_ENCRYPTION_KEY: undefined,
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    () => {
      assert.throws(() => assertPanelPasswordCryptoReadyForProduction(), /CHORDV_PANEL_PASSWORD_MASTER_KEY/);
      assert.throws(() => encryptPanelPassword("plain"), /CHORDV_PANEL_PASSWORD_MASTER_KEY/);
    }
  );
}

async function testBackfillIsTransactionalAndRejectsResidues() {
  await withEnvAsync(
    {
      NODE_ENV: "test",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: "a".repeat(64)
    },
    async () => {
      const nodeStore = new Map<string, string | null>([
        ["node_1", "plain-1"],
        ["node_2", "plain-2"]
      ]);
      const jobStore = new Map<string, string | null>([["job_1", "plain-job"]]);
      const prisma = {
        node: {
          findMany: async () => [...nodeStore.entries()].map(([id, panelPassword]) => ({ id, panelPassword })),
          update: async ({ where, data }: any) => {
            nodeStore.set(where.id, data.panelPassword);
            return {};
          }
        },
        panelSyncJob: {
          findMany: async () => [...jobStore.entries()].map(([id, panelPassword]) => ({ id, panelPassword })),
          update: async ({ where, data }: any) => {
            jobStore.set(where.id, data.panelPassword);
            return {};
          }
        },
        $transaction: async (fn: any) => {
          const nodeClone = new Map(nodeStore);
          const jobClone = new Map(jobStore);
          const tx = {
            node: {
              findMany: async () => [...nodeClone.entries()].map(([id, panelPassword]) => ({ id, panelPassword })),
              update: async ({ where, data }: any) => {
                if (where.id === "node_2") {
                  throw new Error("simulated node update failure");
                }
                nodeClone.set(where.id, data.panelPassword);
                return {};
              }
            },
            panelSyncJob: {
              findMany: async () => [...jobClone.entries()].map(([id, panelPassword]) => ({ id, panelPassword })),
              update: async ({ where, data }: any) => {
                jobClone.set(where.id, data.panelPassword);
                return {};
              }
            }
          };
          const result = await fn(tx);
          nodeStore.clear();
          for (const [key, value] of nodeClone) nodeStore.set(key, value);
          jobStore.clear();
          for (const [key, value] of jobClone) jobStore.set(key, value);
          return result;
        }
      };

      await assert.rejects(() => backfillPlaintextPanelPasswords(prisma as any), /simulated node update failure/i);
      assert.equal(nodeStore.get("node_1"), "plain-1", "failed backfill must not leave mixed ciphertext");
      assert.equal(nodeStore.get("node_2"), "plain-2");
      assert.equal(jobStore.get("job_1"), "plain-job");
      const remaining = await countPlaintextPanelPasswords(prisma as any);
      assert.equal(remaining.total, 3);
    }
  );
}


async function testProductionRejectsCorruptEncryptedPasswords() {
  await withEnvAsync(
    {
      NODE_ENV: "production",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: "a".repeat(64),
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    async () => {
      const nonce = Buffer.alloc(12, 1).toString("base64url");
      const tag = Buffer.alloc(16, 2).toString("base64url");
      const data = Buffer.alloc(8, 3).toString("base64url");
      const fake = `enc:v1:v1:${nonce}:${tag}:${data}`;
      const prisma = {
        node: {
          findMany: async () => [{ id: "node_bad", panelPassword: fake }],
          update: async () => ({})
        },
        panelSyncJob: {
          findMany: async () => [],
          update: async () => ({})
        }
      };
      const plaintext = await countPlaintextPanelPasswords(prisma as any);
      assert.equal(plaintext.total, 0, "corrupt ciphertext must not be counted as plaintext");
      const corrupt = await countCorruptEncryptedPanelPasswords(prisma as any);
      assert.equal(corrupt.total, 1);
      await assert.rejects(
        () => assertNoPlaintextPanelPasswordsInProduction(prisma as any),
        /corrupt encrypted panel passwords/i
      );
    }
  );
}

async function testProductionRejectsRemainingPlaintext() {
  await withEnvAsync(
    {
      NODE_ENV: "production",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: "a".repeat(64),
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    async () => {
      const prisma = {
        node: {
          findMany: async () => [{ id: "node_1", panelPassword: "still-plain" }],
          update: async () => ({})
        },
        panelSyncJob: {
          findMany: async () => [],
          update: async () => ({})
        }
      };
      await assert.rejects(
        () => assertNoPlaintextPanelPasswordsInProduction(prisma as any),
        /plaintext panel passwords still present/
      );
    }
  );
}

function testProductionRejectsShortOrMalformedMasterKeys() {
  for (const key of ["a", "short-password", "not-valid-base64!!!"]) {
    withEnv(
      {
        NODE_ENV: "production",
        CHORDV_PANEL_PASSWORD_MASTER_KEY: key,
        CHORDV_SECRET_ENCRYPTION_KEY: undefined,
        CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
      },
      () => {
        assert.throws(() => assertPanelPasswordCryptoReadyForProduction(), /Invalid panel password master key/);
        assert.throws(() => encryptPanelPassword("plain"), /Invalid panel password master key/);
      }
    );
  }
}

function testProductionAcceptsCanonicalBase64MasterKey() {
  withEnv(
    {
      NODE_ENV: "production",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      CHORDV_SECRET_ENCRYPTION_KEY: undefined,
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    () => {
      assert.doesNotThrow(() => assertPanelPasswordCryptoReadyForProduction());
      const encrypted = encryptPanelPassword("plain");
      assert.ok(encrypted);
      assert.equal(decryptPanelPassword(encrypted), "plain");
    }
  );
}
async function main() {
  testStructurallyValidButUnauthenticatedPayloadIsReencrypted();
  testLiteralPrefixIsNotTreatedAsCiphertext();
  testEncryptDecryptRoundTrip();
  testMissingKeyReturnsPlaintextOutsideProduction();
  testProductionRequiresMasterKey();
  testProductionRejectsShortOrMalformedMasterKeys();
  testProductionAcceptsCanonicalBase64MasterKey();
  await testBackfillIsTransactionalAndRejectsResidues();
  await testProductionRejectsCorruptEncryptedPasswords();
  await testProductionRejectsRemainingPlaintext();
  console.log("panel-password-crypto.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
