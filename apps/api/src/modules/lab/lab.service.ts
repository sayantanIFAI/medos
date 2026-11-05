import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { endOfLocalDay, startOfLocalDay } from "../../common/time";
import { amount } from "../billing/money.schema";
import { TestIndex, type TestMatch } from "@medos/frontdesk-core";

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const listLabTestsSchema = z.object({
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

export const upsertLabTestSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,23}$/),
  name: z.string().trim().min(2).max(120),
  price: amount(),
  sampleType: z.string().trim().min(2).max(40).default("Blood"),
  reportHours: z.number().int().min(1).max(24 * 30).default(24),
  fastingRequired: z.boolean().default(false),
  prepEn: z.string().trim().max(400).optional(),
  prepHi: z.string().trim().max(400).optional(),
  aliases: z.array(z.string().trim().min(1).max(60)).max(60).default([]),
  /** Codes of the tests this one bundles (a "fever profile"). Booking it books exactly these; its rate is the sum of theirs, whatever `price` says. */
  includes: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,23}$/)).max(20).default([]),
}).strict();

export const createLabBookingSchema = z.object({
  patientId: uuid,
  testIds: z.array(uuid).min(1).max(30),
  collectionAt: instant,
  homeCollection: z.boolean().default(false),
  notes: z.string().trim().max(300).optional(),
}).strict();

export const cancelLabBookingSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();

