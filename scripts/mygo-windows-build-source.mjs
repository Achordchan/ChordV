import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

export async function prepareWindowsBuildSource(projectRoot, configDir) {
  const source = path.join(configDir, "source");
  // Preserve the desktop module's relative replace of packages/release-protocol.
  const native = path.join(source, "apps/desktop/native");
  await mkdir(path.dirname(native), { recursive: true });
  await cp(path.join(projectRoot, "apps/desktop/native"), native, {
    recursive: true,
    filter: file => path.basename(file) !== ".mygo-build-config" && !/^mygo_windows_.*\.syso$/.test(path.basename(file))
  });
  const protocol = path.join(source, "packages/release-protocol");
  await mkdir(path.dirname(protocol), { recursive: true });
  await cp(path.join(projectRoot, "packages/release-protocol"), protocol, { recursive: true });
  return native;
}
