import type {
  AdminNodeCommandSummariesDto,
  AdminNodeCommandSummaryDto,
  AdminNodeCommandSummaryEntryDto
} from "@chordv/shared";

export type NodeCommandSummaryScope = keyof AdminNodeCommandSummariesDto;

export function findNodeCommandSummary(
  summaries: AdminNodeCommandSummariesDto | null | undefined,
  scope: NodeCommandSummaryScope,
  key?: string | null
): AdminNodeCommandSummaryDto | null {
  if (!summaries || !key) {
    return null;
  }
  const entry = summaries[scope].find((item: AdminNodeCommandSummaryEntryDto) => item.key === key);
  return entry && entry.total > 0 ? entry : null;
}

export function sumNodeCommandSummaries(summaries: AdminNodeCommandSummariesDto | null | undefined, scope: NodeCommandSummaryScope) {
  if (!summaries) {
    return 0;
  }
  return summaries[scope].reduce((total, entry) => total + entry.total, 0);
}
