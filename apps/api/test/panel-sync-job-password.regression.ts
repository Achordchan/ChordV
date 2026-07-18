import assert from "node:assert/strict";
import { encryptPanelPassword, decryptPanelPassword, isEncryptedPanelPassword } from "../src/modules/common/panel-password-crypto";
import { createOrRefreshPanelSyncJob } from "../src/modules/common/panel-sync-job.utils";

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

async function testPanelSyncJobEncryptsPlaintextPasswordSnapshot() {
  await withEnv(
    {
      NODE_ENV: "test",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: "a".repeat(64),
      CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD: undefined
    },
    async () => {
      let created: any = null;
      let updated: any = null;
      const writer = {
        panelSyncJob: {
          updateMany: async (args: any) => {
            updated = args.data;
            return { count: 0 };
          },
          createMany: async (args: any) => {
            created = args.data;
            return { count: 1 };
          },
          findFirst: async () => null
        }
      };

      await createOrRefreshPanelSyncJob(writer, "delete:binding-1", {
        create: {
          id: "job-1",
          dedupeKey: "delete:binding-1",
          panelPassword: "plain-panel-secret"
        },
        update: {
          panelPassword: "plain-panel-secret"
        }
      });

      assert.ok(created, "job create payload should exist");
      assert.ok(isEncryptedPanelPassword(created.panelPassword), "create snapshot must be ciphertext");
      assert.equal(decryptPanelPassword(created.panelPassword), "plain-panel-secret");
      assert.ok(isEncryptedPanelPassword(updated.panelPassword), "update snapshot must be ciphertext");
      assert.equal(decryptPanelPassword(updated.panelPassword), "plain-panel-secret");
    }
  );
}

async function testPanelSyncJobKeepsAlreadyEncryptedPassword() {
  await withEnv(
    {
      NODE_ENV: "test",
      CHORDV_PANEL_PASSWORD_MASTER_KEY: "a".repeat(64)
    },
    async () => {
      const encrypted = encryptPanelPassword("already-secret");
      let created: any = null;
      const writer = {
        panelSyncJob: {
          updateMany: async () => ({ count: 0 }),
          createMany: async (args: any) => {
            created = args.data;
            return { count: 1 };
          },
          findFirst: async () => null
        }
      };
      await createOrRefreshPanelSyncJob(writer, "ensure:binding-1", {
        create: { id: "job-2", dedupeKey: "ensure:binding-1", panelPassword: encrypted },
        update: { panelPassword: encrypted }
      });
      assert.equal(created.panelPassword, encrypted);
    }
  );
}

async function main() {
  await testPanelSyncJobEncryptsPlaintextPasswordSnapshot();
  await testPanelSyncJobKeepsAlreadyEncryptedPassword();
  console.log("panel-sync-job-password.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
