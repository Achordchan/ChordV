import { Body, Controller, ForbiddenException, Headers, Ip, Post, Res } from "@nestjs/common";
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import type { Response } from "express";
import { AuthService } from "./auth.service";

class LoginDto {
  @IsString()
  @IsEmail()
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

const ADMIN_REFRESH_COOKIE_NAME = "chordv_admin_refresh";

function normalizeClientIp(ip: string | undefined) {
  return ip?.trim() || "unknown";
}

function setRefreshCookie(response: Response | undefined, refreshToken: string, refreshTokenExpiresAt: string) {
  response?.setHeader("Set-Cookie", buildRefreshCookie(encodeURIComponent(refreshToken), new Date(refreshTokenExpiresAt)));
}

function clearRefreshCookie(response: Response | undefined) {
  response?.setHeader("Set-Cookie", buildRefreshCookie("", new Date(0)));
}

function buildRefreshCookie(value: string, expires: Date) {
  const secure = process.env.NODE_ENV === "production" || (process.env.CHORDV_AUTH_COOKIE_SECURE ?? "false").toLowerCase() === "true";
  const sameSite = process.env.CHORDV_AUTH_COOKIE_SAMESITE ?? "Lax";
  return [
    `${ADMIN_REFRESH_COOKIE_NAME}=${value}`,
    "Path=/api/auth",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Expires=${expires.toUTCString()}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function readCookie(cookieHeader: string | undefined, name: string) {
  const pair = cookieHeader
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  if (!pair) {
    return "";
  }
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return "";
  }
}
