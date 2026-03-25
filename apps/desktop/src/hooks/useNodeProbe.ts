import { useCallback, useMemo, useState } from "react";
import type { NodeSummaryDto } from "@chordv/shared";
import { fetchNodeProbes, isUnauthorizedApiError } from "../api/client";
import type { RuntimeNodeProbeResult } from "../lib/runtime";

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
  loadLastNodeId?: () => string | null;
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
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeCooldownUntil, setProbeCooldownUntil] = useState(0);
  const [probeResults, setProbeResults] = useState<Record<string, RuntimeNodeProbeResult>>({});

  const probeCooldownLeft = useMemo(
    () => Math.max(0, Math.ceil((probeCooldownUntil - (options.nowMs ?? Date.now())) / 1000)),
    [options.nowMs, probeCooldownUntil]
  );

  const runProbe = useCallback(
    async (targetNodes: NodeSummaryDto[], auto: boolean, accessTokenOverride?: string | null) => {
      const accessToken = accessTokenOverride ?? options.accessToken ?? null;
      if (probeBusy || targetNodes.length === 0 || !accessToken) {
        return null;
      }

      try {
        setProbeBusy(true);
        const result = await fetchNodeProbes(
          accessToken,
          targetNodes.map((node) => node.id)
        );
        const nextResults = Object.fromEntries(result.map((item) => [item.nodeId, item]));
        setProbeResults(nextResults);
        setProbeCooldownUntil(Date.now() + (options.probeCooldownMs ?? 25_000));

        const saved = options.loadLastNodeId?.() ?? null;
        const currentSelectedId = options.selectedNodeId ?? null;
        const preferredNodeId =
          currentSelectedId && nextResults[currentSelectedId]?.status === "healthy"
            ? currentSelectedId
            : options.pickNodeId?.(targetNodes, saved, nextResults) ?? currentSelectedId ?? targetNodes[0]?.id ?? null;
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
        if (isUnauthorizedApiError(reason)) {
          await options.onUnauthorized?.();
          return null;
        }
        if (!auto) {
          options.onError?.(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "测速失败");
        }
        return null;
      } finally {
        setProbeBusy(false);
      }
    },
    [options, probeBusy]
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
