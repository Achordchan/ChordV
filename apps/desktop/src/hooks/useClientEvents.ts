import type { AuthSessionDto, ClientRuntimeEventDto } from "@chordv/shared";
import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { isUnauthorizedApiError, subscribeClientEvents as subscribeClientEventsRequest } from "../api/client";

export type ServerProbeState = {
  status: "idle" | "checking" | "healthy" | "slow" | "failed";
  elapsedMs: number | null;
  checkedAt: number | null;
  errorMessage: string | null;
};

export function createIdleServerProbeState(): ServerProbeState {
  return {
    status: "idle",
    elapsedMs: null,
    checkedAt: null,
    errorMessage: null
  };
}

export function applyServerProbeKeepalive(current: ServerProbeState): ServerProbeState {
  return {
    status: current.status === "idle" || current.status === "checking" ? "healthy" : current.status,
    elapsedMs: current.elapsedMs,
    checkedAt: Date.now(),
    errorMessage: null
  };
}

function createOpenedServerProbeState(elapsedMs: number | null): ServerProbeState {
  return {
    status: elapsedMs !== null && elapsedMs >= 200 ? "slow" : "healthy",
    elapsedMs,
    checkedAt: Date.now(),
    errorMessage: null
  };
}

function createFailedServerProbeState(readError: (message: string) => string, reason: unknown): ServerProbeState {
  return {
    status: "failed",
    elapsedMs: null,
    checkedAt: Date.now(),
    errorMessage: reason instanceof Error ? readError(reason.message) : "当前无法连接服务端"
  };
}

export type UseClientEventsOptions = {
  session: AuthSessionDto | null;
  setServerProbe: Dispatch<SetStateAction<ServerProbeState>>;
  handleRuntimeEvent: (event: ClientRuntimeEventDto, accessToken: string) => Promise<void> | void;
  recoverSessionAfterUnauthorized: () => Promise<boolean> | boolean;
  readError: (message: string) => string;
  subscribeClientEvents?: typeof subscribeClientEventsRequest;
  isUnauthorizedError?: (reason: unknown) => boolean;
};

export function useClientEvents(options: UseClientEventsOptions) {
  const {
    session,
    setServerProbe,
    handleRuntimeEvent,
    recoverSessionAfterUnauthorized,
    readError,
    subscribeClientEvents = subscribeClientEventsRequest,
    isUnauthorizedError = isUnauthorizedApiError
  } = options;
  const handleRuntimeEventRef = useRef(handleRuntimeEvent);
  const recoverSessionAfterUnauthorizedRef = useRef(recoverSessionAfterUnauthorized);
  const readErrorRef = useRef(readError);
  const isUnauthorizedErrorRef = useRef(isUnauthorizedError);
  const setServerProbeRef = useRef(setServerProbe);

  useEffect(() => {
    handleRuntimeEventRef.current = handleRuntimeEvent;
  }, [handleRuntimeEvent]);

  useEffect(() => {
    recoverSessionAfterUnauthorizedRef.current = recoverSessionAfterUnauthorized;
  }, [recoverSessionAfterUnauthorized]);

  useEffect(() => {
    readErrorRef.current = readError;
  }, [readError]);

  useEffect(() => {
    isUnauthorizedErrorRef.current = isUnauthorizedError;
  }, [isUnauthorizedError]);

  useEffect(() => {
    setServerProbeRef.current = setServerProbe;
  }, [setServerProbe]);

  useEffect(() => {
    if (!session?.accessToken) {
      return;
    }

    return subscribeClientEvents(session.accessToken, {
      onEvent: (event) => {
        void handleRuntimeEventRef.current(event, session.accessToken);
      },
      onOpen: (meta) => {
        setServerProbeRef.current(createOpenedServerProbeState(meta.elapsedMs));
      },
      onError: (error, meta) => {
        if (meta.authError || isUnauthorizedErrorRef.current(error)) {
          void recoverSessionAfterUnauthorizedRef.current();
          return;
        }
        setServerProbeRef.current(createFailedServerProbeState(readErrorRef.current, error));
      }
    });
  }, [session?.accessToken, subscribeClientEvents]);
}
