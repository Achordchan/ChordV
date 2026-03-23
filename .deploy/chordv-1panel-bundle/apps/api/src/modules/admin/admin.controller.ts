import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { ResetSubscriptionTrafficInputDto } from "@chordv/shared";
import { diskStorage } from "multer";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { DevDataService } from "../common/dev-data.service";
import { RuntimeComponentsService } from "../common/runtime-components.service";
import {
  ChangeSubscriptionPlanDto,
  CreateAnnouncementDto,
  CreatePlanDto,
  CreateReleaseArtifactDto,
  CreateReleaseDto,
  CreateRuntimeComponentDto,
  CreateSubscriptionDto,
  CreateTeamDto,
  CreateTeamMemberDto,
  CreateTeamSubscriptionDto,
  CreateUserDto,
  ImportNodeDto,
  KickTeamMemberDto,
  ReadNodePanelInboundsDto,
  RenewSubscriptionDto,
  UploadReleaseArtifactDto,
  UpdateReleaseArtifactDto,
  UpdateReleaseDto,
  UpdateAnnouncementDto,
  UpdateNodeDto,
  UpdatePlanDto,
  UpdatePlanSecurityDto,
  UpdatePolicyDto,
  UpdateRuntimeComponentDto,
  UpdateSubscriptionDto,
  UpdateSubscriptionNodeAccessDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
  UpdateUserSecurityDto,
  UpdateUserDto
} from "./admin.dto";

type UploadedReleaseFile = {
  path: string;
  originalname: string;
  size: number;
};

type MulterCallback = (error: Error | null, filename: string) => void;
const RELEASE_ARTIFACT_MAX_UPLOAD_BYTES = Number(process.env.CHORDV_RELEASE_MAX_UPLOAD_BYTES ?? 1024 * 1024 * 1024);

