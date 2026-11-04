import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { parse } from "../../common/http";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { AppointmentsService, scheduleSchema } from "../appointments/appointments.service";
import { normalizeMobile, normalizeName } from "../patients/patient.domain";
import { PatientsService, createPatientSchema } from "../patients/patients.service";

/**
 * The voice bot (BAANI) books the caller itself and tells the caller the confirmation number. This service only RECORDS
 * what the voice bot already did, so the hospital system shows it. It never decides availability and never talks back
 * to the voice bot, which keeps a MedOS outage from ever breaking a phone booking.
 */

const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const text = (max: number) => z.string().trim().min(1).max(max);

/** The voice system's ids are opaque strings such as a confirmation number; they appear in URLs, so keep them tame. */
export const externalRefSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/, "Use letters, digits and . _ : - only (1 to 80 characters)");

export const voiceDoctorSchema = z.object({
  name: text(120),
  department: text(80),
  specialty: text(80).optional(),
  schedule: scheduleSchema,
}).strict();

export const voiceBookingSchema = z.object({
  status: z.enum(["CONFIRMED", "CANCELLED"]),
  /** The voice system's id for the doctor, or the doctor's name exactly as the voice bot spoke it (its booking log carries only the name). */
  doctorRef: externalRefSchema.optional(),
  doctorName: text(120).optional(),
  startAt: instant,
  durationMinutes: z.number().int().min(5).max(240).default(10),
  patient: z.object({
    name: text(120),
    mobile: z.string().trim().max(20).optional(),
    ageYears: z.number().int().min(0).max(130).optional(),
    sex: z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]).optional(),
    address: z.string().trim().max(200).optional(),
  }).strict(),
  notes: z.string().trim().max(300).optional(),
  cancelReason: z.string().trim().min(3).max(240).optional(),
}).strict().refine((v) => v.doctorRef !== undefined || v.doctorName !== undefined, { message: "Give doctorRef or doctorName", path: ["doctorRef"] });

export const voiceCancelSchema = z.object({ reason: z.string().trim().min(3).max(240).default("Cancelled or rescheduled through the voice bot") }).strict();
export type VoiceBooking = z.infer<typeof voiceBookingSchema>;
export type VoiceDoctor = z.infer<typeof voiceDoctorSchema>;

/** "Anita Devi Roy" -> first name "Anita Devi", last name "Roy"; a single word is just a first name. */
export function splitName(full: string): { firstName: string; lastName?: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] as string };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] as string };
}

const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 10) || "DEPT";

