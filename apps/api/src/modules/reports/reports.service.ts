import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly, endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";
import { balanceDue, fmt } from "../billing/billing.domain";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(dateOnly(s).getTime()) && dateOnly(s).toISOString().startsWith(s), "Invalid date");
const MAX_DAYS = 93;

export const rangeSchema = z.object({ from: day.optional(), to: day.optional() }).strict();
export const expirySchema = z.object({ withinDays: z.coerce.number().int().min(1).max(730).default(90) }).strict();
export const outstandingSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();

interface Range { from: string; to: string; start: Date; end: Date; tz: string }

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Facility-local calendar range (default: today). Bounds are converted to UTC instants once. */
  private async range(ctx: RequestContext, q: z.infer<typeof rangeSchema>): Promise<Range> {
    const f = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const today = localDateStr(new Date(), f.timezone);
    const from = q.from ?? q.to ?? today;
    const to = q.to ?? q.from ?? today;
    if (from > to) throw new DomainError("VALIDATION_FAILED", "The start date must not be after the end date", 400);
    if ((dateOnly(to).getTime() - dateOnly(from).getTime()) / 86_400_000 >= MAX_DAYS) throw new DomainError("VALIDATION_FAILED", `Choose a range of at most ${MAX_DAYS} days`, 400);
    return { from, to, start: startOfLocalDay(from, f.timezone), end: endOfLocalDay(to, f.timezone), tz: f.timezone };
  }

  // ───── OPD ─────

  async opdDaily(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.$queryRaw<{ day: string; visits: number; completed: number }[]>`
      SELECT to_char(("startedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed
      FROM "Encounter" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND type = 'OPD' AND status <> 'CANCELLED'
        AND "startedAt" >= ${r.start} AND "startedAt" < ${r.end} GROUP BY 1 ORDER BY 1`;
    return { from: r.from, to: r.to, total: rows.reduce((n, x) => n + x.visits, 0), days: rows };
  }

  async opdByDoctor(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.$queryRaw<{ practitionerId: string | null; doctor: string | null; visits: number; completed: number }[]>`
      SELECT e."practitionerId" AS "practitionerId", p."displayName" AS doctor, COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE e.status = 'COMPLETED')::int AS completed
      FROM "Encounter" e LEFT JOIN "Practitioner" p ON p.id = e."practitionerId" AND p."tenantId" = e."tenantId"
      WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e.type = 'OPD' AND e.status <> 'CANCELLED'
        AND e."startedAt" >= ${r.start} AND e."startedAt" < ${r.end} GROUP BY 1, 2 ORDER BY visits DESC, doctor`;
    return { from: r.from, to: r.to, rows };
  }

  async opdByDepartment(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.$queryRaw<{ departmentId: string | null; department: string | null; visits: number; completed: number }[]>`
      SELECT e."departmentId" AS "departmentId", d.name AS department, COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE e.status = 'COMPLETED')::int AS completed
      FROM "Encounter" e LEFT JOIN "Department" d ON d.id = e."departmentId" AND d."tenantId" = e."tenantId"
      WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e.type = 'OPD' AND e.status <> 'CANCELLED'
        AND e."startedAt" >= ${r.start} AND e."startedAt" < ${r.end} GROUP BY 1, 2 ORDER BY visits DESC, department`;
    return { from: r.from, to: r.to, rows };
  }

  // ───── money ─────

  /** Receipts received minus refunds paid, per local day and per payment mode. Credit notes are not cash and are shown separately. */
  async collections(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const t = ctx.tenantId;
    const f = ctx.facilityId;
    const [received, refunded, byMode, credits] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; amount: string }[]>`
        SELECT to_char(("receivedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(total), 0)::numeric(14,2)::text AS amount
        FROM "Receipt" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "receivedAt" >= ${r.start} AND "receivedAt" < ${r.end} GROUP BY 1`,
      this.prisma.$queryRaw<{ day: string; amount: string }[]>`
        SELECT to_char(("createdAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(amount), 0)::numeric(14,2)::text AS amount
        FROM "Refund" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end} GROUP BY 1`,
      this.prisma.$queryRaw<{ method: string; received: string; refunded: string }[]>`
        SELECT m.method::text AS method, COALESCE(rc.amount, 0)::numeric(14,2)::text AS received, COALESCE(rf.amount, 0)::numeric(14,2)::text AS refunded
        FROM (SELECT unnest(enum_range(NULL::"PaymentMethod")) AS method) m
        LEFT JOIN (SELECT p.method, SUM(p.amount) AS amount FROM "Payment" p JOIN "Receipt" r ON r.id = p."receiptId" AND r."tenantId" = p."tenantId"
                   WHERE r."tenantId" = ${t}::uuid AND r."facilityId" = ${f}::uuid AND r."receivedAt" >= ${r.start} AND r."receivedAt" < ${r.end} GROUP BY p.method) rc ON rc.method = m.method
        LEFT JOIN (SELECT method, SUM(amount) AS amount FROM "Refund" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end} GROUP BY method) rf ON rf.method = m.method
        ORDER BY m.method`,
      this.prisma.$queryRaw<{ amount: string }[]>`
        SELECT COALESCE(SUM(amount), 0)::numeric(14,2)::text AS amount FROM "CreditNote" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}`,
    ]);
    const days = new Map<string, { day: string; received: string; refunded: string }>();
    for (const x of received) days.set(x.day, { day: x.day, received: x.amount, refunded: "0.00" });
    for (const x of refunded) days.set(x.day, { day: x.day, received: days.get(x.day)?.received ?? "0.00", refunded: x.amount });
    const dayRows = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, net: fmt(Number(d.received) - Number(d.refunded)) }));
    const sum = (xs: string[]) => xs.reduce((n, v) => n + Math.round(Number(v) * 100), 0) / 100;
    const totalReceived = sum(byMode.map((m) => m.received));
    const totalRefunded = sum(byMode.map((m) => m.refunded));
    return {
      from: r.from, to: r.to, days: dayRows,
      byMode: byMode.map((m) => ({ ...m, net: fmt(Math.round((Number(m.received) - Number(m.refunded)) * 100) / 100) })),
      totals: { received: fmt(totalReceived), refunded: fmt(totalRefunded), net: fmt(Math.round((totalReceived - totalRefunded) * 100) / 100), creditNotes: credits[0]?.amount ?? "0.00" },
    };
  }

  async shifts(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.$queryRaw<{
      id: string; cashier: string | null; status: string; openedAt: Date; closedAt: Date | null; openingCash: string; receipts: string; cashReceived: string; cashRefunded: string;
      expectedCash: string | null; actualCash: string | null; difference: string | null;
    }[]>`
      SELECT s.id, u."fullName" AS cashier, s.status::text AS status, s."openedAt", s."closedAt", s."openingCash"::numeric(14,2)::text AS "openingCash",
        COALESCE((SELECT SUM(r.total) FROM "Receipt" r WHERE r."shiftId" = s.id AND r."tenantId" = s."tenantId"), 0)::numeric(14,2)::text AS receipts,
        COALESCE((SELECT SUM(p.amount) FROM "Payment" p JOIN "Receipt" r ON r.id = p."receiptId" AND r."tenantId" = p."tenantId" WHERE r."shiftId" = s.id AND r."tenantId" = s."tenantId" AND p.method = 'CASH'), 0)::numeric(14,2)::text AS "cashReceived",
        COALESCE((SELECT SUM(f.amount) FROM "Refund" f WHERE f."shiftId" = s.id AND f."tenantId" = s."tenantId" AND f.method = 'CASH'), 0)::numeric(14,2)::text AS "cashRefunded",
        s."expectedCash"::numeric(14,2)::text AS "expectedCash", s."actualCash"::numeric(14,2)::text AS "actualCash", s.difference::numeric(14,2)::text AS difference
      FROM "CashierShift" s LEFT JOIN "User" u ON u.id = s."cashierId" AND u."tenantId" = s."tenantId"
      WHERE s."tenantId" = ${ctx.tenantId}::uuid AND s."facilityId" = ${ctx.facilityId}::uuid AND s."openedAt" >= ${r.start} AND s."openedAt" < ${r.end} ORDER BY s."openedAt"`;
    return { from: r.from, to: r.to, rows };
  }

  async outstanding(ctx: RequestContext, q: z.infer<typeof outstandingSchema>) {
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: ["ISSUED", "PARTIALLY_PAID"] as ("ISSUED" | "PARTIALLY_PAID")[] } };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where, orderBy: [{ issuedAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        select: { id: true, invoiceNumber: true, issuedAt: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true, patient: { select: { firstName: true, lastName: true } } },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    const items = rows.map((i) => ({
      id: i.id, invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt, patientName: [i.patient.firstName, i.patient.lastName].filter(Boolean).join(" "),
      total: fmt(i.total), balanceDue: fmt(balanceDue(i)),
    }));
    const agg = await this.prisma.$queryRaw<{ due: string }[]>`
      SELECT COALESCE(SUM(GREATEST(0, (total - "creditedTotal") - ("paidTotal" - "refundedTotal"))), 0)::numeric(14,2)::text AS due
      FROM "Invoice" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND status IN ('ISSUED', 'PARTIALLY_PAID')`;
    return { items, total, totalDue: agg[0]?.due ?? "0.00" };
  }

  // ───── IPD ─────

  async currentAdmissions(ctx: RequestContext) {
    const rows = await this.prisma.$queryRaw<{ id: string; admissionNumber: string; patientName: string; mrn: string | null; ward: string | null; bed: string | null; consultant: string | null; admittedAt: Date; days: number }[]>`
      SELECT a.id, a."admissionNumber", trim(p."firstName" || ' ' || COALESCE(p."lastName", '')) AS "patientName",
        (SELECT value FROM "PatientIdentifier" i WHERE i."patientId" = p.id AND i."tenantId" = p."tenantId" AND i.type = 'MRN' LIMIT 1) AS mrn,
        w.name AS ward, b.code AS bed, pr."displayName" AS consultant, a."admittedAt", GREATEST(1, CEIL(EXTRACT(EPOCH FROM (now() - a."admittedAt")) / 86400))::int AS days
      FROM "Admission" a JOIN "Patient" p ON p.id = a."patientId" AND p."tenantId" = a."tenantId"
      LEFT JOIN "BedAssignment" ba ON ba."admissionId" = a.id AND ba."tenantId" = a."tenantId" AND ba."releasedAt" IS NULL
      LEFT JOIN "Bed" b ON b.id = ba."bedId" AND b."tenantId" = a."tenantId" LEFT JOIN "Ward" w ON w.id = b."wardId" AND w."tenantId" = a."tenantId"
      LEFT JOIN "Practitioner" pr ON pr.id = a."consultantId" AND pr."tenantId" = a."tenantId"
      WHERE a."tenantId" = ${ctx.tenantId}::uuid AND a."facilityId" = ${ctx.facilityId}::uuid AND a.status = 'ADMITTED' ORDER BY a."admittedAt"`;
    return { total: rows.length, rows };
  }

  /** Admissions and discharges per local day. Cancelled admissions are excluded. */
  async admissionsAndDischarges(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const [adm, dis] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; count: number }[]>`
        SELECT to_char(("admittedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count FROM "Admission"
        WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND status <> 'CANCELLED' AND "admittedAt" >= ${r.start} AND "admittedAt" < ${r.end} GROUP BY 1`,
      this.prisma.$queryRaw<{ day: string; count: number }[]>`
        SELECT to_char(("dischargedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count FROM "Admission"
        WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND status = 'DISCHARGED' AND "dischargedAt" >= ${r.start} AND "dischargedAt" < ${r.end} GROUP BY 1`,
    ]);
    const days = [...new Set([...adm.map((x) => x.day), ...dis.map((x) => x.day)])].sort();
    return {
      from: r.from, to: r.to, totalAdmissions: adm.reduce((n, x) => n + x.count, 0), totalDischarges: dis.reduce((n, x) => n + x.count, 0),
      days: days.map((d) => ({ day: d, admissions: adm.find((x) => x.day === d)?.count ?? 0, discharges: dis.find((x) => x.day === d)?.count ?? 0 })),
    };
  }

  async bedOccupancy(ctx: RequestContext) {
    const rows = await this.prisma.$queryRaw<{ wardId: string; ward: string; total: number; available: number; occupied: number; reserved: number; cleaning: number; maintenance: number }[]>`
      SELECT w.id AS "wardId", w.name AS ward, COUNT(b.id)::int AS total,
        COUNT(*) FILTER (WHERE b.status = 'AVAILABLE')::int AS available, COUNT(*) FILTER (WHERE b.status = 'OCCUPIED')::int AS occupied,
        COUNT(*) FILTER (WHERE b.status = 'RESERVED')::int AS reserved, COUNT(*) FILTER (WHERE b.status = 'CLEANING')::int AS cleaning,
        COUNT(*) FILTER (WHERE b.status = 'MAINTENANCE')::int AS maintenance
      FROM "Ward" w JOIN "Bed" b ON b."wardId" = w.id AND b."tenantId" = w."tenantId" AND b.active = 'ACTIVE'
      WHERE w."tenantId" = ${ctx.tenantId}::uuid AND w."facilityId" = ${ctx.facilityId}::uuid GROUP BY w.id, w.name ORDER BY w.name`;
    const sum = (k: "total" | "occupied") => rows.reduce((n, x) => n + x[k], 0);
    const total = sum("total");
    const occupied = sum("occupied");
    return { wards: rows.map((x) => ({ ...x, occupancyPercent: x.total ? Math.round((x.occupied / x.total) * 1000) / 10 : 0 })), total, occupied, occupancyPercent: total ? Math.round((occupied / total) * 1000) / 10 : 0 };
  }

  // ───── pharmacy ─────

  async pharmacySales(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const t = ctx.tenantId;
    const f = ctx.facilityId;
    const [days, top] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; dispenses: number; gross: string; returns: string }[]>`
        SELECT to_char((d."dispensedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COUNT(DISTINCT d.id)::int AS dispenses,
          COALESCE(SUM(i."lineTotal"), 0)::numeric(14,2)::text AS gross, COALESCE(SUM(i."returnedQuantity" * i."unitPrice"), 0)::numeric(14,2)::text AS returns
        FROM "Dispense" d JOIN "DispenseItem" i ON i."dispenseId" = d.id AND i."tenantId" = d."tenantId"
        WHERE d."tenantId" = ${t}::uuid AND d."facilityId" = ${f}::uuid AND d."dispensedAt" >= ${r.start} AND d."dispensedAt" < ${r.end} GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ medicineId: string; medicine: string; quantity: number; amount: string }[]>`
        SELECT m.id AS "medicineId", trim(m."brandName" || ' ' || COALESCE(m.strength, '')) AS medicine, SUM(i.quantity - i."returnedQuantity")::int AS quantity,
          COALESCE(SUM((i.quantity - i."returnedQuantity") * i."unitPrice"), 0)::numeric(14,2)::text AS amount
        FROM "Dispense" d JOIN "DispenseItem" i ON i."dispenseId" = d.id AND i."tenantId" = d."tenantId" JOIN "Medicine" m ON m.id = i."medicineId" AND m."tenantId" = d."tenantId"
        WHERE d."tenantId" = ${t}::uuid AND d."facilityId" = ${f}::uuid AND d."dispensedAt" >= ${r.start} AND d."dispensedAt" < ${r.end}
        GROUP BY m.id, m."brandName", m.strength HAVING SUM(i.quantity - i."returnedQuantity") > 0 ORDER BY SUM((i.quantity - i."returnedQuantity") * i."unitPrice") DESC LIMIT 10`,
    ]);
    const cents = (v: string) => Math.round(Number(v) * 100);
    const gross = days.reduce((n, x) => n + cents(x.gross), 0);
    const returns = days.reduce((n, x) => n + cents(x.returns), 0);
    return {
      from: r.from, to: r.to, days: days.map((x) => ({ ...x, net: fmt((cents(x.gross) - cents(x.returns)) / 100) })), topMedicines: top,
      totals: { dispenses: days.reduce((n, x) => n + x.dispenses, 0), gross: fmt(gross / 100), returns: fmt(returns / 100), net: fmt((gross - returns) / 100) },
    };
  }

  async currentStock(ctx: RequestContext) {
    const rows = await this.prisma.$queryRaw<{ medicineId: string; medicine: string; genericName: string; quantity: number; batches: number; reorderLevel: number; value: string }[]>`
      SELECT m.id AS "medicineId", trim(m."brandName" || ' ' || COALESCE(m.strength, '')) AS medicine, m."genericName" AS "genericName",
        COALESCE(SUM(sb.quantity), 0)::int AS quantity, COUNT(sb."batchId") FILTER (WHERE sb.quantity > 0)::int AS batches, m."reorderLevel" AS "reorderLevel",
        COALESCE(SUM(sb.quantity * b."purchasePrice"), 0)::numeric(14,2)::text AS value
      FROM "Medicine" m LEFT JOIN "StockBalance" sb ON sb."medicineId" = m.id AND sb."tenantId" = m."tenantId" AND sb."facilityId" = ${ctx.facilityId}::uuid
      LEFT JOIN "MedicineBatch" b ON b.id = sb."batchId" AND b."tenantId" = sb."tenantId"
      WHERE m."tenantId" = ${ctx.tenantId}::uuid AND m.status = 'ACTIVE' GROUP BY m.id ORDER BY medicine`;
    return { rows, totalValue: fmt(rows.reduce((n, x) => n + Math.round(Number(x.value) * 100), 0) / 100) };
  }

  async lowStock(ctx: RequestContext) {
    const { rows } = await this.currentStock(ctx);
    return { rows: rows.filter((x) => x.reorderLevel > 0 && x.quantity <= x.reorderLevel).map((x) => ({ medicineId: x.medicineId, medicine: x.medicine, quantity: x.quantity, reorderLevel: x.reorderLevel })) };
  }

  /** Batches holding stock that are expired or expire within the window (expired first). */
  async nearExpiry(ctx: RequestContext, q: z.infer<typeof expirySchema>) {
    const f = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const today = localDateStr(new Date(), f.timezone);
    const cutoff = new Date(dateOnly(today).getTime() + q.withinDays * 86_400_000);
    const rows = await this.prisma.$queryRaw<{ batchId: string; medicine: string; batchNo: string; expiryDate: Date; quantity: number; value: string; expired: boolean }[]>`
      SELECT b.id AS "batchId", trim(m."brandName" || ' ' || COALESCE(m.strength, '')) AS medicine, b."batchNo" AS "batchNo", b."expiryDate" AS "expiryDate", sb.quantity AS quantity,
        (sb.quantity * b."purchasePrice")::numeric(14,2)::text AS value, b."expiryDate" < ${dateOnly(today)}::date AS expired
      FROM "StockBalance" sb JOIN "MedicineBatch" b ON b.id = sb."batchId" AND b."tenantId" = sb."tenantId" JOIN "Medicine" m ON m.id = b."medicineId" AND m."tenantId" = b."tenantId"
      WHERE sb."tenantId" = ${ctx.tenantId}::uuid AND sb."facilityId" = ${ctx.facilityId}::uuid AND sb.quantity > 0 AND b."expiryDate" <= ${cutoff}::date ORDER BY b."expiryDate", medicine`;
    return { asOf: today, withinDays: q.withinDays, rows: rows.map((x) => ({ ...x, expiryDate: x.expiryDate.toISOString().slice(0, 10) })) };
  }
}
