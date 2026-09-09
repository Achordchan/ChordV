import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { UpdateDownloadMirrorConfigDto } from "../src/modules/admin/admin.dto";
import { SystemUpdateService } from "../src/modules/common/system-update.service";
import type { DownloadMirrorService, EffectiveDownloadMirrorConfig } from "../src/modules/common/download-mirror.service";

const root = path.resolve(__dirname, "../../..");

// ---------------------------------------------------------------------------
// One prefix serves two consumers with opposite needs: desktop clients fetching
// runtime components across the network the mirror works around, and the backend
// fetching its own release archives. Turning it off for the server must NOT take
// it away from clients.
// ---------------------------------------------------------------------------
function serviceWith(config: Partial<EffectiveDownloadMirrorConfig>) {
  const mirror = {
    getEffectiveConfig: async (): Promise<EffectiveDownloadMirrorConfig> => ({
      defaultMirrorPrefix: "https://ghfast.top/",
      allowClientMirror: true,
      useMirrorForSystemUpdate: true,
      updatedAt: null,
      ...config
    })
  } as unknown as DownloadMirrorService;
  const instance = new SystemUpdateService({} as never, mirror);
  return instance as unknown as { resolveMirrorPrefix(): Promise<string | null> };
}

// The client-facing candidate builder must keep reading the prefix itself, never
// this flag — otherwise disabling the server hop would silently strip the mirror
// from every client download too.
const componentsSource = readFileSync(
  path.join(root, "apps/api/src/modules/common/runtime-components.service.ts"),
  "utf8"
);
assert.doesNotMatch(
  componentsSource,
  /useMirrorForSystemUpdate/,
  "runtime component delivery must be independent of the server's own update path"
);
assert.match(
  componentsSource,
  /const defaultMirrorPrefix = isRemoteHttp \? globalMirror\.defaultMirrorPrefix : null;/,
  "clients must keep receiving the configured mirror prefix"
);

async function main() {
  assert.equal(
    await serviceWith({ useMirrorForSystemUpdate: true }).resolveMirrorPrefix(),
    "https://ghfast.top/",
    "the server must still use the mirror while the flag is on"
  );
  assert.equal(
    await serviceWith({ useMirrorForSystemUpdate: false }).resolveMirrorPrefix(),
    null,
    "the server must fetch its own updates direct once the flag is off"
  );
  assert.equal(
    await serviceWith({ useMirrorForSystemUpdate: false, defaultMirrorPrefix: null }).resolveMirrorPrefix(),
    null,
    "no prefix configured is still no prefix"
  );

  // Absent in storage means "written before this flag existed": keep the old
  // behaviour rather than silently moving a server that may not reach the origin.
  const { DownloadMirrorService: Ctor } = await import("../src/modules/common/download-mirror.service");
  const legacy = new Ctor({
    systemSetting: {
      findUnique: async () => ({
        value: { defaultMirrorPrefix: "https://ghfast.top/", allowClientMirror: false },
        updatedAt: new Date(0)
      })
    }
  } as never);
  const effective = await legacy.getEffectiveConfig();
  assert.equal(
    effective.useMirrorForSystemUpdate,
    true,
    "a config stored before the flag existed must keep routing self-updates through the mirror"
  );
  assert.equal(effective.allowClientMirror, false, "unrelated stored fields must survive the upgrade");

  // The admin input must accept the flag; an unvalidated field would be dropped
  // silently by the global whitelisting pipe and the switch would never save.
  const accepted = plainToInstance(UpdateDownloadMirrorConfigDto, { useMirrorForSystemUpdate: false });
  assert.deepEqual(validateSync(accepted), [], "the flag must be accepted by the admin DTO");
  assert.equal(accepted.useMirrorForSystemUpdate, false);
  const coerced = plainToInstance(UpdateDownloadMirrorConfigDto, { useMirrorForSystemUpdate: "false" });
  assert.deepEqual(validateSync(coerced), [], "form-encoded booleans must still validate");
  const rejected = plainToInstance(UpdateDownloadMirrorConfigDto, { useMirrorForSystemUpdate: "maybe" });
  assert.equal(validateSync(rejected).length, 1, "a non-boolean must be rejected, not coerced");
}

main().then(
  () => console.log("system-update-mirror-opt-out.regression.ts passed"),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
