import type { AuthSessionDto, ClientRuntimeEventDto } from "@chordv/shared";
import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  isAccessTokenExpiredApiError,
  probeClientServerLatency,
  subscribeClientEvents as subscribeClientEventsRequest
} from "../api/client";

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

function createReachableServerProbeState(elapsedMs: number | null): ServerProbeState {
  return {
    status: elapsedMs !== null && elapsedMs >= 200 ? "slow" : "healthy",
    elapsedMs,
    checkedAt: Date.now(),
    errorMessage: null
  };
}

export type UseClientEventsOptions = {
  session: AuthSessionDto | null;
  setServerProbe: Dispatch<SetStateAction<ServerProbeState>>;
  handleRuntimeEvent: (event: ClientRuntimeEventDto, accessToken: string) => Promise<void> | void;
  recoverSessionAfterUnauthorized: () => Promise<AuthSessionDto | null> | AuthSessionDto | null;
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
    isUnauthorizedError = isAccessTokenExpiredApiError
  } = options;
  const handleRuntimeEventRef = useRef(handleRuntimeEvent);
  const recoverSessionAfterUnauthorizedRef = useRef(recoverSessionAfterUnauthorized);
  const readErrorRef = useRef(readError);
  const isUnauthorizedErrorRef = useRef(isUnauthorizedError);
  const setServerProbeRef = useRef(setServerProbe);
  const probeFallbackBusyRef = useRef(false);
  const openedOnceRef = useRef(false);

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
      openedOnceRef.current = false;
      return;
    }

    const verifyServerReachability = async (reason: unknown) => {
      if (probeFallbackBusyRef.current) {
        return;
      }
      probeFallbackBusyRef.current = true;
      try {
        const result = await probeClientServerLatency();
        setServerProbeRef.current(createReachableServerProbeState(result.elapsedMs));
      } catch (probeReason) {
        setServerProbeRef.current(createFailedServerProbeState(readErrorRef.current, probeReason ?? reason));
      } finally {
        probeFallbackBusyRef.current = false;
      }
    };

    return subscribeClientEvents(session.accessToken, {
      onEvent: (event) => {
        void handleRuntimeEventRef.current(event, session.accessToken);
      },
      onOpen: (meta) => {
        openedOnceRef.current = true;
        setServerProbeRef.current(createOpenedServerProbeState(meta.elapsedMs));
      },
      onError: (error, meta) => {
        if (meta.status === 401 || meta.authError || isUnauthorizedErrorRef.current(error)) {
          void recoverSessionAfterUnauthorizedRef.current();
          return;
        }
        if (!openedOnceRef.current) {
          setServerProbeRef.current((current) => ({
            status: "checking",
            elapsedMs: current.elapsedMs,
            checkedAt: current.checkedAt,
            errorMessage: null
          }));
        }
        void verifyServerReachability(error);
      }
    });
  }, [session?.accessToken, subscribeClientEvents]);
}
