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
exports.AuthService = exports.switchFacilitySchema = exports.refreshSchema = exports.loginSchema = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@medos/shared");
const jwt = __importStar(require("jsonwebtoken"));
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const audit_service_1 = require("../../common/audit.service");
const config_1 = require("../../common/config");
const prisma_service_1 = require("../../common/prisma.service");
const password_service_1 = require("./password.service");
exports.loginSchema = zod_1.z.object({
    tenantCode: zod_1.z.string().trim().toLowerCase().min(2).max(32),
    identifier: zod_1.z.string().trim().toLowerCase().min(1).max(254),
    password: zod_1.z.string().min(1).max(256),
    facilityId: zod_1.z.string().uuid().optional(),
}).strict();
exports.refreshSchema = zod_1.z.object({ refreshToken: zod_1.z.string().min(20).max(200) }).strict();
exports.switchFacilitySchema = zod_1.z.object({ refreshToken: zod_1.z.string().min(20).max(200), facilityId: zod_1.z.string().uuid() }).strict();
const INVALID = () => new shared_1.DomainError("INVALID_CREDENTIALS", "Invalid credentials", 401);
const sha256 = (s) => (0, node_crypto_1.createHash)("sha256").update(s).digest("hex");
let AuthService = class AuthService {
    prisma;
    passwords;
    audit;
    config;
    constructor(prisma, passwords, audit, config) {
        this.prisma = prisma;
        this.passwords = passwords;
        this.audit = audit;
        this.config = config;
    }
    async login(input, requestId) {
        const tenant = await this.prisma.tenant.findUnique({ where: { code: input.tenantCode } });
        if (!tenant) {
            await this.passwords.verifyDummy(input.password);
            throw INVALID();
        }
        const user = await this.prisma.user.findFirst({
            where: { tenantId: tenant.id, OR: [{ username: input.identifier }, { email: input.identifier }] },
            include: { facilities: { where: { facility: { status: "ACTIVE" } }, include: { facility: true } } },
        });
        const actor = { tenantId: tenant.id, userId: user?.id ?? null, requestId };
        if (!user) {
            await this.passwords.verifyDummy(input.password);
            await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", metadata: { reason: "UNKNOWN_USER" } });
            throw INVALID();
        }
        const now = new Date();
        if (user.lockedUntil && user.lockedUntil > now) {
            await this.passwords.verifyDummy(input.password);
            await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", entityId: user.id, metadata: { reason: "LOCKED" } });
            throw INVALID();
        }
        const ok = await this.passwords.verify(input.password, user.passwordHash);
        if (!ok) {
            await this.registerFailure(user.id, tenant.id);
            await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", entityId: user.id, metadata: { reason: "BAD_PASSWORD" } });
            throw INVALID();
        }
        if (user.status !== "ACTIVE" || tenant.status !== "ACTIVE") {
            await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", entityId: user.id, metadata: { reason: "INACTIVE" } });
            throw INVALID();
        }
        const facilities = user.facilities.map((f) => ({ id: f.facility.id, name: f.facility.name, code: f.facility.code }));
        if (facilities.length === 0) {
            await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", entityId: user.id, metadata: { reason: "NO_FACILITY" } });
            throw new shared_1.DomainError("UNAUTHORIZED_FACILITY", "No facility access assigned", 403);
        }
        const chosen = facilities.length === 1 ? facilities[0] : facilities.find((f) => f.id === input.facilityId);
        if (!chosen && input.facilityId)
            throw new shared_1.DomainError("UNAUTHORIZED_FACILITY", "No access to this facility", 403);
        if (!chosen)
            return { status: "FACILITY_SELECTION_REQUIRED", facilities };
        await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
        const tokens = await this.prisma.$transaction(async (tx) => {
            const t = await this.issue(tx, tenant.id, user.id, chosen.id, (0, node_crypto_1.randomUUID)());
            await this.audit.record(tx, { ...actor, facilityId: chosen.id }, { action: "LOGIN_SUCCESS", entityType: "User", entityId: user.id });
            return t.pair;
        });
        return { status: "AUTHENTICATED", tokens, facility: chosen };
    }
    async refresh(refreshToken, requestId) {
        const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
        if (!row)
            throw new shared_1.DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
        if (row.revokedAt) {
            // Reuse of a rotated/revoked token => assume theft; kill the whole family.
            await this.prisma.$transaction(async (tx) => {
                await tx.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
                await this.audit.record(tx, { tenantId: row.tenantId, facilityId: row.facilityId, userId: row.userId, requestId }, {
                    action: "REFRESH_TOKEN_REUSE_DETECTED", entityType: "User", entityId: row.userId, metadata: { familyId: row.familyId },
                });
            });
            throw new shared_1.DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
        }
        if (row.expiresAt <= new Date())
            throw new shared_1.DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
        const user = await this.prisma.user.findFirst({
            where: { id: row.userId, tenantId: row.tenantId, status: "ACTIVE", tenant: { status: "ACTIVE" } },
            select: { facilities: { where: { facilityId: row.facilityId, facility: { status: "ACTIVE" } }, select: { facilityId: true } } },
        });
        if (!user || user.facilities.length === 0) {
            await this.revokeFamily(row.familyId);
            throw new shared_1.DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
        }
        return this.prisma.$transaction(async (tx) => {
            // Atomic claim: only one concurrent refresh can flip revokedAt from null.
            const claimed = await tx.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
            if (claimed.count !== 1)
                throw new shared_1.DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
            const next = await this.issue(tx, row.tenantId, row.userId, row.facilityId, row.familyId);
            await tx.refreshToken.update({ where: { id: row.id }, data: { replacedById: next.id } });
            return next.pair;
        });
    }
    async logout(refreshToken, requestId) {
        const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
        if (!row)
            return; // idempotent; do not reveal whether the token existed
        await this.prisma.$transaction(async (tx) => {
            await tx.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
            await this.audit.record(tx, { tenantId: row.tenantId, facilityId: row.facilityId, userId: row.userId, requestId }, {
                action: "LOGOUT", entityType: "User", entityId: row.userId,
            });
        });
    }
    async switchFacility(userId, tenantId, input, requestId) {
        const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(input.refreshToken) } });
        if (!row || row.revokedAt || row.userId !== userId || row.tenantId !== tenantId || row.expiresAt <= new Date()) {
            throw new shared_1.DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
        }
        const access = await this.prisma.userFacility.findFirst({
            where: { tenantId, userId, facilityId: input.facilityId, facility: { status: "ACTIVE" } },
        });
        if (!access)
            throw new shared_1.DomainError("UNAUTHORIZED_FACILITY", "No access to this facility", 403);
        return this.prisma.$transaction(async (tx) => {
            await tx.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
            const next = await this.issue(tx, tenantId, userId, input.facilityId, (0, node_crypto_1.randomUUID)());
            await this.audit.record(tx, { tenantId, facilityId: input.facilityId, userId, requestId }, {
                action: "FACILITY_SWITCHED", entityType: "User", entityId: userId, metadata: { fromFacilityId: row.facilityId },
            });
            return next.pair;
        });
    }
    async me(tenantId, userId, facilityId, permissions) {
        const user = await this.prisma.user.findFirstOrThrow({
            where: { id: userId, tenantId },
            select: {
                id: true, username: true, fullName: true, email: true,
                tenant: { select: { id: true, name: true, code: true, timezone: true, currency: true } },
                facilities: { where: { facility: { status: "ACTIVE" } }, select: { facility: { select: { id: true, name: true, code: true, timezone: true } } } },
                roles: { select: { role: { select: { name: true } } } },
            },
        });
        return {
            id: user.id, username: user.username, fullName: user.fullName, email: user.email,
            tenant: user.tenant,
            facility: user.facilities.map((f) => f.facility).find((f) => f.id === facilityId) ?? null,
            facilities: user.facilities.map((f) => f.facility),
            roles: user.roles.map((r) => r.role.name),
            permissions: [...permissions].sort(),
        };
    }
    async revokeAllForUser(db, tenantId, userId) {
        await db.refreshToken.updateMany({ where: { tenantId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    async revokeFamily(familyId) {
        await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    async registerFailure(userId, tenantId) {
        const updated = await this.prisma.user.update({
            where: { tenantId_id: { tenantId, id: userId } },
            data: { failedLoginCount: { increment: 1 } },
            select: { failedLoginCount: true },
        });
        if (updated.failedLoginCount >= this.config.LOGIN_MAX_FAILURES) {
            await this.prisma.user.update({
                where: { tenantId_id: { tenantId, id: userId } },
                data: { lockedUntil: new Date(Date.now() + this.config.LOGIN_LOCK_SECONDS * 1000), failedLoginCount: 0 },
            });
        }
    }
    async issue(db, tenantId, userId, facilityId, familyId) {
        const refreshToken = (0, node_crypto_1.randomBytes)(32).toString("base64url");
        const row = await db.refreshToken.create({
            data: {
                tenantId, userId, facilityId, familyId,
                tokenHash: sha256(refreshToken),
                expiresAt: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000),
            },
        });
        const accessToken = jwt.sign({ typ: "access", tid: tenantId, fid: facilityId }, this.config.JWT_ACCESS_SECRET, {
            algorithm: "HS256", subject: userId, expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
        });
        const pair = { accessToken, refreshToken, expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS };
        return { pair, id: row.id };
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __param(3, (0, common_1.Inject)(config_1.CONFIG)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        password_service_1.PasswordService,
        audit_service_1.AuditService, Object])
], AuthService);
//# sourceMappingURL=auth.service.js.map