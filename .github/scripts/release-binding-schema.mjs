export function canonicalPublicRepository(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value ?? "") || value.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid tag binding public repository");
  return value.toLowerCase();
}
export function assertBindingDeclaration(manifest, repository) {
  const binding = manifest.tagBinding;
  if (manifest.schemaVersion === 1 && (binding === undefined || binding && binding.mode === "source-commit")) return false;
  if (manifest.schemaVersion !== 2 || !binding || binding.mode !== "signed-manifest-tree") throw new Error("Release schema and tag binding mode mismatch");
  if (typeof binding.repository !== "string" || binding.repository !== canonicalPublicRepository(binding.repository)
      || repository !== undefined && binding.repository !== canonicalPublicRepository(repository)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceCommit ?? "")) throw new Error("Signed tag binding repository/source identity mismatch");
  return true;
}
