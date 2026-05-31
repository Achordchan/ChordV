import * as fs from "node:fs/promises";

type MoveUploadedFileOps = Pick<typeof fs, "rename" | "copyFile" | "unlink" | "rm">;

export async function moveUploadedFile(
  sourcePath: string,
  targetPath: string,
  ops: MoveUploadedFileOps = fs
) {
  try {
    await ops.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error;
    }
  }

  await ops.copyFile(sourcePath, targetPath);
  try {
    await ops.unlink(sourcePath);
  } catch (error) {
    await ops.rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isCrossDeviceRenameError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV";
}
