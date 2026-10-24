import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

/** Registry of supported settings: each key has a strict schema and a safe default. Unknown keys are rejected. */
export const SETTINGS = {
  PHARMACY_ENABLED: { schema: z.boolean(), default: true, description: "Pharmacy module" },
  IPD_ENABLED: { schema: z.boolean(), default: true, description: "In-patient (admission, beds, discharge) module" },
  NURSING_ENABLED: { schema: z.boolean(), default: true, description: "Nursing (worklist, MAR, intake/output) module" },
  DISCHARGE_REQUIRED_STEPS: {
    schema: z.array(z.enum(["NURSING", "CHARGES_REVIEWED", "PHARMACY", "BILLING"])).max(4).refine((a) => new Set(a).size === a.length, "Duplicate step"),
    default: ["NURSING", "CHARGES_REVIEWED", "PHARMACY", "BILLING"] as string[],
    description: "Clearance steps required before discharge (medical fitness is always required)",
  },
  DISCHARGE_REQUIRE_SUMMARY: { schema: z.boolean(), default: true, description: "Require a signed discharge summary before discharge" },
  BED_AFTER_DISCHARGE: { schema: z.enum(["CLEANING", "AVAILABLE"]), default: "CLEANING", description: "Status of a bed once its patient is discharged" },
  PRINT_HEADER: { schema: z.object({ hospitalName: z.string().trim().min(2).max(120), tagline: z.string().trim().max(160).optional(), address: z.string().trim().max(300).optional(), phone: z.string().trim().max(40).optional(), email: z.string().trim().email().max(120).optional(), gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).optional(), logoDataUrl: z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/).max(300_000).optional() }).strict(), default: null as unknown, description: "Hospital identity printed on documents" },
  PRINT_FOOTER: { schema: z.object({ invoice: z.string().trim().max(400).optional(), receipt: z.string().trim().max(400).optional(), prescription: z.string().trim().max(400).optional(), dischargeSummary: z.string().trim().max(400).optional() }).strict(), default: {} as unknown, description: "Footer text per document type" },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const settingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);
export const putSettingSchema = z.object({ value: z.unknown() }).strict();

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async get<K extends SettingKey>(db: Db | PrismaService, tenantId: string, facilityId: string, key: K): Promise<z.infer<(typeof SETTINGS)[K]["schema"]>> {
    const row = await db.setting.findUnique({ where: { tenantId_facilityId_key: { tenantId, facilityId, key } } });
    return (row ? row.value : SETTINGS[key].default) as z.infer<(typeof SETTINGS)[K]["schema"]>;
  }

  async isEnabled(tenantId: string, facilityId: string, key: "PHARMACY_ENABLED" | "IPD_ENABLED" | "NURSING_ENABLED"): Promise<boolean> {
    return this.get(this.prisma, tenantId, facilityId, key);
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.setting.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return SETTING_KEYS.map((key) => ({ key, description: SETTINGS[key].description, value: byKey.get(key)?.value ?? SETTINGS[key].default, isDefault: !byKey.has(key), updatedAt: byKey.get(key)?.updatedAt ?? null }));
  }

  async put(ctx: RequestContext, key: SettingKey, raw: unknown) {
    const parsed = SETTINGS[key].schema.safeParse(raw);
    if (!parsed.success) throw new DomainError("VALIDATION_FAILED", "Invalid value for this setting", 400, parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { tenantId_facilityId_key: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, key } } });
      const value = parsed.data as Prisma.InputJsonValue;
      await tx.setting.upsert({
        where: { tenantId_facilityId_key: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, key } },
        create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, key, value, updatedById: ctx.userId },
        update: { value, updatedById: ctx.userId },
      });
      const isPrint = key.startsWith("PRINT_");
      await this.audit.record(tx, actorOf(ctx), { action: "SETTING_CHANGED", entityType: "Setting", entityId: key, metadata: isPrint ? { key } : { key, from: (before?.value ?? SETTINGS[key].default) as Prisma.InputJsonValue, to: value } });
      return { key, value: parsed.data };
    });
  }

  /** Feature flags for navigation: which modules this facility has switched on. */
  async features(ctx: RequestContext) {
    const [pharmacy, ipd, nursing] = await Promise.all([
      this.get(this.prisma, ctx.tenantId, ctx.facilityId, "PHARMACY_ENABLED"), this.get(this.prisma, ctx.tenantId, ctx.facilityId, "IPD_ENABLED"), this.get(this.prisma, ctx.tenantId, ctx.facilityId, "NURSING_ENABLED"),
    ]);
    return { PHARMACY_ENABLED: pharmacy, IPD_ENABLED: ipd, NURSING_ENABLED: nursing };
  }
}
