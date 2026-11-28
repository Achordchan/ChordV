import { invokeNative, isNativeDesktop } from "./nativeBridge";

export function isAndroidPlatform() {
  return /android/i.test(window.navigator.userAgent);
}

export async function loadInvoke() {
  return isNativeDesktop() ? invokeNative : null;
}
