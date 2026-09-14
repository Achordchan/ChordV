/** Only a missing route indicates an older backend; authentication and network
 * failures must remain visible instead of changing the management surface. */
export function isRuntimeVersionUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const body = JSON.parse(error.message);
    return (body.statusCode ?? body.status) === 404;
  } catch {
    return false;
  }
}
