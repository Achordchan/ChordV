import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import * as jwt from "jsonwebtoken";
import type { AuthSessionDto, UserProfileDto } from "@chordv/shared";
import { PrismaService } from "./prisma.service";

type AccessPayload = {
  sub: string;
  email: string;
  role: "user" | "admin";
  ver: number;
};

@Injectable()
export class AuthSessionService {
  private readonly accessTokenTtlSeconds = toPositiveInt(process.env.CHORDV_ACCESS_TOKEN_TTL_SECONDS, 15 * 60);
  private readonly refreshTokenTtlSeconds = toPositiveInt(
    process.env.CHORDV_REFRESH_TOKEN_TTL_SECONDS,
    30 * 24 * 60 * 60
  );
  private readonly jwtSecret = process.env.CHORDV_JWT_SECRET?.trim() || "chordv-dev-secret-change-me";
  private readonly jwtIssuer = process.env.CHORDV_JWT_ISSUER?.trim() || "chordv-api";

  constructor(private readonly prisma: PrismaService) {}

  async issueSession(userId: string): Promise<AuthSessionDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "active") {
      throw new UnauthorizedException("用户不可用");
    }

    const now = Date.now();
    const accessTokenExpiresAt = new Date(now + this.accessTokenTtlSeconds * 1000);
    const refreshTokenExpiresAt = new Date(now + this.refreshTokenTtlSeconds * 1000);

    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        ver: user.authVersion
      } satisfies AccessPayload,
      this.jwtSecret,
      {
        issuer: this.jwtIssuer,
        expiresIn: this.accessTokenTtlSeconds
      }
    );

    const refreshToken = this.generateRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: refreshTokenExpiresAt
      }
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      user: toUserProfile(user)
    };
  }

  async rotateRefreshToken(refreshToken: string): Promise<AuthSessionDto> {
    const tokenHash = this.hashToken(refreshToken);
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true }
    });

    if (!current || current.revokedAt || current.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("刷新令牌无效");
    }

    if (current.user.status !== "active") {
      throw new ForbiddenException("当前用户已禁用");
    }

    await this.prisma.refreshToken.update({
      where: { id: current.id },
      data: { revokedAt: new Date() }
    });

    return this.issueSession(current.userId);
  }

  async authenticateAccessToken(authorization?: string): Promise<UserProfileDto> {
    const token = this.extractBearerToken(authorization);
    const payload = this.verifyAccessToken(token);
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub }
    });

    if (!user) {
      throw new UnauthorizedException("用户不存在");
    }
    if (user.status !== "active") {
      throw new ForbiddenException("当前用户已禁用");
    }
    if (user.authVersion !== payload.ver) {
      throw new UnauthorizedException("登录态已失效，请重新登录");
    }

    return toUserProfile(user);
  }

  async revokeByAccessToken(authorization?: string) {
    const token = this.extractBearerToken(authorization);
    const payload = this.verifyAccessToken(token);
    await this.prisma.refreshToken.updateMany({
      where: {
        userId: payload.sub,
        revokedAt: null
      },
      data: {
        revokedAt: new Date()
      }
    });
  }

  async revokeAllUserSessions(userId: string) {
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
  }

  private verifyAccessToken(token: string): AccessPayload {
    try {
      const payload = jwt.verify(token, this.jwtSecret, {
        issuer: this.jwtIssuer
      });
      if (!payload || typeof payload !== "object") {
        throw new UnauthorizedException("访问令牌无效");
      }

      const sub = Reflect.get(payload, "sub");
      const email = Reflect.get(payload, "email");
      const role = Reflect.get(payload, "role");
      const ver = Reflect.get(payload, "ver");
      if (
        typeof sub !== "string" ||
        typeof email !== "string" ||
        (role !== "user" && role !== "admin") ||
        typeof ver !== "number"
      ) {
        throw new UnauthorizedException("访问令牌无效");
      }

      return {
        sub,
        email,
        role,
        ver
      };
    } catch {
      throw new UnauthorizedException("访问令牌无效");
    }
  }

  private extractBearerToken(authorization?: string) {
    if (!authorization || !authorization.startsWith("Bearer ")) {
      throw new UnauthorizedException("缺少访问令牌");
    }
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      throw new UnauthorizedException("缺少访问令牌");
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
