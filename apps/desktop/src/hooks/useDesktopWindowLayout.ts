import { useCallback, useEffect, useReducer, useState } from "react";
import { cancelDesktopWindowResize, resizeDesktopWindow } from "../lib/desktopWindowLayout";
import { initialWindowLayoutState, reduceWindowLayout, resolveWindowPresentation } from "../lib/windowPresentation";

export function useDesktopWindowLayout(signedIn: boolean, booting: boolean) {
  const [layout, dispatch] = useReducer(reduceWindowLayout, initialWindowLayoutState);
  const [retryRevision, setRetryRevision] = useState(0);
  const prepareStartupLayout = useCallback(async (restored: boolean) => {
    await resizeDesktopWindow(restored, false);
    dispatch({ type: "success", signedIn: restored });
  }, []);
  const retryWindowLayout = useCallback(() => setRetryRevision((value) => value + 1), []);

  useEffect(() => {
    if (booting) return;
    if (layout.settled === signedIn) {
      dispatch({ type: "success", signedIn });
      return;
    }
    let active = true;
    dispatch({ type: "start" });
    const frame = window.requestAnimationFrame(() => {
      if (!active) return;
      void resizeDesktopWindow(signedIn, true).then(() => {
        if (active) dispatch({ type: "success", signedIn });
      }).catch(() => {
        if (active) dispatch({ type: "failure" });
      });
    });
    return () => { active = false; window.cancelAnimationFrame(frame); cancelDesktopWindowResize(); };
  }, [signedIn, booting, layout.settled, retryRevision]);
  return {
    ...resolveWindowPresentation(signedIn, booting, layout.settled), prepareStartupLayout,
    windowLayoutError: layout.error, windowResizeBusy: layout.busy, retryWindowLayout
  };
}
