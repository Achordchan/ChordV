/** Authentication alone does not prove the native window is ready for the dashboard. */
export function resolveWindowPresentation(signedIn: boolean, booting: boolean, settled: boolean | null) {
  return {
    mainLayoutReady: !booting && signedIn && settled === true,
    windowTransitioning: booting || settled !== signedIn
  };
}
