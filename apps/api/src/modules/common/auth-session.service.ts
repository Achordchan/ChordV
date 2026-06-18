import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as jwt from "jsonwebtoken";
import type { AuthSessionDto, UserProfileDto } from "@chordv/shared";
import { throwLocalReadAsServiceUnavailable, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import { PrismaService } from "./prisma.service";

type AccessPayload = {
  sub: string;
  email: string;
  role: "user" | "admin";
  ver: number;
  sid: string;
};

type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  lastSeenAt: Date;
  authVersion: number;
};

type RefreshTokenWriter = {
  refreshToken: {
    create(input: {
      data: {
        id: string;
        userId: string;
        tokenHash: string;
        expiresAt: Date;
      };
    }): Promise<unknown>;
  };
};

const MIN_JWT_SECRET_LENGTH = 32;
const AUTH_REFRESH_TRANSACTION_TIMEOUT_MS = 15_000;

@Injectable()
export class AuthSessionService {
  private readonly accessTokenTtlSeconds = toPositiveInt(process.env.CHORDV_ACCESS_TOKEN_TTL_SECONDS, 15 * 60);
  private readonly refreshTokenTtlSeconds = toPositiveInt(
    process.env.CHORDV_REFRESH_TOKEN_TTL_SECONDS,
    30 * 24 * 60 * 60
  );
  private readonly jwtSecret = resolveJwtSecret();
  private readonly jwtIssuer = process.env.CHORDV_JWT_ISSUER?.trim() || "chordv-api";

  constructor(private readonly prisma: PrismaService) {}

  async issueSession(userId: string): Promise<AuthSessionDto> {
    let user: SessionUser | null;
    try {
      user = await this.prisma.user.findUnique({ where: { id: userId } });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "登录用户读取失败，请稍后重试。");
    }
    if (!user || user.status !== "active") {
      throw new UnauthorizedException("账号不可用，请联系管理员处理。");
    }

