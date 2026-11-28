import { useEffect, useRef, type RefObject } from "react";
import { isNativeDesktop } from "../lib/nativeBridge";
import { appReady } from "../lib/nativeShell";

type Options = {
  root: RefObject<HTMLElement | null>;
  ready: boolean;
  screen: "login" | "main";
  onFailure: () => void;
};

function hasInteractiveSurface(root: HTMLElement, screen: Options["screen"]) {
  const surface = root.querySelector<HTMLElement>(screen === "login" ? ".auth-screen form" : ".desktop-main");
  if (!root.isConnected || !surface) return false;
  const bounds = surface.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  if (screen === "login" && (!surface.querySelector('input[aria-label="邮箱"]') || !surface.querySelector('input[aria-label="密码"]'))) return false;
  return [...surface.querySelectorAll<HTMLElement>("button, input, select, textarea")].some(control => {
    if (control.matches(":disabled") || control.getAttribute("aria-disabled") === "true") return false;
    const rect = control.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const hit = root.ownerDocument.elementFromPoint(x, y);
    return hit !== null && control.contains(hit);
  });
}

export function useAppReadiness({ root, ready, screen, onFailure }: Options) {
  const attempted = useRef(false);
  const failure = useRef(onFailure);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  failure.current = onFailure;
  useEffect(() => {
    if (!ready || attempted.current || !isNativeDesktop() || !root.current) return;
    const element = root.current;
    let active = true;
    const check = () => {
      if (!active || attempted.current || !hasInteractiveSurface(element, screen)) return;
      attempted.current = true;
      observer.disconnect();
      resize.disconnect();
      void appReady({ screen }).then(result => {
        if (!result.ok) throw new Error("本地启动确认失败");
      }).catch(() => { if (mounted.current) failure.current(); });
    };
    const observer = new MutationObserver(check);
    const resize = new ResizeObserver(check);
    observer.observe(element.ownerDocument.body, { subtree: true, childList: true, attributes: true });
    resize.observe(element);
    // Effect runs after React commits. Layout/hit testing excludes loading-only
    // roots and covered controls without depending on foreground animation frames.
    queueMicrotask(check);
    return () => { active = false; observer.disconnect(); resize.disconnect(); };
  }, [ready, root, screen]);
}
