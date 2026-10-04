import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly, endOfLocalDay, formatHm, localDateStr, localMinutes, localParts, parseHm, startOfLocalDay, zonedToUtc } from "../../common/time";
import { EncountersService, toEncounterView } from "../encounters/encounters.service";
import { NumberingService } from "../numbering/numbering.service";

export type AppointmentStatusName = "BOOKED" | "CHECKED_IN" | "WAITING" | "IN_CONSULTATION" | "COMPLETED" | "NO_SHOW" | "CANCELLED";

/** Single source of truth for appointment transitions (mirrored by a database trigger). */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatusName, readonly AppointmentStatusName[]> = {
  BOOKED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["WAITING", "CANCELLED"],
  WAITING: ["IN_CONSULTATION", "CANCELLED"],
  IN_CONSULTATION: ["COMPLETED"],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
};
export const LIVE_STATUSES: AppointmentStatusName[] = ["BOOKED", "CHECKED_IN", "WAITING", "IN_CONSULTATION"];

export function canTransition(from: AppointmentStatusName, to: AppointmentStatusName): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to);
}

// ───────────────────────── schemas ─────────────────────────

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const reason = z.string().trim().min(3).max(240);
const hm = z.string().transform((s, c) => {
  const m = parseHm(s);
  if (m === null) c.addIssue({ code: "custom", message: "Use HH:MM (24h)" });
  return m ?? 0;
});

export const scheduleSchema = z.object({
  windows: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6), start: hm, end: hm, slotMinutes: z.number().int().min(5).max(120).default(15),
  }).strict()).max(28),
}).strict().superRefine((v, c) => {
  v.windows.forEach((w, i) => { if (w.start >= w.end) c.addIssue({ code: "custom", path: ["windows", i, "end"], message: "End must be after start" }); });
  for (let d = 0; d < 7; d++) {
    const day = v.windows.map((w, i) => ({ ...w, i })).filter((w) => w.dayOfWeek === d).sort((a, b) => a.start - b.start);
    for (let k = 1; k < day.length; k++) {
      if ((day[k] as { start: number }).start < (day[k - 1] as { end: number }).end) c.addIssue({ code: "custom", path: ["windows", (day[k] as { i: number }).i], message: "Overlaps another window on the same day" });
    }
  }
});

const overbook = z.object({ reason }).strict();

export const createAppointmentSchema = z.object({
  patientId: uuid, practitionerId: uuid, startAt: instant,
  durationMinutes: z.number().int().min(5).max(240).default(15),
  type: z.enum(["CONSULTATION", "FOLLOW_UP", "PROCEDURE"]).default("CONSULTATION"),
  notes: z.string().trim().max(500).optional(),
  overbook: overbook.optional(),
}).strict();

export const rescheduleSchema = z.object({
  version: z.number().int().min(1), startAt: instant.optional(), durationMinutes: z.number().int().min(5).max(240).optional(),
  practitionerId: uuid.optional(), overbook: overbook.optional(),
}).strict().refine((v) => v.startAt || v.durationMinutes || v.practitionerId, "Nothing to change");

export const cancelSchema = z.object({ reason }).strict();

