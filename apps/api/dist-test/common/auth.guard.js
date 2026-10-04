"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const shared_1 = require("@medos/shared");
const jwt = __importStar(require("jsonwebtoken"));
const config_1 = require("./config");
const http_1 = require("./http");
const prisma_service_1 = require("./prisma.service");
/**
 * Global guard. For every non-public route it:
 *  1. verifies the access token (HS256 only),
 *  2. re-reads user/tenant/facility state from the database so deactivation, role changes and
 *     facility revocation take effect immediately,
 *  3. builds the authoritative RequestContext,
 *  4. enforces required permissions.
 * Unauthenticated and invalid-token failures are indistinguishable to the client.
 */
let AuthGuard = class AuthGuard {
    reflector;
    prisma;
    config;
    constructor(reflector, prisma, config) {
        this.reflector = reflector;
        this.prisma = prisma;
        this.config = config;
    }
    async canActivate(ec) {
        const targets = [ec.getHandler(), ec.getClass()];
        if (this.reflector.getAllAndOverride(http_1.IS_PUBLIC, targets))
            return true;
        const req = ec.switchToHttp().getRequest();
        const header = req.headers["authorization"];
        const raw = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
        if (!raw)
            throw new shared_1.DomainError("UNAUTHENTICATED", "Authentication required", 401);
        let claims;
        try {
            const decoded = jwt.verify(raw, this.config.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
            if (decoded["typ"] !== "access" || typeof decoded.sub !== "string" || typeof decoded["tid"] !== "string" || typeof decoded["fid"] !== "string") {
                throw new Error("bad claims");
            }
            claims = { sub: decoded.sub, tid: decoded["tid"], fid: decoded["fid"], typ: "access" };
        }
        catch {
            throw new shared_1.DomainError("UNAUTHENTICATED", "Authentication required", 401);
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
        if (!user)
            throw new shared_1.DomainError("UNAUTHENTICATED", "Authentication required", 401);
        if (user.facilities.length === 0)
            throw new shared_1.DomainError("UNAUTHORIZED_FACILITY", "No access to this facility", 403);
        const permissions = new Set();
        for (const ur of user.roles)
            for (const rp of ur.role.permissions)
                permissions.add(rp.permission);
        const requestId = req.requestId ?? "unknown";
        req.ctx = { tenantId: claims.tid, facilityId: claims.fid, userId: claims.sub, permissions, requestId };
        const required = this.reflector.getAllAndOverride(http_1.REQUIRED_PERMISSIONS, targets) ?? [];
        for (const p of required) {
            if (!permissions.has(p))
                throw new shared_1.DomainError("FORBIDDEN", "You do not have permission to perform this action", 403);
        }
        return true;
    }
};
exports.AuthGuard = AuthGuard;
exports.AuthGuard = AuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, common_1.Inject)(config_1.CONFIG)),
    __metadata("design:paramtypes", [core_1.Reflector,
        prisma_service_1.PrismaService, Object])
], AuthGuard);
//# sourceMappingURL=auth.guard.js.map