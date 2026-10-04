"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantsService = exports.updateTenantSchema = exports.provisionSchema = exports.passwordPolicy = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@medos/shared");
const zod_1 = require("zod");
const audit_service_1 = require("../../common/audit.service");
const prisma_service_1 = require("../../common/prisma.service");
const password_service_1 = require("../auth/password.service");
const numbering_service_1 = require("../numbering/numbering.service");
const tzSchema = zod_1.z.string().min(3).max(64).refine((tz) => {
    try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}, "Unknown timezone");
exports.passwordPolicy = zod_1.z.string().min(10, "Password must be at least 10 characters").max(256)
    .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), "Password must contain letters and digits");
exports.provisionSchema = zod_1.z.object({
    tenant: zod_1.z.object({
        name: zod_1.z.string().trim().min(2).max(120),
        code: zod_1.z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "lowercase letters, digits, hyphen; 2-32 chars"),
        timezone: tzSchema.default("Asia/Kolkata"),
    }).strict(),
    facility: zod_1.z.object({
        name: zod_1.z.string().trim().min(2).max(120),
        code: zod_1.z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/),
        city: zod_1.z.string().max(80).optional(),
        district: zod_1.z.string().max(80).optional(),
        state: zod_1.z.string().max(80).optional(),
    }).strict(),
    admin: zod_1.z.object({
        username: zod_1.z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/),
        fullName: zod_1.z.string().trim().min(2).max(120),
        email: zod_1.z.string().trim().toLowerCase().email().optional(),
        password: exports.passwordPolicy,
    }).strict(),
}).strict();
exports.updateTenantSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(120).optional(),
    timezone: tzSchema.optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");
let TenantsService = class TenantsService {
    prisma;
    passwords;
    audit;
    constructor(prisma, passwords, audit) {
        this.prisma = prisma;
        this.passwords = passwords;
        this.audit = audit;
    }
    /**
     * Platform-operator action (CLI only; no HTTP surface in MLP-1).
     * Creates a tenant with its first facility, system roles, number-sequence defaults and an administrator.
     */
    async provision(input) {
        const passwordHash = await this.passwords.hash(input.admin.password);
        return this.prisma.$transaction(async (tx) => {
            const tenant = await tx.tenant.create({ data: { name: input.tenant.name, code: input.tenant.code, timezone: input.tenant.timezone } });
            const facility = await tx.facility.create({ data: { tenantId: tenant.id, timezone: input.tenant.timezone, ...input.facility } });
            const roleIds = new Map();
            for (const [name, perms] of Object.entries(shared_1.SYSTEM_ROLES)) {
                const role = await tx.role.create({ data: { tenantId: tenant.id, name, isSystem: true } });
                await tx.rolePermission.createMany({ data: perms.map((permission) => ({ tenantId: tenant.id, roleId: role.id, permission })) });
                roleIds.set(name, role.id);
            }
            // Tenant administrators also get every permission needed to configure and oversee clinical staff.
            const adminRole = roleIds.get("ADMINISTRATOR");
            const admin = await tx.user.create({
                data: { tenantId: tenant.id, username: input.admin.username, email: input.admin.email ?? null, fullName: input.admin.fullName, passwordHash },
            });
            await tx.userFacility.create({ data: { tenantId: tenant.id, userId: admin.id, facilityId: facility.id } });
            await tx.userRole.create({ data: { tenantId: tenant.id, userId: admin.id, roleId: adminRole } });
            await tx.numberSequenceConfig.createMany({
                data: numbering_service_1.DEFAULT_SEQUENCES.map((s) => ({ tenantId: tenant.id, facilityId: facility.id, type: s.type, pattern: s.pattern, padding: s.padding, resetPolicy: s.resetPolicy })),
            });
            await this.audit.record(tx, { tenantId: tenant.id, facilityId: facility.id, userId: admin.id }, {
                action: "TENANT_PROVISIONED", entityType: "Tenant", entityId: tenant.id, metadata: { code: tenant.code },
            });
            return { tenantId: tenant.id, facilityId: facility.id, adminUserId: admin.id, permissionsKnown: shared_1.PERMISSIONS.length };
        });
    }
    async getCurrent(ctx) {
        const t = await this.prisma.tenant.findFirst({
            where: { id: ctx.tenantId },
            select: { id: true, name: true, code: true, status: true, timezone: true, currency: true },
        });
        if (!t)
            throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
        return t;
    }
    async updateCurrent(ctx, input) {
        return this.prisma.$transaction(async (tx) => {
            const before = await tx.tenant.findFirstOrThrow({ where: { id: ctx.tenantId } });
            const t = await tx.tenant.update({ where: { id: ctx.tenantId }, data: input, select: { id: true, name: true, code: true, status: true, timezone: true, currency: true } });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), {
                action: "TENANT_UPDATED", entityType: "Tenant", entityId: t.id,
                metadata: { changed: Object.keys(input), previousName: before.name },
            });
            return t;
        });
    }
};
exports.TenantsService = TenantsService;
exports.TenantsService = TenantsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        password_service_1.PasswordService,
        audit_service_1.AuditService])
], TenantsService);
//# sourceMappingURL=tenants.service.js.map