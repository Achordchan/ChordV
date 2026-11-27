import { Controller, Delete, Get, Param, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import type { AdminDeletableEntityKind } from "@chordv/shared";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { AdminDeletionService } from "../common/admin-deletion.service";
import { SubscriptionLinkKickInterceptor } from "../common/subscription-link-kick.interceptor";

type AuthedRequest = { authUser?: { id?: string } };

function readForce(value: unknown) {
  return value === "1" || value === "true";
}

/**
 * 删除用户、套餐、订阅、团队。先 GET delete-preview 看会一起删掉什么；
 * 有关联数据时 DELETE 必须带 ?force=1。
 */
@Controller("admin")
@UseGuards(AdminAuthGuard)
// 删除会改变订阅链接的内容（或让链接失效），立即触发一次分发对账。
@UseInterceptors(SubscriptionLinkKickInterceptor)
export class AdminDeletionController {
  constructor(private readonly deletion: AdminDeletionService) {}

  private preview(kind: AdminDeletableEntityKind, id: string, request: AuthedRequest) {
    return this.deletion.preview(kind, id, request.authUser?.id ?? null);
  }

  private remove(kind: AdminDeletableEntityKind, id: string, force: unknown, request: AuthedRequest) {
    return this.deletion.delete(kind, id, { force: readForce(force), actorUserId: request.authUser?.id ?? null });
  }

  @Get("users/:id/delete-preview")
  previewUser(@Param("id") id: string, @Req() request: AuthedRequest) {
    return this.preview("user", id, request);
  }

  @Delete("users/:id")
  deleteUser(@Param("id") id: string, @Query("force") force: unknown, @Req() request: AuthedRequest) {
    return this.remove("user", id, force, request);
  }

  @Get("plans/:id/delete-preview")
  previewPlan(@Param("id") id: string, @Req() request: AuthedRequest) {
    return this.preview("plan", id, request);
  }

  @Delete("plans/:id")
  deletePlan(@Param("id") id: string, @Query("force") force: unknown, @Req() request: AuthedRequest) {
    return this.remove("plan", id, force, request);
  }

  @Get("subscriptions/:id/delete-preview")
  previewSubscription(@Param("id") id: string, @Req() request: AuthedRequest) {
    return this.preview("subscription", id, request);
  }

  @Delete("subscriptions/:id")
  deleteSubscription(@Param("id") id: string, @Query("force") force: unknown, @Req() request: AuthedRequest) {
    return this.remove("subscription", id, force, request);
  }

  @Get("teams/:id/delete-preview")
  previewTeam(@Param("id") id: string, @Req() request: AuthedRequest) {
    return this.preview("team", id, request);
  }

  @Delete("teams/:id")
  deleteTeam(@Param("id") id: string, @Query("force") force: unknown, @Req() request: AuthedRequest) {
    return this.remove("team", id, force, request);
  }
}
