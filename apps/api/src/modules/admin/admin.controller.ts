import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { DevDataService } from "../common/dev-data.service";
import {
  ChangeSubscriptionPlanDto,
  CreateAnnouncementDto,
  CreatePlanDto,
  CreateSubscriptionDto,
  CreateTeamDto,
  CreateTeamMemberDto,
  CreateTeamSubscriptionDto,
  CreateUserDto,
  ImportNodeDto,
  RenewSubscriptionDto,
  UpdateAnnouncementDto,
  UpdateNodeDto,
  UpdatePlanDto,
  UpdatePlanSecurityDto,
  UpdatePolicyDto,
  UpdateSubscriptionDto,
  UpdateSubscriptionNodeAccessDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
  UpdateUserSecurityDto,
  UpdateUserDto
} from "./admin.dto";

@Controller("admin")
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(private readonly devDataService: DevDataService) {}

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
}
