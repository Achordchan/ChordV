import type { AdminLeaseRevocationJobDto, AdminNodeCommandJobDto } from "@chordv/shared";

export type LeaseRevocationQueueFilter = {
  title?: string;
  nodeId?: string;
  subscriptionId?: string;
  userId?: string;
  teamId?: string;
};

// Lease jobs expose no teamId column, so a team-only filter deliberately means
// "do not narrow" for THEM. Command jobs DO carry teamId, and the server-side
// detail fetch keys off this predicate — a team-only view must count as
// filtered there or it would silently show the global command list.
export function hasLeaseRevocationQueueFilter(filter?: LeaseRevocationQueueFilter | null) {
  return Boolean(filter?.nodeId || filter?.subscriptionId || filter?.userId);
}

export function hasNodeCommandQueueFilter(filter?: LeaseRevocationQueueFilter | null) {
  return Boolean(filter?.nodeId || filter?.subscriptionId || filter?.userId || filter?.teamId);
}

export function filterLeaseRevocationJobs(jobs: AdminLeaseRevocationJobDto[], filter?: LeaseRevocationQueueFilter | null) {
  if (!hasLeaseRevocationQueueFilter(filter)) {
    return jobs;
  }
  return jobs.filter((job) => {
    if (filter?.nodeId && job.nodeId !== filter.nodeId) {
      return false;
    }
    if (filter?.subscriptionId && job.subscriptionId !== filter.subscriptionId) {
      return false;
    }
    if (filter?.userId && job.userId !== filter.userId) {
      return false;
    }
    return true;
  });
}

// Direct provisioning (ENSURE/DISABLE/REMOVE_USER) lives in NodeCommandJob, so
// a pending subscription/user must filter THAT list — the lease queue can only
// ever show connection revocations.
export function filterNodeCommandJobs(jobs: AdminNodeCommandJobDto[], filter?: LeaseRevocationQueueFilter | null) {
  if (!hasLeaseRevocationQueueFilter(filter)) {
    return jobs;
  }
  return jobs.filter((job) => {
    if (filter?.nodeId && job.nodeId !== filter.nodeId) {
      return false;
    }
    if (filter?.subscriptionId && job.subscriptionId !== filter.subscriptionId) {
      return false;
    }
    if (filter?.userId && job.userId !== filter.userId) {
      return false;
    }
    return true;
  });
}
