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
exports.UsersService = exports.setPermissionsSchema = exports.createRoleSchema = exports.listUsersSchema = exports.changePasswordSchema = exports.resetPasswordSchema = exports.setFacilitiesSchema = exports.setRolesSchema = exports.updateUserSchema = exports.createUserSchema = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@medos/shared");
const zod_1 = require("zod");
const audit_service_1 = require("../../common/audit.service");
const prisma_service_1 = require("../../common/prisma.service");
const password_service_1 = require("../auth/password.service");
const tenants_service_1 = require("../tenants/tenants.service");
const uuids = zod_1.z.array(zod_1.z.string().uuid()).min(1).max(50);
exports.createUserSchema = zod_1.z.object({
    username: zod_1.z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/),
    fullName: zod_1.z.string().trim().min(2).max(120),
    email: zod_1.z.string().trim().toLowerCase().email().optional(),
    password: tenants_service_1.passwordPolicy,
    roleIds: uuids,
    facilityIds: uuids,
}).strict();
exports.updateUserSchema = zod_1.z.object({
    fullName: zod_1.z.string().trim().min(2).max(120).optional(),
    email: zod_1.z.string().trim().toLowerCase().email().nullable().optional(),
    status: zod_1.z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");
exports.setRolesSchema = zod_1.z.object({ roleIds: uuids }).strict();
exports.setFacilitiesSchema = zod_1.z.object({ facilityIds: uuids }).strict();
exports.resetPasswordSchema = zod_1.z.object({ password: tenants_service_1.passwordPolicy }).strict();
exports.changePasswordSchema = zod_1.z.object({ currentPassword: zod_1.z.string().min(1).max(256), newPassword: tenants_service_1.passwordPolicy }).strict();
exports.listUsersSchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    pageSize: zod_1.z.coerce.number().int().min(1).max(100).default(25),
    q: zod_1.z.string().trim().max(60).optional(),
    status: zod_1.z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict();
exports.createRoleSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(60),
    permissions: zod_1.z.array(zod_1.z.enum(shared_1.PERMISSIONS)).min(1).max(shared_1.PERMISSIONS.length),
}).strict();
exports.setPermissionsSchema = zod_1.z.object({ permissions: zod_1.z.array(zod_1.z.enum(shared_1.PERMISSIONS)).min(1).max(shared_1.PERMISSIONS.length) }).strict();
const USER_SELECT = {
    id: true, username: true, email: true, fullName: true, status: true, createdAt: true,
    roles: { select: { role: { select: { id: true, name: true } } } },
    facilities: { select: { facility: { select: { id: true, name: true, code: true } } } },
};
function shape(u) {
    const { roles, facilities, ...rest } = u;
    return { ...rest, roles: roles.map((r) => r.role), facilities: facilities.map((f) => f.facility) };
}
let UsersService = class UsersService {
    prisma;
    passwords;
    audit;
    constructor(prisma, passwords, audit) {
        this.prisma = prisma;
        this.passwords = passwords;
        this.audit = audit;
    }
    async create(ctx, input) {
        const passwordHash = await this.passwords.hash(input.password);
        return this.prisma.$transaction(async (tx) => {
            const roleIds = [...new Set(input.roleIds)];
            const facilityIds = [...new Set(input.facilityIds)];
            await this.assertRolesAndFacilities(tx, ctx.tenantId, roleIds, facilityIds);
            const u = await tx.user.create({
                data: { tenantId: ctx.tenantId, username: input.username, email: input.email ?? null, fullName: input.fullName, passwordHash },
            });
            await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ tenantId: ctx.tenantId, userId: u.id, roleId })) });
            await tx.userFacility.createMany({ data: facilityIds.map((facilityId) => ({ tenantId: ctx.tenantId, userId: u.id, facilityId })) });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), { action: "USER_CREATED", entityType: "User", entityId: u.id, metadata: { roleIds, facilityIds } });
            return shape(await tx.user.findFirstOrThrow({ where: { id: u.id, tenantId: ctx.tenantId }, select: USER_SELECT }));
        });
    }
    async list(ctx, q) {
        const where = {
            tenantId: ctx.tenantId,
            ...(q.status ? { status: q.status } : {}),
            ...(q.q ? { OR: [{ fullName: { contains: q.q, mode: "insensitive" } }, { username: { contains: q.q.toLowerCase() } }] } : {}),
        };
        const [items, total] = await Promise.all([
            this.prisma.user.findMany({ where, select: USER_SELECT, orderBy: { fullName: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
            this.prisma.user.count({ where }),
        ]);
        return { items: items.map(shape), total };
    }
    async get(ctx, id) {
        const u = await this.prisma.user.findFirst({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT });
        if (!u)
            throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
        return shape(u);
    }
    async update(ctx, id, input) {
        if (id === ctx.userId && input.status === "INACTIVE") {
            throw new shared_1.DomainError("SELF_MODIFICATION_FORBIDDEN", "You cannot deactivate your own account", 409);
        }
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId } });
            if (!existing)
                throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
            await tx.user.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input });
            const deactivated = input.status === "INACTIVE" && existing.status === "ACTIVE";
            if (deactivated)
                await tx.refreshToken.updateMany({ where: { tenantId: ctx.tenantId, userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), {
                action: deactivated ? "USER_DEACTIVATED" : "USER_UPDATED", entityType: "User", entityId: id, metadata: { changed: Object.keys(input) },
            });
            return shape(await tx.user.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT }));
        });
    }
    async setRoles(ctx, id, input) {
        if (id === ctx.userId)
            throw new shared_1.DomainError("SELF_MODIFICATION_FORBIDDEN", "You cannot change your own roles", 409);
        return this.prisma.$transaction(async (tx) => {
            const user = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId }, select: { roles: { select: { roleId: true } } } });
            if (!user)
                throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
            const roleIds = [...new Set(input.roleIds)];
            await this.assertRolesAndFacilities(tx, ctx.tenantId, roleIds, []);
            await tx.userRole.deleteMany({ where: { tenantId: ctx.tenantId, userId: id } });
            await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ tenantId: ctx.tenantId, userId: id, roleId })) });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), {
                action: "USER_ROLES_CHANGED", entityType: "User", entityId: id,
                metadata: { before: user.roles.map((r) => r.roleId), after: roleIds },
            });
            return shape(await tx.user.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT }));
        });
    }
    async setFacilities(ctx, id, input) {
        if (id === ctx.userId)
            throw new shared_1.DomainError("SELF_MODIFICATION_FORBIDDEN", "You cannot change your own facility access", 409);
        return this.prisma.$transaction(async (tx) => {
            const user = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId }, select: { facilities: { select: { facilityId: true } } } });
            if (!user)
                throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
            const facilityIds = [...new Set(input.facilityIds)];
            await this.assertRolesAndFacilities(tx, ctx.tenantId, [], facilityIds);
            await tx.userFacility.deleteMany({ where: { tenantId: ctx.tenantId, userId: id } });
            await tx.userFacility.createMany({ data: facilityIds.map((facilityId) => ({ tenantId: ctx.tenantId, userId: id, facilityId })) });
            const removed = user.facilities.map((f) => f.facilityId).filter((f) => !facilityIds.includes(f));
            if (removed.length) {
                await tx.refreshToken.updateMany({ where: { tenantId: ctx.tenantId, userId: id, facilityId: { in: removed }, revokedAt: null }, data: { revokedAt: new Date() } });
            }
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), {
                action: "USER_FACILITIES_CHANGED", entityType: "User", entityId: id,
                metadata: { before: user.facilities.map((f) => f.facilityId), after: facilityIds },
            });
            return shape(await tx.user.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT }));
        });
    }
    async resetPassword(ctx, id, input) {
        if (id === ctx.userId)
            throw new shared_1.DomainError("SELF_MODIFICATION_FORBIDDEN", "Use the change-password flow for your own account", 409);
        const passwordHash = await this.passwords.hash(input.password);
        await this.prisma.$transaction(async (tx) => {
            const existing = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId } });
            if (!existing)
                throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
            await tx.user.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
            await tx.refreshToken.updateMany({ where: { tenantId: ctx.tenantId, userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), { action: "PASSWORD_RESET", entityType: "User", entityId: id });
        });
    }
    async changeOwnPassword(ctx, input) {
        const user = await this.prisma.user.findFirstOrThrow({ where: { id: ctx.userId, tenantId: ctx.tenantId } });
        if (!(await this.passwords.verify(input.currentPassword, user.passwordHash))) {
            throw new shared_1.DomainError("INVALID_CREDENTIALS", "Current password is incorrect", 400);
        }
        const passwordHash = await this.passwords.hash(input.newPassword);
        await this.prisma.$transaction(async (tx) => {
            await tx.user.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: ctx.userId } }, data: { passwordHash } });
            await tx.refreshToken.updateMany({ where: { tenantId: ctx.tenantId, userId: ctx.userId, revokedAt: null }, data: { revokedAt: new Date() } });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), { action: "PASSWORD_CHANGED", entityType: "User", entityId: ctx.userId });
        });
    }
    // ───── roles ─────
    async listRoles(ctx) {
        const roles = await this.prisma.role.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, name: true, isSystem: true, permissions: { select: { permission: true } } },
            orderBy: { name: "asc" },
        });
        return roles.map((r) => ({ id: r.id, name: r.name, isSystem: r.isSystem, permissions: r.permissions.map((p) => p.permission).sort() }));
    }
    async createRole(ctx, input) {
        return this.prisma.$transaction(async (tx) => {
            const role = await tx.role.create({ data: { tenantId: ctx.tenantId, name: input.name } });
            const permissions = [...new Set(input.permissions)];
            await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ tenantId: ctx.tenantId, roleId: role.id, permission })) });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), { action: "ROLE_CREATED", entityType: "Role", entityId: role.id, metadata: { name: role.name, permissions } });
            return { id: role.id, name: role.name, isSystem: false, permissions: permissions.sort() };
        });
    }
    async setRolePermissions(ctx, roleId, input) {
        return this.prisma.$transaction(async (tx) => {
            const role = await tx.role.findFirst({ where: { id: roleId, tenantId: ctx.tenantId }, include: { permissions: true } });
            if (!role)
                throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
            if (role.isSystem)
                throw new shared_1.DomainError("INVALID_STATE", "System roles cannot be modified; create a custom role instead", 409);
            const permissions = [...new Set(input.permissions)];
            await tx.rolePermission.deleteMany({ where: { tenantId: ctx.tenantId, roleId } });
            await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ tenantId: ctx.tenantId, roleId, permission })) });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), {
                action: "ROLE_PERMISSIONS_CHANGED", entityType: "Role", entityId: roleId,
                metadata: { before: role.permissions.map((p) => p.permission).sort(), after: permissions.sort() },
            });
            return { id: role.id, name: role.name, isSystem: false, permissions };
        });
    }
    async assertRolesAndFacilities(tx, tenantId, roleIds, facilityIds) {
        if (roleIds.length) {
            const n = await tx.role.count({ where: { tenantId, id: { in: roleIds } } });
            if (n !== roleIds.length)
                throw new shared_1.DomainError("VALIDATION_FAILED", "One or more roles do not exist", 400);
        }
        if (facilityIds.length) {
            const n = await tx.facility.count({ where: { tenantId, id: { in: facilityIds }, status: "ACTIVE" } });
            if (n !== facilityIds.length)
                throw new shared_1.DomainError("VALIDATION_FAILED", "One or more facilities do not exist or are inactive", 400);
        }
    }
};
exports.UsersService = UsersService;
exports.UsersService = UsersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        password_service_1.PasswordService,
        audit_service_1.AuditService])
], UsersService);
//# sourceMappingURL=users.service.js.map