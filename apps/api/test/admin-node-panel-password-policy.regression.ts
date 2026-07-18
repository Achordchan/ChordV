import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { AdminNodeService } from "../src/modules/common/admin-node.service";
import { encryptPanelPassword } from "../src/modules/common/panel-password-crypto";

async function main() {
  const previousKey = process.env.CHORDV_PANEL_PASSWORD_MASTER_KEY;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  process.env.CHORDV_PANEL_PASSWORD_MASTER_KEY = "a".repeat(64);
  try {
    const encryptedPassword = encryptPanelPassword("old-secret");
    assert.ok(encryptedPassword);
    const xuiCalls: Array<Record<string, unknown>> = [];
    const service = Object.assign(Object.create(AdminNodeService.prototype), {
      prisma: {
        node: {
          findUnique: async () => ({
            panelBaseUrl: "https://panel.example.com",
            panelApiBasePath: "/api",
            panelUsername: "admin",
            panelPassword: encryptedPassword
          })
        }
      },
      xuiService: {
        listInbounds: async (input: Record<string, unknown>) => {
          xuiCalls.push(input);
          return [];
        }
      },
      logger: {
        warn: () => undefined
      }
    }) as AdminNodeService;

    await service.listNodePanelInbounds({
      panelBaseUrl: "https://panel.example.com",
      panelApiBasePath: "/api",
      panelUsername: "admin",
      nodeId: "node_1"
    });
    assert.equal(xuiCalls.length, 1);
    assert.equal(xuiCalls[0]?.panelPassword, "old-secret");

    await assert.rejects(
      () =>
        service.listNodePanelInbounds({
          panelBaseUrl: "https://other-panel.example.com",
          panelApiBasePath: "/api",
          panelUsername: "admin",
          nodeId: "node_1"
        }),
      (error) => error instanceof BadRequestException && /重新输入面板密码/.test(error.message)
    );
    assert.equal(xuiCalls.length, 1, "changed panel identity must be rejected before the remote request");
    console.log("admin-node-panel-password-policy.regression.ts passed");
  } finally {
    if (previousKey === undefined) delete process.env.CHORDV_PANEL_PASSWORD_MASTER_KEY;
    else process.env.CHORDV_PANEL_PASSWORD_MASTER_KEY = previousKey;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});