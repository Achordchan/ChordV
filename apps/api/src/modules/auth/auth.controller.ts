import { Body, Controller, ForbiddenException, Headers, Ip, Post, Res } from "@nestjs/common";
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { ADMIN_REFRESH_COOKIE_NAME, clearRefreshCookie, readCookie, setRefreshCookie } from "./auth-cookie";

class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;
}

class RefreshDto {
  @IsString()
  @IsOptional()
  refreshToken?: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  async login(
    @Body() body: LoginDto,
    @Ip() ip?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    const session = await this.authService.login(body.email, body.password, normalizeClientIp(ip));
    setRefreshCookie(response, session.refreshToken, session.refreshTokenExpiresAt);
    return session;
  }

  @Post("admin/login")
  async adminLogin(
    @Body() body: LoginDto,
    @Ip() ip?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    const session = await this.authService.login(body.email, body.password, normalizeClientIp(ip));
    if (session.user.role !== "admin") {
      await this.authService.logout(undefined, session.refreshToken).catch(() => undefined);
      clearRefreshCookie(response);
      throw new ForbiddenException("Current account does not have admin permission.");
    }
    setRefreshCookie(response, session.refreshToken, session.refreshTokenExpiresAt);
    return session;
  }

  @Post("refresh")
  async refresh(
    @Body() body: RefreshDto | undefined,
    @Headers("cookie") cookieHeader?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    const refreshToken = body?.refreshToken?.trim() || readCookie(cookieHeader, ADMIN_REFRESH_COOKIE_NAME);
    const session = await this.authService.refresh(refreshToken);
    setRefreshCookie(response, session.refreshToken, session.refreshTokenExpiresAt);
    return session;
  }

  @Post("logout")
  logout(
    @Body() body: RefreshDto | undefined,
    @Headers("authorization") authorization?: string,
    @Headers("cookie") cookieHeader?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    clearRefreshCookie(response);
    const refreshToken = body?.refreshToken?.trim() || readCookie(cookieHeader, ADMIN_REFRESH_COOKIE_NAME);
    return this.authService.logout(authorization, refreshToken);
  }
}

function normalizeClientIp(ip: string | undefined) {
  return ip?.trim() || "unknown";
}
