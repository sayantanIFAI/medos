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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditController = void 0;
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const http_1 = require("../../common/http");
const prisma_service_1 = require("../../common/prisma.service");
const querySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    pageSize: zod_1.z.coerce.number().int().min(1).max(100).default(50),
    action: zod_1.z.string().trim().max(80).optional(),
    entityType: zod_1.z.string().trim().max(80).optional(),
    entityId: zod_1.z.string().trim().max(80).optional(),
    actorUserId: zod_1.z.string().uuid().optional(),
    from: zod_1.z.coerce.date().optional(),
    to: zod_1.z.coerce.date().optional(),
}).strict();
/** Read-only. There is deliberately no write/update/delete route for audit events. */
let AuditController = class AuditController {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async list(ctx, query) {
        const q = (0, http_1.parse)(querySchema, query);
        const where = {
            tenantId: ctx.tenantId,
            OR: [{ facilityId: ctx.facilityId }, { facilityId: null }],
            ...(q.action ? { action: q.action } : {}),
            ...(q.entityType ? { entityType: q.entityType } : {}),
            ...(q.entityId ? { entityId: q.entityId } : {}),
            ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
            ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
        };
        const [items, total] = await Promise.all([
            this.prisma.auditEvent.findMany({
                where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
                select: { id: true, action: true, entityType: true, entityId: true, actorUserId: true, facilityId: true, requestId: true, metadata: true, createdAt: true },
            }),
            this.prisma.auditEvent.count({ where }),
        ]);
        return (0, http_1.paginate)(items, total, q.page, q.pageSize);
    }
};
exports.AuditController = AuditController;
__decorate([
    (0, http_1.RequirePermissions)("AUDIT_READ"),
    (0, common_1.Get)(),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuditController.prototype, "list", null);
exports.AuditController = AuditController = __decorate([
    (0, common_1.Controller)("audit-events"),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AuditController);
//# sourceMappingURL=audit.controller.js.map