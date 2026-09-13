import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { ClientRoutingRuleService } from "../common/client-routing-rule.service";

@Controller("admin/users")
@UseGuards(AdminAuthGuard)
export class UserRoutingRulesController {
  constructor(private readonly rules: ClientRoutingRuleService) {}

  @Get(":userId/routing-rules")
  list(@Param("userId") userId: string) {
    return this.rules.listRulesForUserId(userId);
  }
}
