import type { AuthSessionDto } from "@chordv/shared";
import type { NativeSessionRefreshEvent } from "./runtime";

/** A native refresh belongs to the login whose refresh token it replaced. */
export function canApplyNativeSessionRefresh(current: AuthSessionDto | null, event: NativeSessionRefreshEvent) {
  return Boolean(current && current.user.id === event.user.id &&
    (current.refreshToken === event.previousRefreshToken || current.accessToken === event.accessToken));
}
