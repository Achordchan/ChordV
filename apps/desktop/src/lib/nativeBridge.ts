import { DesktopService, events } from "./mygo";

export type NativeInvoke = <T = unknown>(command: string, payload?: unknown) => Promise<T>;
export type NativeEvent<T> = { payload: T };
export type NativeUnlisten = () => void;

type NativeHost = {
  platform: string;
  call: (...args: unknown[]) => Promise<unknown>;
  on: <T>(name: string, handler: (payload: T) => void) => NativeUnlisten;
};

function nativeHost(): NativeHost | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { mygo?: NativeHost }).mygo;
}

export function isNativeDesktop() {
  return typeof nativeHost()?.call === "function";
}

export function nativePlatform(): "macos" | "windows" | "linux" | "web" {
  if (!isNativeDesktop()) return "web";
  const platform = nativeHost()?.platform;
  if (platform === "macos" || platform === "darwin") return "macos";
  if (platform === "windows" || platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "web";
}

export async function invokeNative<T = unknown>(command: string, payload?: unknown): Promise<T> {
  if (!isNativeDesktop()) throw new Error("此操作需要在 MyGo 客户端中运行。");
  return await DesktopService.invoke(command, payload ?? {}) as T;
}

export async function listenNative<T>(name: string, handler: (event: NativeEvent<T>) => void): Promise<NativeUnlisten> {
  if (!isNativeDesktop()) return () => {};
  return events.nativeEvent.on((event) => {
    if (event.name === name) handler({ payload: event.payload as T });
  });
}

export async function onNativeFocusChanged(handler: (active: boolean) => void): Promise<NativeUnlisten> {
  const host = nativeHost();
  if (!isNativeDesktop() || !host) return () => {};
  return host.on<boolean>("mygo:window-active", handler);
}
