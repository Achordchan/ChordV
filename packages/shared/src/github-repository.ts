export function isGitHubReleaseRepository(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) && !/\/\.{1,2}$/.test(value);
}
