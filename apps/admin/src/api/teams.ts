import type {
  AdminSubscriptionRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageRecordDto,
  CreateTeamInputDto,
  CreateTeamMemberInputDto,
  CreateTeamSubscriptionInputDto,
  KickTeamMemberInputDto,
  KickTeamMemberResultDto,
  UpdateTeamInputDto,
  UpdateTeamMemberInputDto
} from "@chordv/shared";
import { request } from "./base";

export function createTeam(input: CreateTeamInputDto) {
  return request<AdminTeamRecordDto>("/admin/teams", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateTeam(teamId: string, input: UpdateTeamInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function createTeamMember(teamId: string, input: CreateTeamMemberInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateTeamMember(teamId: string, memberId: string, input: UpdateTeamMemberInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteTeamMember(teamId: string, memberId: string) {
  return request<{ ok: boolean }>(`/admin/teams/${teamId}/members/${memberId}`, {
    method: "DELETE"
  });
}

export function kickTeamMember(teamId: string, memberId: string, input: KickTeamMemberInputDto) {
  return request<KickTeamMemberResultDto>(`/admin/teams/${teamId}/members/${memberId}/kick`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createTeamSubscription(teamId: string, input: CreateTeamSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/teams/${teamId}/subscriptions`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getTeamUsage(teamId: string) {
  return request<AdminTeamUsageRecordDto[]>(`/admin/teams/${teamId}/usage`);
}
