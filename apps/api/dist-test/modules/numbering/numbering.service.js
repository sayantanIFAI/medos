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
exports.NumberingService = exports.sequenceTypeSchema = exports.sequenceConfigSchema = exports.DEFAULT_SEQUENCES = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@medos/shared");
const zod_1 = require("zod");
const audit_service_1 = require("../../common/audit.service");
const prisma_service_1 = require("../../common/prisma.service");
exports.DEFAULT_SEQUENCES = [
    { type: "MRN", pattern: "{FACILITY}-{SEQ}", padding: 6, resetPolicy: "NEVER" },
    { type: "OPD_VISIT", pattern: "OPD-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
    { type: "ADMISSION", pattern: "ADM-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
    { type: "INVOICE", pattern: "INV-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
    { type: "RECEIPT", pattern: "RCT-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
    { type: "PRESCRIPTION", pattern: "RX-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
    { type: "CREDIT_NOTE", pattern: "CN-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
    { type: "REFUND", pattern: "RF-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
    { type: "PURCHASE", pattern: "PUR-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
];
const TYPES = exports.DEFAULT_SEQUENCES.map((d) => d.type);
exports.sequenceConfigSchema = zod_1.z.object({
    pattern: zod_1.z.string().min(5).max(60).regex(/^[A-Za-z0-9{}\-/_.]+$/, "Only letters, digits and - / _ . { } allowed"),
    padding: zod_1.z.number().int().min(1).max(12),
    resetPolicy: zod_1.z.enum(["NEVER", "YEARLY"]),
}).strict().superRefine((v, c) => {
    if (!v.pattern.includes("{SEQ}"))
        c.addIssue({ code: "custom", path: ["pattern"], message: "Pattern must contain {SEQ}" });
    if (v.resetPolicy === "YEARLY" && !v.pattern.includes("{YEAR}")) {
        c.addIssue({ code: "custom", path: ["pattern"], message: "Yearly reset requires {YEAR} in the pattern" });
    }
    const unknown = v.pattern.match(/\{[^}]*\}/g)?.filter((t) => !["{SEQ}", "{YEAR}", "{FACILITY}"].includes(t));
    if (unknown?.length)
        c.addIssue({ code: "custom", path: ["pattern"], message: `Unknown token ${unknown[0]}` });
});
exports.sequenceTypeSchema = zod_1.z.enum(TYPES);
function yearIn(tz, at) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(at);
}
let NumberingService = class NumberingService {
    prisma;
    audit;
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    /**
     * Allocate the next business number. MUST be called with the caller's transaction client so the
     * counter increment commits (or rolls back) atomically with the record that uses the number.
     * Concurrency: a single atomic upsert-increment; concurrent callers serialise on the row lock.
     */
    async next(db, tenantId, facilityId, type, at = new Date()) {
        const facility = await db.facility.findFirst({ where: { id: facilityId, tenantId }, select: { code: true, timezone: true } });
        if (!facility)
            throw new shared_1.DomainError("FACILITY_NOT_FOUND", "Facility not found", 404);
        const cfg = (await db.numberSequenceConfig.findUnique({ where: { tenantId_facilityId_type: { tenantId, facilityId, type } } }))
            ?? exports.DEFAULT_SEQUENCES.find((d) => d.type === type);
        if (!cfg)
            throw new shared_1.DomainError("INTERNAL_ERROR", "Unknown sequence type", 500);
        const year = yearIn(facility.timezone, at);
        const periodKey = cfg.resetPolicy === "YEARLY" ? year : "";
        const rows = await db.$queryRaw `
      INSERT INTO "NumberSequence" ("tenantId", "facilityId", "type", "periodKey", "lastValue")
      VALUES (${tenantId}::uuid, ${facilityId}::uuid, ${type}, ${periodKey}, 1)
      ON CONFLICT ("tenantId", "facilityId", "type", "periodKey")
      DO UPDATE SET "lastValue" = "NumberSequence"."lastValue" + 1
      RETURNING "lastValue"`;
        const seq = rows[0]?.lastValue;
        if (seq === undefined)
            throw new shared_1.DomainError("INTERNAL_ERROR", "Sequence allocation failed", 500);
        return cfg.pattern
            .replaceAll("{FACILITY}", facility.code)
            .replaceAll("{YEAR}", year)
            .replaceAll("{SEQ}", seq.toString().padStart(cfg.padding, "0"));
    }
    async list(ctx) {
        const stored = await this.prisma.numberSequenceConfig.findMany({
            where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId },
            select: { type: true, pattern: true, padding: true, resetPolicy: true },
        });
        const byType = new Map(stored.map((s) => [s.type, s]));
        return exports.DEFAULT_SEQUENCES.map((d) => ({ ...(byType.get(d.type) ?? d), isDefault: !byType.has(d.type) }));
    }
    async update(ctx, type, input) {
        return this.prisma.$transaction(async (tx) => {
            const where = { tenantId_facilityId_type: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type } };
            const before = await tx.numberSequenceConfig.findUnique({ where });
            const row = await tx.numberSequenceConfig.upsert({
                where,
                create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type, ...input },
                update: input,
                select: { type: true, pattern: true, padding: true, resetPolicy: true },
            });
            await this.audit.record(tx, (0, audit_service_1.actorOf)(ctx), {
                action: "NUMBER_SEQUENCE_CONFIG_CHANGED", entityType: "NumberSequenceConfig", entityId: type,
                metadata: { type, from: before?.pattern ?? null, to: input.pattern },
            });
            return row;
        });
    }
};
exports.NumberingService = NumberingService;
exports.NumberingService = NumberingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, audit_service_1.AuditService])
], NumberingService);
//# sourceMappingURL=numbering.service.js.map