@Injectable()
export class VoiceBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly appointments: AppointmentsService,
    private readonly patients: PatientsService,
  ) {}

  // ───── doctors (so a booking has a doctor to land on) ─────

  async upsertDoctor(ctx: RequestContext, ref: string, input: VoiceDoctor) {
    const departmentId = await this.ensureDepartment(ctx, input.department);
    const existing = await this.prisma.practitioner.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, externalRef: ref } });
    let created = false;
    let practitionerId: string;
    if (!existing) {
      const p = await this.prisma.$transaction(async (tx) => {
        const row = await tx.practitioner.create({
          data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, departmentId, displayName: input.name, specialty: input.specialty ?? input.department, externalRef: ref },
        });
        await this.audit.record(tx, actorOf(ctx), { action: "PRACTITIONER_CREATED", entityType: "Practitioner", entityId: row.id, metadata: { source: "VOICE_BOT", externalRef: ref } });
        return row;
      });
      created = true;
      practitionerId = p.id;
    } else {
      practitionerId = existing.id;
      const changed = existing.displayName !== input.name || existing.departmentId !== departmentId || existing.status !== "ACTIVE" || (input.specialty !== undefined && existing.specialty !== input.specialty);
      if (changed) {
        await this.prisma.$transaction(async (tx) => {
          await tx.practitioner.update({
            where: { tenantId_id: { tenantId: ctx.tenantId, id: existing.id } },
            data: { displayName: input.name, departmentId, status: "ACTIVE", ...(input.specialty !== undefined ? { specialty: input.specialty } : {}) },
          });
          await this.audit.record(tx, actorOf(ctx), { action: "PRACTITIONER_UPDATED", entityType: "Practitioner", entityId: existing.id, metadata: { source: "VOICE_BOT" } });
        });
      }
    }
    const scheduleChanged = await this.syncSchedule(ctx, practitionerId, input.schedule);
    return { practitionerId, created, scheduleChanged };
  }

  /** Replaces the weekly windows only when they differ, so a periodic sync leaves no audit noise. */
  private async syncSchedule(ctx: RequestContext, practitionerId: string, schedule: z.infer<typeof scheduleSchema>): Promise<boolean> {
    const current = await this.prisma.practitionerSchedule.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE" },
      select: { dayOfWeek: true, startMinute: true, endMinute: true, slotMinutes: true },
    });
    const key = (w: { dayOfWeek: number; startMinute: number; endMinute: number; slotMinutes: number }) => `${w.dayOfWeek}:${w.startMinute}:${w.endMinute}:${w.slotMinutes}`;
    const want = schedule.windows.map((w) => key({ dayOfWeek: w.dayOfWeek, startMinute: w.start, endMinute: w.end, slotMinutes: w.slotMinutes })).sort();
    const have = current.map(key).sort();
    if (want.length === have.length && want.every((k, i) => k === have[i])) return false;
    await this.appointments.setSchedule(ctx, practitionerId, schedule);
    return true;
  }

  private async ensureDepartment(ctx: RequestContext, name: string): Promise<string> {
    const found = await this.prisma.department.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, name: { equals: name, mode: "insensitive" } } });
    if (found) return found.id;
    const base = `VB-${slug(name)}`;
    for (let n = 0; n < 20; n++) {
      const code = n === 0 ? base : `${base}${n + 1}`;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const d = await tx.department.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, name, code } });
          await this.audit.record(tx, actorOf(ctx), { action: "DEPARTMENT_CREATED", entityType: "Department", entityId: d.id, metadata: { code, source: "VOICE_BOT" } });
          return d.id;
        });
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("Unique constraint"))) throw e;
        const again = await this.prisma.department.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, name: { equals: name, mode: "insensitive" } } });
        if (again) return again.id; // someone created it between our read and write
      }
    }
    throw new DomainError("CONFLICT", "Could not allocate a department code", 409);
  }

  // ───── bookings ─────

  /** Cancels a booking recorded from the voice bot, by its number alone. A number MedOS never saw is "not found" like any unknown id; one already cancelled is left as it is. */
  async cancelBooking(ctx: RequestContext, ref: string, reason: string) {
    const existing = await this.prisma.appointment.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, externalRef: ref }, select: { id: true, status: true } });
    if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (existing.status === "CANCELLED") return { outcome: "unchanged" as const, appointment: await this.appointments.get(ctx, existing.id) };
    if (existing.status !== "BOOKED") throw new DomainError("APPOINTMENT_INVALID_STATE", "The patient has already arrived or been seen, so the cancellation was not applied", 409);
    return { outcome: "cancelled" as const, appointment: await this.appointments.cancel(ctx, existing.id, { reason }) };
  }

  async upsertBooking(ctx: RequestContext, ref: string, input: VoiceBooking) {
    const existing = await this.prisma.appointment.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, externalRef: ref }, select: { id: true, status: true } });

    if (existing) {
      if (input.status === "CANCELLED" && existing.status === "BOOKED") {
        const a = await this.appointments.cancel(ctx, existing.id, { reason: input.cancelReason ?? "Cancelled through the voice bot" });
        return { outcome: "cancelled" as const, appointment: a };
      }
      if (input.status === "CANCELLED" && existing.status !== "CANCELLED") {
        throw new DomainError("APPOINTMENT_INVALID_STATE", "The patient has already arrived or been seen, so the cancellation was not applied", 409);
      }
      return { outcome: "unchanged" as const, appointment: await this.appointments.get(ctx, existing.id) };
    }

    // a cancellation for a booking MedOS never recorded changes nothing
    if (input.status === "CANCELLED") return { outcome: "ignored" as const, appointment: null };

    const practitioner = await this.findDoctor(ctx, input);

    const { patientId, matched } = await this.resolvePatient(ctx, ref, input.patient);
    const appointment = await this.appointments.createExternal(ctx, {
      patientId, practitionerId: practitioner.id, startAt: input.startAt, durationMinutes: input.durationMinutes, externalRef: ref, notes: input.notes,
    });
    return { outcome: "created" as const, appointment, patientMatched: matched };
  }

  /** By the voice system's id when given; otherwise by exact name (ignoring case), which must be unambiguous. */
  private async findDoctor(ctx: RequestContext, input: VoiceBooking): Promise<{ id: string }> {
    const base = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" as const };
    if (input.doctorRef !== undefined) {
      const byRef = await this.prisma.practitioner.findFirst({ where: { ...base, externalRef: input.doctorRef }, select: { id: true } });
      if (byRef) return byRef;
    }
    if (input.doctorName !== undefined) {
      const byName = await this.prisma.practitioner.findMany({ where: { ...base, displayName: { equals: input.doctorName, mode: "insensitive" } }, select: { id: true }, take: 2 });
      if (byName.length === 1) return byName[0] as { id: string };
      if (byName.length > 1) throw new DomainError("DOCTOR_NOT_MAPPED", "More than one doctor in MedOS has this name, so the booking was not placed", 422, { doctorName: input.doctorName });
    }
    throw new DomainError("DOCTOR_NOT_MAPPED", "This doctor is not set up in MedOS yet. Load the voice bot's doctors first.", 422, { doctorRef: input.doctorRef, doctorName: input.doctorName });
  }

  /**
   * Same mobile number and same first name means the same person calling again: reuse that patient. Anything less certain
   * creates a NEW patient and records the override, so reception can review it. A patient is never merged automatically.
   */
  async resolvePatient(ctx: RequestContext, ref: string, p: VoiceBooking["patient"]): Promise<{ patientId: string; matched: boolean }> {
    const { firstName, lastName } = splitName(p.name);
    const mobile = p.mobile ? normalizeMobile(p.mobile) : null;

    if (mobile) {
      const sameMobile = await this.prisma.patient.findMany({
        where: { tenantId: ctx.tenantId, mobile }, select: { id: true, firstName: true, lastName: true }, orderBy: { createdAt: "desc" }, take: 20,
      });
      const wanted = normalizeName(firstName, lastName);
      const sure = sameMobile.find((c) => normalizeName(c.firstName, c.lastName ?? undefined) === wanted)
        ?? sameMobile.find((c) => normalizeName(c.firstName, undefined) === normalizeName(firstName, undefined));
      if (sure) {
        await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "VOICE_PATIENT_MATCHED", entityType: "Patient", entityId: sure.id, metadata: { externalRef: ref } }));
        return { patientId: sure.id, matched: true };
      }
    }

    if (p.ageYears === undefined) {
      throw new DomainError("PATIENT_AGE_REQUIRED", "The voice booking has no age for a new patient. Reception must complete the registration.", 422);
    }
    const body: Record<string, unknown> = {
      firstName, ...(lastName ? { lastName } : {}), gender: p.sex ?? "UNKNOWN", estimatedAgeYears: p.ageYears,
      ...(mobile ? { mobile } : {}), ...(p.address ? { addressLine: p.address } : {}),
      duplicateOverride: { confirmedDistinct: true, reason: "Registered from a voice booking; reception to review possible duplicates" },
    };
    const parsed = parse(createPatientSchema, body);
    const { patient } = await this.patients.create(ctx, parsed, `voice:${ref}`);
    return { patientId: patient.id, matched: false };
  }
}
