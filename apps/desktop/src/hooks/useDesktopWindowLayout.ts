import { useCallback, useEffect, useState } from "react";
import { cancelDesktopWindowResize, resizeDesktopWindow } from "../lib/desktopWindowLayout";
import { resolveWindowPresentation } from "../lib/windowPresentation";

export function useDesktopWindowLayout(signedIn: boolean, booting: boolean, onError: (message: string) => void) {
  const [settled, setSettled] = useState<boolean | null>(null);
  const prepareStartupLayout = useCallback(async (restored: boolean) => {
    await resizeDesktopWindow(restored, false);
    setSettled(restored);
  }, []);

  useEffect(() => {
    // Startup already sizes the window before releasing the loading surface.
    if (booting || settled === signedIn) return;
    let active = true;
    const frame = window.requestAnimationFrame(() => {
      if (!active) return;
      void resizeDesktopWindow(signedIn, true).then(() => {
        if (active) setSettled(signedIn);
      }).catch(() => {
        if (active) onError("窗口尺寸调整失败，请重新打开客户端。");
      });
    });
    return () => { active = false; window.cancelAnimationFrame(frame); cancelDesktopWindowResize(); };
  }, [signedIn, booting, settled, onError]);
  return { ...resolveWindowPresentation(signedIn, booting, settled), prepareStartupLayout };
}