    return this.createSessionForUser(user, this.prisma);
  }

  async rotateRefreshToken(refreshToken: string): Promise<AuthSessionDto> {
    const tokenHash = this.hashToken(refreshToken);
    let current:
      | ({
          id: string;
          userId: string;
          revokedAt: Date | null;
          expiresAt: Date;
          user: SessionUser;
        })
      | null;
    try {
      current = await this.prisma.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "登录会话读取失败，请稍后重试。");
    }

    if (!current || current.revokedAt || current.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("登录已失效，请重新登录。");
    }
    if (current.user.status !== "active") {
      throw new ForbiddenException("当前账号已禁用，请联系管理员处理。");
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const user = await tx.user.findUnique({ where: { id: current.userId } });
          if (!user || user.status !== "active") {
            throw new ForbiddenException("当前账号已禁用，请联系管理员处理。");
          }
          if (user.authVersion !== current.user.authVersion) {
            throw new UnauthorizedException("登录状态已过期，请重新登录。");
          }

          const rotated = await tx.refreshToken.updateMany({
            where: {
              id: current.id,
              revokedAt: null,
              expiresAt: { gt: new Date() }
            },
            data: { revokedAt: new Date() }
          });
          if (rotated.count !== 1) {
            throw new UnauthorizedException("登录状态已失效，请重新登录。");
          }

          return this.createSessionForUser(user, tx);
        },
        { timeout: AUTH_REFRESH_TRANSACTION_TIMEOUT_MS }
      );
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "登录会话刷新失败，请稍后重试。");
    }
  }

  async authenticateAccessToken(authorization?: string): Promise<UserProfileDto> {
    const token = this.extractBearerToken(authorization);
    const payload = this.verifyAccessToken(token);
    let user: SessionUser | null;
    try {
      user = await this.prisma.user.findUnique({
        where: { id: payload.sub }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "登录状态读取失败，请稍后重试。");
    }

    if (!user) {
      throw new UnauthorizedException("账号不存在，请重新登录。");
    }
    if (user.status !== "active") {
      throw new ForbiddenException("当前账号已禁用，请联系管理员处理。");
    }
    if (user.role !== payload.role) {
      throw new UnauthorizedException("登录状态已过期，请重新登录。");
    }
    if (user.authVersion !== payload.ver) {
      throw new UnauthorizedException("登录状态已过期，请重新登录。");
    }
    let session: { userId: string; revokedAt: Date | null; expiresAt: Date } | null;
    try {
      session = await this.prisma.refreshToken.findUnique({
        where: { id: payload.sid },
        select: {
          userId: true,
          revokedAt: true,
          expiresAt: true
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "登录状态读取失败，请稍后重试。");
    }
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("登录状态已过期，请重新登录。");
    }

    return toUserProfile(user);
  }

  async revokeByAccessToken(authorization?: string) {
    const token = this.extractBearerToken(authorization);
    const payload = this.verifyAccessToken(token);
    try {
      await this.prisma.refreshToken.updateMany({
        where: {
          id: payload.sid,
          userId: payload.sub,
          revokedAt: null,
          expiresAt: { gt: new Date() }
        },
        data: {
          revokedAt: new Date()
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "登录会话撤销失败，请稍后重试。");
    }
  }

  async revokeByAccessOrRefreshToken(authorization?: string, refreshToken?: string) {
    if (authorization?.startsWith("Bearer ")) {
      await this.revokeByAccessToken(authorization).catch(() => undefined);
    }
    if (refreshToken?.trim()) {
      await this.revokeByRefreshToken(refreshToken);
      return;
    }
  }

  async revokeByRefreshToken(refreshToken?: string) {
    const token = refreshToken?.trim();
    if (!token) {
      return;
    }
    let current: { id: string; revokedAt: Date | null; expiresAt: Date } | null;
    try {
      current = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: this.hashToken(token) },
        select: {
          id: true,
          revokedAt: true,
          expiresAt: true
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "登录会话读取失败，请稍后重试。");
    }
    if (!current || current.revokedAt || current.expiresAt.getTime() <= Date.now()) {
      return;
    }

    try {
      await this.prisma.refreshToken.updateMany({
        where: {
          id: current.id,
          revokedAt: null,
          expiresAt: { gt: new Date() }
        },
        data: {
          revokedAt: new Date()
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "登录会话撤销失败，请稍后重试。");
    }
  }

  async revokeAllUserSessions(userId: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: {
            authVersion: { increment: 1 }
          }
        });
        await tx.refreshToken.updateMany({
          where: {
            userId,
            revokedAt: null
          },
          data: {
            revokedAt: new Date()
          }
        });
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "登录会话撤销失败，请稍后重试。");
    }
  }

  private async createSessionForUser(user: SessionUser, client: RefreshTokenWriter): Promise<AuthSessionDto> {
    const now = Date.now();
    const accessTokenExpiresAt = new Date(now + this.accessTokenTtlSeconds * 1000);
    const refreshTokenExpiresAt = new Date(now + this.refreshTokenTtlSeconds * 1000);
    const refreshTokenId = randomUUID();

    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        ver: user.authVersion,
        sid: refreshTokenId
      } satisfies AccessPayload,
      this.jwtSecret,
      {
        issuer: this.jwtIssuer,
        expiresIn: this.accessTokenTtlSeconds
      }
    );

    const refreshToken = this.generateRefreshToken();
    try {
      await client.refreshToken.create({
        data: {
          id: refreshTokenId,
          userId: user.id,
          tokenHash: this.hashToken(refreshToken),
          expiresAt: refreshTokenExpiresAt
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "登录会话保存失败，请稍后重试。");
    }

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      user: toUserProfile(user)
    };
  }

  private verifyAccessToken(token: string): AccessPayload {
    try {
      const payload = jwt.verify(token, this.jwtSecret, {
        issuer: this.jwtIssuer
      });
      if (!payload || typeof payload !== "object") {
        throw new UnauthorizedException("登录凭证无效，请重新登录。");
      }

      const sub = Reflect.get(payload, "sub");
      const email = Reflect.get(payload, "email");
      const role = Reflect.get(payload, "role");
      const ver = Reflect.get(payload, "ver");
      const sid = Reflect.get(payload, "sid");
      if (
        typeof sub !== "string" ||
        typeof email !== "string" ||
        (role !== "user" && role !== "admin") ||
        typeof ver !== "number" ||
        typeof sid !== "string"
      ) {
        throw new UnauthorizedException("登录凭证无效，请重新登录。");
      }

      return {
        sub,
        email,
        role,
        ver,
        sid
      };
    } catch {
      throw new UnauthorizedException("登录凭证无效，请重新登录。");
    }
  }

  private extractBearerToken(authorization?: string) {
    if (!authorization || !authorization.startsWith("Bearer ")) {
      throw new UnauthorizedException("缺少登录凭证，请重新登录。");
    }
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      throw new UnauthorizedException("缺少登录凭证，请重新登录。");
    }
    return token;
  }

  private hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private generateRefreshToken() {
    return `${randomUUID().replaceAll("-", "")}${randomBytes(24).toString("hex")}`;
  }
}

function toUserProfile(row: {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  lastSeenAt: Date;
}): UserProfileDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    lastSeenAt: row.lastSeenAt.toISOString()
  };
}

function toPositiveInt(raw: string | undefined, fallback: number) {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveJwtSecret() {
  const secret = process.env.CHORDV_JWT_SECRET?.trim();
  if (secret) {
    if (secret.length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(`CHORDV_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters.`);
    }
    return secret;
  }
  if (process.env.NODE_ENV === "test") {
    return "chordv-dev-secret-change-me";
  }
  if (process.env.NODE_ENV === "development" && isEnabled(process.env.CHORDV_ALLOW_INSECURE_DEV_SECRET)) {
    console.warn("Using insecure development JWT secret because CHORDV_ALLOW_INSECURE_DEV_SECRET=true.");
    return "chordv-dev-secret-change-me";
  }
  if (isEnabled(process.env.CHORDV_ALLOW_INSECURE_DEV_SECRET)) {
    throw new Error("CHORDV_ALLOW_INSECURE_DEV_SECRET is only allowed when NODE_ENV=development.");
  }
  throw new Error("Missing CHORDV_JWT_SECRET.");
}

function isEnabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}
