import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { AuthSessionService } from "./auth-session.service";

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly authSessionService: AuthSessionService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string }; authUser?: { role?: string } }>();
    const user = await this.authSessionService.authenticateAccessToken(request.headers.authorization);
    if (user.role !== "admin") {
      throw new ForbiddenException("需要管理员权限");
    }
    request.authUser = user;
    return true;
  }
}