@Controller("admin")
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(
    private readonly devDataService: DevDataService,
    private readonly runtimeComponentsService: RuntimeComponentsService
  ) {}

  @Get("snapshot")
  getSnapshot() {
    return this.devDataService.getAdminSnapshot();
  }

  @Get("users")
  getUsers() {
    return this.devDataService.listAdminUsers();
  }

  @Post("users")
  createUser(@Body() body: CreateUserDto) {
    return this.devDataService.createUser(body);
  }

  @Patch("users/:userId")
  updateUser(@Param("userId") userId: string, @Body() body: UpdateUserDto) {
    return this.devDataService.updateUser(userId, body);
  }

  @Put("users/:userId/security")
  updateUserSecurity(@Param("userId") userId: string, @Body() body: UpdateUserSecurityDto) {
    return this.devDataService.updateUserSecurity(userId, body);
  }

  @Get("plans")
  getPlans() {
    return this.devDataService.listAdminPlans();
  }

  @Post("plans")
  createPlan(@Body() body: CreatePlanDto) {
    return this.devDataService.createPlan(body);
  }

  @Patch("plans/:planId")
  updatePlan(@Param("planId") planId: string, @Body() body: UpdatePlanDto) {
    return this.devDataService.updatePlan(planId, body);
  }

  @Put("plans/:planId/security")
  updatePlanSecurity(@Param("planId") planId: string, @Body() body: UpdatePlanSecurityDto) {
    return this.devDataService.updatePlanSecurity(planId, body);
  }

  @Get("subscriptions")
  getSubscriptions() {
    return this.devDataService.listAdminSubscriptions();
  }

  @Post("subscriptions")
  createSubscription(@Body() body: CreateSubscriptionDto) {
    return this.devDataService.createSubscription(body);
  }

  @Post("subscriptions/:subscriptionId/renew")
  renewSubscription(@Param("subscriptionId") subscriptionId: string, @Body() body: RenewSubscriptionDto) {
    return this.devDataService.renewSubscription(subscriptionId, body);
  }

  @Post("subscriptions/:subscriptionId/change-plan")
  changeSubscriptionPlan(@Param("subscriptionId") subscriptionId: string, @Body() body: ChangeSubscriptionPlanDto) {
    return this.devDataService.changeSubscriptionPlan(subscriptionId, body);
  }

  @Patch("subscriptions/:subscriptionId")
  updateSubscription(@Param("subscriptionId") subscriptionId: string, @Body() body: UpdateSubscriptionDto) {
    return this.devDataService.updateSubscription(subscriptionId, body);
  }

  @Get("subscriptions/:subscriptionId/nodes")
  getSubscriptionNodes(@Param("subscriptionId") subscriptionId: string) {
    return this.devDataService.getSubscriptionNodeAccess(subscriptionId);
  }

  @Put("subscriptions/:subscriptionId/nodes")
  updateSubscriptionNodes(@Param("subscriptionId") subscriptionId: string, @Body() body: UpdateSubscriptionNodeAccessDto) {
    return this.devDataService.updateSubscriptionNodeAccess(subscriptionId, body);
  }

  @Post("subscriptions/:subscriptionId/reset-traffic")
  resetSubscriptionTraffic(@Param("subscriptionId") subscriptionId: string, @Body() body: ResetSubscriptionTrafficInputDto) {
    return this.devDataService.resetSubscriptionTraffic(subscriptionId, body ?? {});
  }

  @Get("teams")
  getTeams() {
    return this.devDataService.listAdminTeams();
  }

  @Post("teams")
  createTeam(@Body() body: CreateTeamDto) {
    return this.devDataService.createTeam(body);
  }

  @Patch("teams/:teamId")
  updateTeam(@Param("teamId") teamId: string, @Body() body: UpdateTeamDto) {
    return this.devDataService.updateTeam(teamId, body);
  }

  @Post("teams/:teamId/members")
  createTeamMember(@Param("teamId") teamId: string, @Body() body: CreateTeamMemberDto) {
    return this.devDataService.createTeamMember(teamId, body);
  }

  @Patch("teams/:teamId/members/:memberId")
  updateTeamMember(@Param("memberId") memberId: string, @Body() body: UpdateTeamMemberDto) {
    return this.devDataService.updateTeamMember(memberId, body);
  }

  @Delete("teams/:teamId/members/:memberId")
  deleteTeamMember(@Param("memberId") memberId: string) {
    return this.devDataService.deleteTeamMember(memberId);
  }

  @Post("teams/:teamId/members/:memberId/kick")
  kickTeamMember(@Param("teamId") teamId: string, @Param("memberId") memberId: string, @Body() body: KickTeamMemberDto) {
    return this.devDataService.kickTeamMember(teamId, memberId, body);
  }

  @Post("teams/:teamId/subscriptions")
  createTeamSubscription(@Param("teamId") teamId: string, @Body() body: CreateTeamSubscriptionDto) {
    return this.devDataService.createTeamSubscription(teamId, body);
  }

  @Get("teams/:teamId/usage")
  getTeamUsage(@Param("teamId") teamId: string) {
    return this.devDataService.getTeamUsage(teamId);
  }

  @Get("nodes")
  getNodes() {
    return this.devDataService.listAdminNodes();
  }

  @Post("nodes/import")
  importNode(@Body() body: ImportNodeDto) {
    return this.devDataService.importNodeFromSubscription(body);
  }

  @Post("nodes/panel-inbounds")
  listNodePanelInbounds(@Body() body: ReadNodePanelInboundsDto) {
    return this.devDataService.listNodePanelInbounds(body);
  }

  @Patch("nodes/:nodeId")
  updateNode(@Param("nodeId") nodeId: string, @Body() body: UpdateNodeDto) {
    return this.devDataService.updateNode(nodeId, body);
  }

  @Post("nodes/:nodeId/refresh")
  refreshNode(@Param("nodeId") nodeId: string) {
    return this.devDataService.refreshNode(nodeId);
  }

  @Post("nodes/:nodeId/probe")
  probeNode(@Param("nodeId") nodeId: string) {
    return this.devDataService.probeNode(nodeId);
  }

  @Post("nodes/probe-all")
  probeAllNodes() {
    return this.devDataService.probeAllNodes();
  }

  @Delete("nodes/:nodeId")
  deleteNode(@Param("nodeId") nodeId: string) {
    return this.devDataService.deleteNode(nodeId);
  }

  @Get("announcements")
  getAnnouncements() {
    return this.devDataService.listAdminAnnouncements();
  }

  @Post("announcements")
  createAnnouncement(@Body() body: CreateAnnouncementDto) {
    return this.devDataService.createAnnouncement(body);
  }

  @Patch("announcements/:announcementId")
  updateAnnouncement(@Param("announcementId") announcementId: string, @Body() body: UpdateAnnouncementDto) {
    return this.devDataService.updateAnnouncement(announcementId, body);
  }

  @Get("policies")
  getPolicies() {
    return this.devDataService.getAdminPolicy();
  }

  @Patch("policies")
  updatePolicy(@Body() body: UpdatePolicyDto) {
    return this.devDataService.updatePolicy(body);
  }

  @Get("releases")
  getReleases() {
    return this.devDataService.listAdminReleases();
  }

  @Get("runtime-components")
  getRuntimeComponents() {
    return this.runtimeComponentsService.listAdminRuntimeComponents();
  }

  @Get("runtime-components/failures")
  getRuntimeComponentFailures(@Query("limit") limit?: string) {
    return this.runtimeComponentsService.listRuntimeComponentFailureReports(limit ? Number(limit) : undefined);
  }

  @Post("runtime-components")
  createRuntimeComponent(@Body() body: CreateRuntimeComponentDto) {
    return this.runtimeComponentsService.createAdminRuntimeComponent(body);
  }

  @Patch("runtime-components/:componentId")
  updateRuntimeComponent(@Param("componentId") componentId: string, @Body() body: UpdateRuntimeComponentDto) {
    return this.runtimeComponentsService.updateAdminRuntimeComponent(componentId, body);
  }

  @Delete("runtime-components/:componentId")
  deleteRuntimeComponent(@Param("componentId") componentId: string) {
    return this.runtimeComponentsService.deleteAdminRuntimeComponent(componentId);
  }

  @Post("runtime-components/:componentId/verify")
  verifyRuntimeComponent(@Param("componentId") componentId: string) {
    return this.runtimeComponentsService.validateAdminRuntimeComponent(componentId);
  }

  @Post("releases")
  createRelease(@Body() body: CreateReleaseDto) {
    return this.devDataService.createRelease(body);
  }

  @Patch("releases/:releaseId")
  updateRelease(@Param("releaseId") releaseId: string, @Body() body: UpdateReleaseDto) {
    return this.devDataService.updateRelease(releaseId, body);
  }

  @Post("releases/:releaseId/publish")
  publishRelease(@Param("releaseId") releaseId: string) {
    return this.devDataService.publishRelease(releaseId);
  }

  @Post("releases/:releaseId/archive")
  archiveRelease(@Param("releaseId") releaseId: string) {
    return this.devDataService.archiveRelease(releaseId);
  }

  @Post("releases/:releaseId/artifacts")
  createReleaseArtifact(@Param("releaseId") releaseId: string, @Body() body: CreateReleaseArtifactDto) {
    return this.devDataService.createReleaseArtifact(releaseId, body);
  }

  @Post("releases/:releaseId/artifacts/upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req: unknown, file: { originalname: string }, callback: MulterCallback) => {
          callback(null, `${randomUUID()}${path.extname(file.originalname || "")}`);
        }
      }),
      limits: {
        fileSize: RELEASE_ARTIFACT_MAX_UPLOAD_BYTES
      }
    })
  )
  uploadReleaseArtifact(
    @Param("releaseId") releaseId: string,
    @Body() body: UploadReleaseArtifactDto,
    @UploadedFile() file?: UploadedReleaseFile
  ) {
    return this.devDataService.uploadReleaseArtifact(releaseId, body, file);
  }

  @Patch("releases/:releaseId/artifacts/:artifactId")
  updateReleaseArtifact(
    @Param("releaseId") releaseId: string,
    @Param("artifactId") artifactId: string,
    @Body() body: UpdateReleaseArtifactDto
  ) {
    return this.devDataService.updateReleaseArtifact(releaseId, artifactId, body);
  }

  @Delete("releases/:releaseId/artifacts/:artifactId")
  deleteReleaseArtifact(@Param("releaseId") releaseId: string, @Param("artifactId") artifactId: string) {
    return this.devDataService.deleteReleaseArtifact(releaseId, artifactId);
  }

  @Post("releases/:releaseId/artifacts/:artifactId/verify")
  verifyReleaseArtifact(@Param("releaseId") releaseId: string, @Param("artifactId") artifactId: string) {
    return this.devDataService.validateReleaseArtifact(releaseId, artifactId);
  }

  @Post("releases/:releaseId/artifacts/:artifactId/upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req: unknown, file: { originalname: string }, callback: MulterCallback) => {
          callback(null, `${randomUUID()}${path.extname(file.originalname || "")}`);
        }
      }),
      limits: {
        fileSize: RELEASE_ARTIFACT_MAX_UPLOAD_BYTES
      }
    })
  )
  replaceReleaseArtifactUpload(
    @Param("releaseId") releaseId: string,
    @Param("artifactId") artifactId: string,
    @Body() body: UploadReleaseArtifactDto,
    @UploadedFile() file?: UploadedReleaseFile
  ) {
    return this.devDataService.replaceReleaseArtifactUpload(releaseId, artifactId, body, file);
  }
}
