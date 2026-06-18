import type { AdminLeaseRevocationJobDto, AdminPanelSyncJobDto } from "@chordv/shared";

export type PanelSyncQueueFilter = {
  title?: string;
  nodeId?: string;
  subscriptionId?: string;
  userId?: string;
  teamId?: string;
};

export function hasPanelSyncQueueFilter(filter?: PanelSyncQueueFilter | null) {
  return Boolean(filter?.nodeId || filter?.subscriptionId || filter?.userId || filter?.teamId);
}

export function filterPanelSyncJobs(jobs: AdminPanelSyncJobDto[], filter?: PanelSyncQueueFilter | null) {
  if (!hasPanelSyncQueueFilter(filter)) {
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
    if (filter?.teamId && job.teamId !== filter.teamId) {
      return false;
    }
    return true;
  });
}

export function filterLeaseRevocationJobs(jobs: AdminLeaseRevocationJobDto[], filter?: PanelSyncQueueFilter | null) {
  if (!hasPanelSyncQueueFilter(filter)) {
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