export const walkInSchema = z.object({
  patientId: uuid, practitionerId: uuid,
  type: z.enum(["CONSULTATION", "FOLLOW_UP", "PROCEDURE"]).default("CONSULTATION"),
  priority: z.enum(["NORMAL", "PRIORITY", "EMERGENCY"]).default("NORMAL"),
  notes: z.string().trim().max(500).optional(),
}).strict();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(dateOnly(s).getTime()) && dateOnly(s).toISOString().slice(0, 10) === s, "Invalid date");
export const listAppointmentsSchema = z.object({
  date: ymd.optional(), practitionerId: uuid.optional(), patientId: uuid.optional(),
  status: z.enum(["BOOKED", "CHECKED_IN", "WAITING", "IN_CONSULTATION", "COMPLETED", "NO_SHOW", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const availabilitySchema = z.object({ date: ymd }).strict();

// ───────────────────────── views ─────────────────────────

const VIEW = {
  id: true, startAt: true, endAt: true, status: true, type: true, source: true, notes: true, overbooked: true, overbookReason: true,
  cancelReason: true, encounterId: true, version: true, patientId: true, practitionerId: true, departmentId: true,
  patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  practitioner: { select: { displayName: true } },
  department: { select: { name: true } },
} satisfies Prisma.AppointmentSelect;
type Row = Prisma.AppointmentGetPayload<{ select: typeof VIEW }>;

export function toAppointmentView(a: Row) {
  const { patient, practitioner, department, ...rest } = a;
  return {
    ...rest,
    patientName: [patient.firstName, patient.lastName].filter(Boolean).join(" "),
    mrn: patient.identifiers[0]?.value ?? null,
    practitionerName: practitioner.displayName,
    departmentName: department?.name ?? null,
  };
}

function isConstraintViolation(e: unknown, name: string): boolean {
  return e instanceof Error && e.message.includes(name);
}

// ───────────────────────── service ─────────────────────────

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encounters: EncountersService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Serialises concurrent bookings that touch the same practitioner or patient. The exclusion constraints still
   * guarantee correctness; the advisory locks (released at commit) prevent them from deadlocking each other.
   */
  private async lockBooking(tx: Db, ...keys: string[]): Promise<void> {
    for (const k of [...new Set(keys)].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
  }

  private async tz(db: Db, ctx: RequestContext): Promise<string> {
    const f = await db.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    return f.timezone;
  }

  // ───── schedules ─────

  async getSchedule(ctx: RequestContext, practitionerId: string) {
    await this.assertPractitioner(this.prisma, ctx, practitionerId, false);
    const rows = await this.prisma.practitionerSchedule.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE" },
      orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
    });
    return rows.map((r) => ({ dayOfWeek: r.dayOfWeek, start: formatHm(r.startMinute), end: formatHm(r.endMinute), slotMinutes: r.slotMinutes }));
  }

  async setSchedule(ctx: RequestContext, practitionerId: string, input: z.infer<typeof scheduleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertPractitioner(tx, ctx, practitionerId, false);
      await tx.practitionerSchedule.updateMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE" }, data: { status: "INACTIVE" } });
      if (input.windows.length) {
        await tx.practitionerSchedule.createMany({
          data: input.windows.map((w) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, dayOfWeek: w.dayOfWeek, startMinute: w.start, endMinute: w.end, slotMinutes: w.slotMinutes })),
        });
      }
      await this.audit.record(tx, actorOf(ctx), { action: "PRACTITIONER_SCHEDULE_REPLACED", entityType: "Practitioner", entityId: practitionerId, metadata: { windows: input.windows.length } });
      return input.windows.map((w) => ({ dayOfWeek: w.dayOfWeek, start: formatHm(w.start), end: formatHm(w.end), slotMinutes: w.slotMinutes }));
    });
  }

  async availability(ctx: RequestContext, practitionerId: string, date: string) {
    const tz = await this.tz(this.prisma, ctx);
    await this.assertPractitioner(this.prisma, ctx, practitionerId, true);
    const weekday = localParts(zonedToUtc(date, 12 * 60, tz), tz).weekday;
    const windows = await this.prisma.practitionerSchedule.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE", dayOfWeek: weekday }, orderBy: { startMinute: "asc" },
    });
    const dayStart = startOfLocalDay(date, tz);
    const dayEnd = endOfLocalDay(date, tz);
    const booked = await this.prisma.appointment.findMany({
      where: { tenantId: ctx.tenantId, practitionerId, overbooked: false, status: { in: LIVE_STATUSES }, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      select: { startAt: true, endAt: true },
    });
    const now = Date.now();
    const slots: { startAt: string; endAt: string; available: boolean }[] = [];
    for (const w of windows) {
      for (let m = w.startMinute; m + w.slotMinutes <= w.endMinute; m += w.slotMinutes) {
        const s = zonedToUtc(date, m, tz);
        const e = zonedToUtc(date, m + w.slotMinutes, tz);
        const taken = booked.some((b) => b.startAt < e && b.endAt > s);
        slots.push({ startAt: s.toISOString(), endAt: e.toISOString(), available: !taken && s.getTime() >= now });
      }
    }
    return slots;
  }

  // ───── queries ─────

  async list(ctx: RequestContext, q: z.infer<typeof listAppointmentsSchema>) {
    const tz = await this.tz(this.prisma, ctx);
    const date = q.date ?? localDateStr(new Date(), tz);
    const where: Prisma.AppointmentWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId,
      startAt: { gte: startOfLocalDay(date, tz), lt: endOfLocalDay(date, tz) },
      ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.appointment.findMany({ where, select: VIEW, orderBy: { startAt: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.appointment.count({ where }),
    ]);
    return { items: rows.map(toAppointmentView), total };
  }

  async get(ctx: RequestContext, id: string) {
    const a = await this.prisma.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: VIEW });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return toAppointmentView(a);
  }

  // ───── commands ─────

  async create(ctx: RequestContext, input: z.infer<typeof createAppointmentSchema>) {
    this.assertOverbookAllowed(ctx, input.overbook);
    this.assertNotInPast(input.startAt);
    const endAt = new Date(input.startAt.getTime() + input.durationMinutes * 60_000);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockBooking(tx, `practitioner:${input.practitionerId}`, `patient:${input.patientId}`);
        const tz = await this.tz(tx, ctx);
        const practitioner = await this.assertPractitioner(tx, ctx, input.practitionerId, true);
        await this.assertPatient(tx, ctx, input.patientId);
        if (!input.overbook) await this.assertWithinSchedule(tx, ctx, input.practitionerId, input.startAt, endAt, tz);
        const a = await tx.appointment.create({
          data: {
            tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, practitionerId: input.practitionerId,
            departmentId: practitioner.departmentId, startAt: input.startAt, endAt, type: input.type, notes: input.notes ?? null,
            overbooked: !!input.overbook, overbookReason: input.overbook?.reason ?? null, createdById: ctx.userId,
          },
          select: VIEW,
        });
        await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_CREATED", entityType: "Appointment", entityId: a.id, metadata: { practitionerId: input.practitionerId, startAt: input.startAt.toISOString() } });
        if (input.overbook) {
          await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_OVERBOOKED", entityType: "Appointment", entityId: a.id, metadata: { reason: input.overbook.reason } });
        }
        return toAppointmentView(a);
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  async reschedule(ctx: RequestContext, id: string, input: z.infer<typeof rescheduleSchema>) {
    this.assertOverbookAllowed(ctx, input.overbook);
    if (input.startAt) this.assertNotInPast(input.startAt);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tz = await this.tz(tx, ctx);
        const existing = await tx.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
        if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        if (existing.status !== "BOOKED") throw new DomainError("APPOINTMENT_INVALID_STATE", "Only booked appointments can be rescheduled", 409);
        await this.lockBooking(tx, `practitioner:${existing.practitionerId}`, `practitioner:${input.practitionerId ?? existing.practitionerId}`, `patient:${existing.patientId}`);
        const practitionerId = input.practitionerId ?? existing.practitionerId;
        const practitioner = await this.assertPractitioner(tx, ctx, practitionerId, true);
        const startAt = input.startAt ?? existing.startAt;
        const duration = input.durationMinutes ?? Math.round((existing.endAt.getTime() - existing.startAt.getTime()) / 60_000);
        const endAt = new Date(startAt.getTime() + duration * 60_000);
        if (!input.overbook) await this.assertWithinSchedule(tx, ctx, practitionerId, startAt, endAt, tz);
        const res = await tx.appointment.updateMany({
          where: { id, tenantId: ctx.tenantId, status: "BOOKED", version: input.version },
          data: {
            startAt, endAt, practitionerId, departmentId: practitioner.departmentId,
            overbooked: !!input.overbook, overbookReason: input.overbook?.reason ?? null, version: { increment: 1 },
          },
        });
        if (res.count !== 1) throw new DomainError("STALE_VERSION", "This appointment was changed by someone else. Reload and try again.", 409);
        await this.audit.record(tx, actorOf(ctx), {
          action: "APPOINTMENT_RESCHEDULED", entityType: "Appointment", entityId: id,
          metadata: { from: { startAt: existing.startAt.toISOString(), practitionerId: existing.practitionerId }, to: { startAt: startAt.toISOString(), practitionerId } },
        });
        return toAppointmentView(await tx.appointment.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { queueEntry: true } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const from = existing.status as AppointmentStatusName;
      if (!canTransition(from, "CANCELLED")) throw new DomainError("APPOINTMENT_INVALID_STATE", `A ${from.replace("_", " ").toLowerCase()} appointment cannot be cancelled`, 409);
      const res = await tx.appointment.updateMany({ where: { id, tenantId: ctx.tenantId, status: from }, data: { status: "CANCELLED", cancelReason: input.reason, version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("APPOINTMENT_INVALID_STATE", "Appointment was changed by someone else", 409);
      if (existing.queueEntry) {
        const q = await tx.queueEntry.updateMany({ where: { id: existing.queueEntry.id, tenantId: ctx.tenantId, status: { in: ["WAITING", "CALLED", "SKIPPED"] } }, data: { status: "CANCELLED", version: { increment: 1 } } });
        if (q.count !== 1) throw new DomainError("APPOINTMENT_INVALID_STATE", "The patient is already in consultation", 409);
      }
      if (existing.encounterId) await this.encounters.transition(tx, ctx, existing.encounterId, "CANCELLED", input.reason);
      await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_CANCELLED", entityType: "Appointment", entityId: id, metadata: { from, reason: input.reason } });
      return toAppointmentView(await tx.appointment.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  async markNoShow(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!canTransition(existing.status as AppointmentStatusName, "NO_SHOW")) throw new DomainError("APPOINTMENT_INVALID_STATE", "Only booked appointments can be marked as no-show", 409);
      if (existing.startAt.getTime() > Date.now()) throw new DomainError("APPOINTMENT_INVALID_STATE", "The appointment time has not arrived yet", 409);
      const res = await tx.appointment.updateMany({ where: { id, tenantId: ctx.tenantId, status: "BOOKED" }, data: { status: "NO_SHOW", version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("APPOINTMENT_INVALID_STATE", "Appointment was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_NO_SHOW", entityType: "Appointment", entityId: id });
      return toAppointmentView(await tx.appointment.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  /** BOOKED -> CHECKED_IN -> WAITING, opening the OPD encounter and queue token in one transaction. */
  async checkIn(ctx: RequestContext, id: string, priority: "NORMAL" | "PRIORITY" | "EMERGENCY" = "NORMAL") {
    return this.prisma.$transaction(async (tx) => {
      const tz = await this.tz(tx, ctx);
      const existing = await tx.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (existing.status !== "BOOKED") throw new DomainError("APPOINTMENT_INVALID_STATE", "This appointment is not waiting to be checked in", 409);
      if (localDateStr(existing.startAt, tz) !== localDateStr(new Date(), tz)) {
        throw new DomainError("APPOINTMENT_INVALID_STATE", "Only today's appointments can be checked in", 409);
      }
      return this.checkInCore(tx, ctx, existing, priority, tz);
    });
  }

  /** Walk-in: creates an immediate appointment and checks it in, idempotently (safe against double-clicks). */
  async walkIn(ctx: RequestContext, input: z.infer<typeof walkInSchema>, idempotencyKey: string | undefined) {
    if (input.priority !== "NORMAL" && !ctx.permissions.has("QUEUE_MANAGE")) throw new DomainError("FORBIDDEN", "You do not have permission to set queue priority", 403);
    try {
      const { result, replayed } = await this.idempotency.run(ctx.tenantId, "WALK_IN", idempotencyKey, input, async (tx) => {
        await this.lockBooking(tx, `practitioner:${input.practitionerId}`, `patient:${input.patientId}`);
        const tz = await this.tz(tx, ctx);
        const practitioner = await this.assertPractitioner(tx, ctx, input.practitionerId, true);
        await this.assertPatient(tx, ctx, input.patientId);
        const now = new Date();
        const a = await tx.appointment.create({
          data: {
            tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, practitionerId: input.practitionerId,
            departmentId: practitioner.departmentId, startAt: now, endAt: new Date(now.getTime() + 15 * 60_000), type: input.type,
            source: "WALK_IN", notes: input.notes ?? null, overbooked: true, overbookReason: "Walk-in", createdById: ctx.userId,
          },
        });
        await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_CREATED", entityType: "Appointment", entityId: a.id, metadata: { walkIn: true, practitionerId: input.practitionerId } });
        return this.checkInCore(tx, ctx, a, input.priority, tz);
      });
      return { result, replayed };
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  // ───── internals ─────

  private async checkInCore(
    tx: Db, ctx: RequestContext,
    appt: { id: string; patientId: string; practitionerId: string; departmentId: string | null },
    priority: "NORMAL" | "PRIORITY" | "EMERGENCY", tz: string,
  ) {
    const cas = await tx.appointment.updateMany({ where: { id: appt.id, tenantId: ctx.tenantId, status: "BOOKED" }, data: { status: "CHECKED_IN", version: { increment: 1 } } });
    if (cas.count !== 1) throw new DomainError("APPOINTMENT_INVALID_STATE", "This appointment was already checked in", 409);

    const practitioner = await this.assertPractitioner(tx, ctx, appt.practitionerId, true);
    const departmentId = appt.departmentId ?? practitioner.departmentId;
    const encounter = await this.encounters.openOpd(tx, ctx, { patientId: appt.patientId, practitionerId: appt.practitionerId, departmentId });
    const tokenDate = localDateStr(new Date(), tz);
    const token = await this.numbering.counter(tx, ctx.tenantId, ctx.facilityId, "QUEUE_TOKEN", `${tokenDate}:${appt.practitionerId}`);
    const queue = await tx.queueEntry.create({
      data: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: encounter.id, patientId: appt.patientId,
        practitionerId: appt.practitionerId, departmentId, appointmentId: appt.id, tokenDate: dateOnly(tokenDate),
        tokenNumber: Number(token), priority, createdById: ctx.userId,
      },
    });
    await tx.appointment.updateMany({ where: { id: appt.id, tenantId: ctx.tenantId, status: "CHECKED_IN" }, data: { status: "WAITING", encounterId: encounter.id, version: { increment: 1 } } });
    await this.audit.record(tx, actorOf(ctx), {
      action: "APPOINTMENT_CHECKED_IN", entityType: "Appointment", entityId: appt.id,
      metadata: { encounterId: encounter.id, queueEntryId: queue.id, tokenNumber: queue.tokenNumber, priority },
    });
    const full = await tx.appointment.findFirstOrThrow({ where: { id: appt.id, tenantId: ctx.tenantId }, select: VIEW });
    return {
      appointment: toAppointmentView(full), encounter: toEncounterView(encounter),
      queueEntry: { id: queue.id, tokenNumber: queue.tokenNumber, priority: queue.priority, status: queue.status, practitionerId: queue.practitionerId },
    };
  }

  private async assertPractitioner(db: Db, ctx: RequestContext, practitionerId: string, mustBeActive: boolean) {
    const p = await db.practitioner.findFirst({
      where: { id: practitionerId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(mustBeActive ? { status: "ACTIVE" as const } : {}) },
      select: { id: true, departmentId: true, userId: true },
    });
    if (!p) throw new DomainError("VALIDATION_FAILED", "Practitioner not found or inactive at this facility", 400);
    return p;
  }

  private async assertPatient(db: Db, ctx: RequestContext, patientId: string): Promise<void> {
    const p = await db.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
    if (!p) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
  }

  private assertOverbookAllowed(ctx: RequestContext, overbookInput: unknown): void {
    if (overbookInput && !ctx.permissions.has("APPOINTMENT_OVERBOOK")) {
      throw new DomainError("FORBIDDEN", "You do not have permission to book over an existing appointment", 403);
    }
  }

  private assertNotInPast(startAt: Date): void {
    if (startAt.getTime() < Date.now() - 15 * 60_000) throw new DomainError("VALIDATION_FAILED", "The appointment time is in the past", 400);
  }

  private async assertWithinSchedule(tx: Db, ctx: RequestContext, practitionerId: string, startAt: Date, endAt: Date, tz: string): Promise<void> {
    const windows = await tx.practitionerSchedule.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE" } });
    if (windows.length === 0) return; // no schedule defined: the practitioner is open at any time
    const s = localParts(startAt, tz);
    const sameDay = localDateStr(endAt, tz) === s.dateStr || (localMinutes(endAt, tz) === 0 && endAt.getTime() - startAt.getTime() < 24 * 3600_000);
    const startMin = localMinutes(startAt, tz);
    const endMin = localMinutes(endAt, tz) === 0 ? 1440 : localMinutes(endAt, tz);
    const ok = sameDay && windows.some((w) => w.dayOfWeek === s.weekday && startMin >= w.startMinute && endMin <= w.endMinute);
    if (!ok) throw new DomainError("SLOT_UNAVAILABLE", "The practitioner is not available at that time", 409);
  }

  private mapConflict(e: unknown): unknown {
    if (isConstraintViolation(e, "appointment_no_practitioner_overlap")) {
      return new DomainError("SLOT_UNAVAILABLE", "That time slot is already booked for this practitioner", 409);
    }
    if (isConstraintViolation(e, "appointment_no_patient_overlap")) {
      return new DomainError("SLOT_UNAVAILABLE", "The patient already has an appointment at that time", 409);
    }
    return e;
  }
}
