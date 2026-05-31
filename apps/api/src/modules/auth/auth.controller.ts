import { Body, Controller, Headers, Ip, Post, Res } from "@nestjs/common";
import { IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";
import type { Response } from "express";
import { AuthService } from "./auth.service";

class LoginDto {
  @IsString()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @MinLength(8)
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
    setRefreshCookie(response, session.refreshToken);
    return session;
  }

  @Post("refresh")
  async refresh(
    @Body() body: RefreshDto,
    @Headers("cookie") cookieHeader?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    const refreshToken = body.refreshToken?.trim() || readCookie(cookieHeader, ADMIN_REFRESH_COOKIE_NAME);
    const session = await this.authService.refresh(refreshToken);
    setRefreshCookie(response, session.refreshToken);
    return session;
  }

  @Post("logout")
  logout(@Headers("authorization") authorization?: string, @Res({ passthrough: true }) response?: Response) {
    clearRefreshCookie(response);
    return this.authService.logout(authorization);
  }
}

const ADMIN_REFRESH_COOKIE_NAME = "chordv_admin_refresh";

function normalizeClientIp(ip: string | undefined) {
  return ip?.trim() || "unknown";
}

function setRefreshCookie(response: Response | undefined, refreshToken: string) {
  response?.setHeader("Set-Cookie", buildRefreshCookie(encodeURIComponent(refreshToken), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)));
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
