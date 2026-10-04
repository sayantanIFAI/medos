import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DomainError, type Permission } from "@medos/shared";
import * as jwt from "jsonwebtoken";
import { CONFIG, type AppConfig } from "./config";
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from "./http";
import { PrismaService } from "./prisma.service";
import type { AuthedRequest } from "./request-context";

export interface AccessClaims { sub: string; tid: string; fid: string; typ: "access" }

/**
 * Global guard. For every non-public route it:
 *  1. verifies the access token (HS256 only),
 *  2. re-reads user/tenant/facility state from the database so deactivation, role changes and
 *     facility revocation take effect immediately,
 *  3. builds the authoritative RequestContext,
 *  4. enforces required permissions.
 * Unauthenticated and invalid-token failures are indistinguishable to the client.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const targets = [ec.getHandler(), ec.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ec.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers["authorization"];
    const raw = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!raw) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);

    let claims: AccessClaims;
    try {
      const decoded = jwt.verify(raw, this.config.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
      if (decoded["typ"] !== "access" || typeof decoded.sub !== "string" || typeof decoded["tid"] !== "string" || typeof decoded["fid"] !== "string") {
        throw new Error("bad claims");
      }
      claims = { sub: decoded.sub, tid: decoded["tid"] as string, fid: decoded["fid"] as string, typ: "access" };
    } catch {
      throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: claims.sub,
        tenantId: claims.tid,
        status: "ACTIVE",
        tenant: { status: "ACTIVE" },
      },
      select: {
        facilities: { where: { facilityId: claims.fid, tenantId: claims.tid, facility: { status: "ACTIVE" } }, select: { facilityId: true } },
        roles: { select: { role: { select: { permissions: { select: { permission: true } } } } } },
      },
    });
    if (!user) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    if (user.facilities.length === 0) throw new DomainError("UNAUTHORIZED_FACILITY", "No access to this facility", 403);

    const permissions = new Set<Permission>();
    for (const ur of user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission as Permission);

    const requestId = req.requestId ?? "unknown";
    req.ctx = { tenantId: claims.tid, facilityId: claims.fid, userId: claims.sub, permissions, requestId };

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, targets) ?? [];
    for (const p of required) {
      if (!permissions.has(p)) throw new DomainError("FORBIDDEN", "You do not have permission to perform this action", 403);
    }
    return true;
  }
}
