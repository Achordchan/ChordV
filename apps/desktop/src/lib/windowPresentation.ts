/** Authentication alone does not prove the native window is ready for the dashboard. */
export function resolveWindowPresentation(signedIn: boolean, booting: boolean, settled: boolean | null) {
  return {
    mainLayoutReady: !booting && signedIn && settled === true,
    windowTransitioning: booting || settled !== signedIn
  };
}

export type WindowLayoutState = { settled: boolean | null; busy: boolean; error: string | null };
export const initialWindowLayoutState: WindowLayoutState = { settled: null, busy: false, error: null };
export type WindowLayoutEvent = { type: "start" } | { type: "success"; signedIn: boolean } | { type: "failure" };

export function reduceWindowLayout(state: WindowLayoutState, event: WindowLayoutEvent): WindowLayoutState {
  if (event.type === "start") return { ...state, busy: true, error: null };
  if (event.type === "success") {
    if (state.settled === event.signedIn && !state.busy && !state.error) return state;
    return { settled: event.signedIn, busy: false, error: null };
  }
  return { ...state, busy: false, error: "窗口尺寸调整未完成，请重试。" };
}
