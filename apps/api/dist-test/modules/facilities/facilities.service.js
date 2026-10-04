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
exports.FacilitiesService = exports.updateFacilitySchema = exports.createFacilitySchema = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@medos/shared");
const zod_1 = require("zod");
const audit_service_1 = require("../../common/audit.service");
const prisma_service_1 = require("../../common/prisma.service");
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const phone = zod_1.z.string().trim().regex(/^[+0-9][0-9 ()-]{6,19}$/, "Invalid phone number");
const profile = {
    name: zod_1.z.string().trim().min(2).max(120),
    address: zod_1.z.string().trim().max(240).nullable(),
    city: zod_1.z.string().trim().max(80).nullable(),
    district: zod_1.z.string().trim().max(80).nullable(),
    state: zod_1.z.string().trim().max(80).nullable(),
    postalCode: zod_1.z.string().trim().regex(/^[0-9]{6}$/, "Postal code must be 6 digits").nullable(),
    phone: phone.nullable(),
    email: zod_1.z.string().trim().toLowerCase().email().nullable(),
    gstin: zod_1.z.string().trim().toUpperCase().regex(GSTIN, "Invalid GSTIN").nullable(),
};
exports.createFacilitySchema = zod_1.z.object({
    code: zod_1.z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/, "Uppercase letters, digits, hyphen; max 16"),
    ...profile,
    name: profile.name,
}).partial({ address: true, city: true, district: true, state: true, postalCode: true, phone: true, email: true, gstin: true }).strict();
exports.updateFacilitySchema = zod_1.z.object({ ...profile, status: zod_1.z.enum(["ACTIVE", "INACTIVE"]) }).partial().strict()
    .refine((v) => Object.keys(v).length > 0, "No changes supplied");
const SELECT = {
    id: true, name: true, code: true, address: true, city: true, district: true, state: true,
    postalCode: true, phone: true, email: true, gstin: true, timezone: true, status: true,
};
let FacilitiesService = class FacilitiesService {
    prisma;
    audit;
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    async list(ctx) {
        const all = ctx.permissions.has("ADMIN_SETTINGS");
        return this.prisma.facility.findMany({
            where: { tenantId: ctx.tenantId, ...(all ? {} : { userFacilities: { some: { userId: ctx.userId, tenantId: ctx.tenantId } } }) },
            select: SELECT,
            orderBy: { name: "asc" },
        });
    }
    async get(ctx, id) {
        const all = ctx.permissions.has("ADMIN_SETTINGS");
        const f = await this.prisma.facility.findFirst({
            where: { id, tenantId: ctx.tenantId, ...(all ? {} : { userFacilities: { some: { userId: ctx.userId, tenantId: ctx.tenantId } } }) },
            select: SELECT,
        });
        if (!f)
            throw new shared_1.DomainError("FACILITY_NOT_FOUND", "Facility not found", 404);
        return f;
    }
    async create(ctx, input) {
        return this.prisma.$transaction(async (tx) => {
            const tenant = await tx.tenant.findFirstOrThrow({ where: { id: ctx.tenantId }, select: { timezone: true } });
            const f = await tx.facility.create({ data: { ...input, tenantId: ctx.tenantId, timezone: tenant.timezone }, select: SELECT });
            await tx.userFacility.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, facilityId: f.id } });
            await this.audit.record(tx, { ...(0, audit_service_1.actorOf)(ctx), facilityId: f.id }, { action: "FACILITY_CREATED", entityType: "Facility", entityId: f.id, metadata: { code: f.code } });
            return f;
        });
    }
    async update(ctx, id, input) {
        if (input.status === "INACTIVE" && id === ctx.facilityId) {
            throw new shared_1.DomainError("INVALID_STATE", "You cannot deactivate the facility you are currently working in", 409);
        }
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.facility.findFirst({ where: { id, tenantId: ctx.tenantId } });
            if (!existing)
                throw new shared_1.DomainError("FACILITY_NOT_FOUND", "Facility not found", 404);
            const f = await tx.facility.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input, select: SELECT });
            await this.audit.record(tx, { ...(0, audit_service_1.actorOf)(ctx), facilityId: id }, {
                action: input.status && input.status !== existing.status ? "FACILITY_STATUS_CHANGED" : "FACILITY_UPDATED",
                entityType: "Facility", entityId: id, metadata: { changed: Object.keys(input) },
            });
            return f;
        });
    }
};
exports.FacilitiesService = FacilitiesService;
exports.FacilitiesService = FacilitiesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, audit_service_1.AuditService])
], FacilitiesService);
//# sourceMappingURL=facilities.service.js.map