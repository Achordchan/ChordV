import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { AuthSessionService } from "./auth-session.service";

@Injectable()
export class ClientAuthGuard implements CanActivate {
  constructor(private readonly authSessionService: AuthSessionService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string }; authUser?: unknown }>();
    const user = await this.authSessionService.authenticateAccessToken(request.headers.authorization);
    request.authUser = user;
    return true;
  }
}