export const listLabBookingsSchema = z.object({
  date: ymd.optional(), patientId: uuid.optional(), status: z.enum(["BOOKED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const TEST = { id: true, code: true, name: true, price: true, sampleType: true, reportHours: true, fastingRequired: true, prepEn: true, prepHi: true, aliases: true, includes: true } satisfies Prisma.LabTestSelect;
type TestRow = Prisma.LabTestGetPayload<{ select: typeof TEST }>;
export const toTestView = (t: TestRow) => ({ ...t, price: t.price.toFixed(2) });

const BOOKING = {
  id: true, status: true, source: true, collectionAt: true, homeCollection: true, notes: true, cancelReason: true, totalAmount: true, fileId: true, version: true, patientId: true, createdAt: true,
  patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  items: { select: { labTestId: true, name: true, price: true }, orderBy: { name: "asc" as const } },
} satisfies Prisma.LabBookingSelect;
type BookingRow = Prisma.LabBookingGetPayload<{ select: typeof BOOKING }>;
export function toBookingView(b: BookingRow) {
  const { patient, items, totalAmount, ...rest } = b;
  return {
    ...rest,
    totalAmount: totalAmount.toFixed(2),
    patientName: [patient.firstName, patient.lastName].filter(Boolean).join(" "),
    mrn: patient.identifiers[0]?.value ?? null,
    items: items.map((i) => ({ labTestId: i.labTestId, name: i.name, price: i.price.toFixed(2) })),
  };
}

export type BookingSource = "MANUAL" | "VOICE_ASSISTANT" | "PRESCRIPTION";

@Injectable()
export class LabService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly idempotency: IdempotencyService) {}

  // ───── catalogue ─────

  async listTests(ctx: RequestContext, q: z.infer<typeof listLabTestsSchema>) {
    const where: Prisma.LabTestWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE",
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { code: { contains: q.q.toUpperCase() } }, { aliases: { has: q.q.toLowerCase() } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.labTest.findMany({ where, select: TEST, orderBy: { name: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.labTest.count({ where }),
    ]);
    return { items: (await this.priceBundles(this.prisma, ctx, rows)).map(toTestView), total };
  }

  /** A bundle's rate is the sum of its tests' current rates, so it can never drift from them. Ordinary tests are returned as they are. */
  private async priceBundles<T extends { includes: string[]; price: { toString(): string } }>(db: Pick<Db, "labTest">, ctx: RequestContext, rows: T[]): Promise<(Omit<T, "price"> & { price: Decimal })[]> {
    const codes = [...new Set(rows.flatMap((r) => r.includes))];
    const parts = codes.length ? await db.labTest.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", code: { in: codes } }, select: { code: true, price: true } }) : [];
    const byCode = new Map(parts.map((p) => [p.code, p.price.toString()]));
    return rows.map((r) => ({ ...r, price: r.includes.length ? r.includes.reduce((sum, c) => sum.plus(byCode.get(c) ?? "0"), new Decimal(0)) : new Decimal(r.price.toString()) }));
  }

  /** The tests the assistant needs to quote or book: current rate, report time, fasting and preparation. A bundle takes its rate from its tests, needs fasting if any of them does, and reports when the last of them does. */
  async testsByIds(ctx: RequestContext, ids: string[]) {
    const rows = await this.prisma.labTest.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: TEST });
    const priced = await this.priceBundles(this.prisma, ctx, rows);
    const codes = [...new Set(rows.flatMap((r) => r.includes))];
    const parts = codes.length ? await this.prisma.labTest.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", code: { in: codes } }, select: { code: true, reportHours: true, fastingRequired: true, prepEn: true, prepHi: true } }) : [];
    return priced.map((r) => {
      const inc = parts.filter((p) => r.includes.includes(p.code));
      return {
        id: r.id, name: r.name, price: r.price.toFixed(2),
        reportHours: inc.length ? Math.max(r.reportHours, ...inc.map((p) => p.reportHours)) : r.reportHours,
        fastingRequired: r.fastingRequired || inc.some((p) => p.fastingRequired),
        prepEn: r.prepEn ?? inc.find((p) => p.prepEn)?.prepEn ?? null, prepHi: r.prepHi ?? inc.find((p) => p.prepHi)?.prepHi ?? null,
      };
    });
  }

  /** Creates the test, or updates it when the code already exists (so the catalogue can be loaded again safely). */
  async upsertTest(ctx: RequestContext, input: z.infer<typeof upsertLabTestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      // a bundle lists tests of this hospital that exist, are active, are not bundles themselves, and are not the bundle itself
      const includes = [...new Set(input.includes)];
      let price = input.price;
      if (includes.length) {
        const parts = await tx.labTest.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", code: { in: includes } }, select: { code: true, price: true, includes: true } });
        const bad = includes.filter((c) => c === input.code || !parts.some((p) => p.code === c) || parts.find((p) => p.code === c)?.includes.length);
        if (bad.length) throw new DomainError("VALIDATION_FAILED", `A bundle can only include existing ordinary tests: ${bad.join(", ")}`, 400, [{ path: "includes", message: "Unknown test, the bundle itself, or another bundle" }]);
        price = parts.reduce((sum, p) => sum.plus(p.price.toString()), new Decimal(0)) as unknown as typeof input.price;
      }
      const data = {
        includes, name: input.name, price: price.toFixed(2), sampleType: input.sampleType, reportHours: input.reportHours, fastingRequired: input.fastingRequired,
        prepEn: input.prepEn ?? null, prepHi: input.prepHi ?? null, aliases: [...new Set(input.aliases.map((a) => a.toLowerCase()))], status: "ACTIVE" as const,
      };
      const existing = await tx.labTest.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, code: input.code } });
      const row = existing
        ? await tx.labTest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: existing.id } }, data, select: TEST })
        : await tx.labTest.create({ data: { ...data, code: input.code, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: TEST });
      const priceChanged = existing && !existing.price.equals(input.price);
      await this.audit.record(tx, actorOf(ctx), {
        action: existing ? "LAB_TEST_UPDATED" : "LAB_TEST_CREATED", entityType: "LabTest", entityId: row.id,
        metadata: { code: input.code, ...(priceChanged ? { priceFrom: existing.price.toFixed(2), priceTo: input.price.toFixed(2) } : {}) },
      });
      return { ...toTestView(row), created: !existing };
    });
  }

  /** The tests named in some text, with their current rates. Only finds tests the hospital actually offers. */
  async findTests(ctx: RequestContext, text: string): Promise<(TestMatch & { price: string; code: string })[]> {
    const tests = await this.priceBundles(this.prisma, ctx, await this.prisma.labTest.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, code: true, name: true, price: true, aliases: true, includes: true } }));
    const byId = new Map(tests.map((t) => [t.id, t]));
    return new TestIndex(tests.map((t) => ({ id: t.id, name: t.name, aliases: t.aliases }))).find(text).map((m) => ({ ...m, price: (byId.get(m.testId) as { price: Prisma.Decimal }).price.toFixed(2), code: (byId.get(m.testId) as { code: string }).code }));
  }

  // ───── bookings ─────

  async create(
    ctx: RequestContext, input: z.infer<typeof createLabBookingSchema>,
    o: { source: BookingSource; fileId?: string | null; idempotencyKey?: string },
  ) {
    if (input.collectionAt.getTime() < Date.now() - 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "The collection time is in the past", 400, [{ path: "collectionAt", message: "Choose a time from now on" }]);
    const testIds = [...new Set(input.testIds)];
    const { result, replayed } = await this.idempotency.run(ctx.tenantId, "LAB_BOOKING", o.idempotencyKey, { ...input, source: o.source, fileId: o.fileId ?? null }, async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      const asked = await tx.labTest.findMany({ where: { id: { in: testIds }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, name: true, price: true, includes: true } });
      if (asked.length !== testIds.length) throw new DomainError("VALIDATION_FAILED", "One or more tests were not found", 400, [{ path: "testIds", message: "Unknown or inactive test" }]);
      // a bundle (a "fever profile") books exactly the tests it includes, each once even when also asked for on its own
      const bundleCodes = [...new Set(asked.flatMap((t) => t.includes))];
      const parts = bundleCodes.length ? await tx.labTest.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", code: { in: bundleCodes } }, select: { id: true, name: true, price: true, includes: true } }) : [];
      if (parts.length !== bundleCodes.length) throw new DomainError("VALIDATION_FAILED", "A test in this bundle is no longer offered", 400, [{ path: "testIds", message: "Bundle has an unavailable test" }]);
      const tests = [...new Map([...asked.filter((t) => t.includes.length === 0), ...parts].map((t) => [t.id, t])).values()];
      const total = tests.reduce((sum, t) => sum.plus(t.price.toString()), new Decimal(0));
      const b = await tx.labBooking.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, source: o.source, collectionAt: input.collectionAt, homeCollection: input.homeCollection,
          notes: input.notes ?? null, totalAmount: total.toFixed(2), fileId: o.fileId ?? null, createdById: ctx.userId,
          items: { create: tests.map((t) => ({ tenantId: ctx.tenantId, labTestId: t.id, name: t.name, price: t.price.toFixed(2) })) },
        },
        select: BOOKING,
      });
      await this.audit.record(tx, actorOf(ctx), {
        action: "LAB_BOOKED", entityType: "LabBooking", entityId: b.id,
        metadata: { source: o.source, tests: tests.length, ...(bundleCodes.length ? { bundles: asked.filter((t) => t.includes.length).map((t) => t.name).join(", ") } : {}), total: total.toFixed(2), homeCollection: input.homeCollection, ...(o.fileId ? { fileId: o.fileId } : {}) },
      });
      return toBookingView(b);
    });
    return { booking: result, replayed };
  }

  async get(ctx: RequestContext, id: string) {
    const b = await this.prisma.labBooking.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: BOOKING });
    if (!b) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return toBookingView(b);
  }

  async list(ctx: RequestContext, q: z.infer<typeof listLabBookingsSchema>) {
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const where: Prisma.LabBookingWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId,
      ...(q.status ? { status: q.status } : {}), ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.date ? { collectionAt: { gte: startOfLocalDay(q.date, tz), lt: endOfLocalDay(q.date, tz) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.labBooking.findMany({ where, select: BOOKING, orderBy: { collectionAt: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.labBooking.count({ where }),
    ]);
    return { items: rows.map(toBookingView), total };
  }

  async cancel(ctx: RequestContext, id: string, reason: string) {
    return this.prisma.$transaction(async (tx: Db) => {
      const existing = await tx.labBooking.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (existing.status !== "BOOKED") throw new DomainError("INVALID_STATE", "Only a booked lab booking can be cancelled", 409);
      const res = await tx.labBooking.updateMany({ where: { id, tenantId: ctx.tenantId, status: "BOOKED" }, data: { status: "CANCELLED", cancelReason: reason, version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This booking was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "LAB_BOOKING_CANCELLED", entityType: "LabBooking", entityId: id, metadata: { reason } });
      return toBookingView(await tx.labBooking.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: BOOKING }));
    });
  }
}
