import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeSummaryDto } from "@chordv/shared";
import { reportNodeProbes, isUnauthorizedApiError } from "../api/client";
import { probeLocalNodes, type RuntimeNodeProbeResult } from "../lib/runtime";

export type NodeProbeGuidance = {
  code: "node_unavailable";
  tone: "warning";
  title: string;
  message: string;
  actionLabel: string;
  recommendedNodeId: string | null;
};

type UseNodeProbeOptions = {
  accessToken: string | null;
  nowMs?: number;
  probeCooldownMs?: number;
  selectedNodeId?: string | null;
  readError?: (message: string) => string;
  onUnauthorized?: () => Promise<unknown> | unknown;
  onError?: (message: string) => void;
  pickNodeId?: (
    nodes: NodeSummaryDto[],
    preferredId: string | null,
    results: Record<string, RuntimeNodeProbeResult>
  ) => string | null;
  pickAlternativeNodeId?: (
    nodes: NodeSummaryDto[],
    currentNodeId: string | null,
    results: Record<string, RuntimeNodeProbeResult>
  ) => string | null;
  onSelectedNodeIdChange?: (nodeId: string | null) => void;
  onGuidance?: (guidance: NodeProbeGuidance, auto: boolean) => void;
};

function defaultReadError(message: string) {
  return message;
}

export function useNodeProbe(options: UseNodeProbeOptions) {
  const generation = useRef(0);
  const busy = useRef(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeCooldownUntil, setProbeCooldownUntil] = useState(0);
  const [probeResults, setProbeResults] = useState<Record<string, RuntimeNodeProbeResult>>({});

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setProbeBusy(false);
    setProbeResults({});
    return () => { generation.current += 1; };
  }, [options.accessToken]);

  const probeCooldownLeft = useMemo(
    () => Math.max(0, Math.ceil((probeCooldownUntil - (options.nowMs ?? Date.now())) / 1000)),
    [options.nowMs, probeCooldownUntil]
  );

  const runProbe = useCallback(
    async (targetNodes: NodeSummaryDto[], auto: boolean, accessTokenOverride?: string | null) => {
      const accessToken = accessTokenOverride ?? options.accessToken ?? null;
      if (busy.current || targetNodes.length === 0 || !accessToken) {
        return null;
      }

      const requestGeneration = generation.current;
      try {
        busy.current = true;
        setProbeBusy(true);
        const result: RuntimeNodeProbeResult[] = [];
        for (let offset = 0; offset < targetNodes.length; offset += 32) {
          const batch = await probeLocalNodes(targetNodes.slice(offset, offset + 32));
          if (requestGeneration !== generation.current) return null;
          result.push(...batch);
          void reportNodeProbes(accessToken, batch).catch(() => undefined);
        }
        const nextResults = Object.fromEntries(result.map((item) => [item.nodeId, item]));
        setProbeResults(nextResults);
        setProbeCooldownUntil(Date.now() + (options.probeCooldownMs ?? 25_000));

        const currentSelectedId = options.selectedNodeId ?? null;
        const preferredNodeId =
          currentSelectedId && nextResults[currentSelectedId]?.status === "healthy"
            ? currentSelectedId
            : options.pickNodeId?.(targetNodes, null, nextResults) ?? currentSelectedId ?? targetNodes[0]?.id ?? null;
        options.onSelectedNodeIdChange?.(preferredNodeId);

        const offlineNodeId = options.selectedNodeId ?? currentSelectedId ?? null;
        if (offlineNodeId && nextResults[offlineNodeId]?.status === "offline") {
          const recommendedNodeId =
            options.pickAlternativeNodeId?.(targetNodes, offlineNodeId, nextResults) ?? null;
          options.onGuidance?.(
            {
              code: "node_unavailable",
              tone: "warning",
              title: "节点暂不可用",
              message: "当前节点测速失败，请切换其他可用节点后重新连接。",
              actionLabel: "切换节点后重连",
              recommendedNodeId
            },
            auto
          );
        }

        return nextResults;
      } catch (reason) {
        if (requestGeneration !== generation.current) return null;
        if (isUnauthorizedApiError(reason)) {
          await options.onUnauthorized?.();
          return null;
        }
        if (!auto) {
          options.onError?.(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "测速失败");
        }
        return null;
      } finally {
        if (requestGeneration === generation.current) { busy.current = false; setProbeBusy(false); }
      }
    },
    [options]
  );

  return {
    probeBusy,
    probeCooldownUntil,
    probeCooldownLeft,
    probeResults,
    setProbeResults,
    runProbe
  };
}
