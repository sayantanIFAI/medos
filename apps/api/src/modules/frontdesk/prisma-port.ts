import { Injectable } from "@nestjs/common";
import type {
  AppointmentInput, AppointmentOut, DoctorPick, FrontDeskPort, LabBookingInput, LabBookingOut, LabPick, PatientInput, PricedTestMatch, Slot,
} from "@medos/frontdesk-core";
import { createHash } from "node:crypto";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { AppointmentsService } from "../appointments/appointments.service";
import { FilesService } from "../documents/files.service";
import { VoiceBookingsService } from "../integrations/voice.service";
import { LabService } from "../lab/lab.service";

/**
 * MedOS's own answer to the front-desk port, bound to one signed-in user. Everything is done with that user's rights: the same services,
 * the same tenant and facility scoping, audit lines and idempotency as the screens. The voicebot and OCR apps reach it over HTTP
 * (frontdesk.controller.ts); the built-in Assistant screen uses it directly.
 */
export class PrismaFrontDeskPort implements FrontDeskPort {
  constructor(
    private readonly ctx: RequestContext,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly lab: LabService,
    private readonly appointments: AppointmentsService,
    private readonly voice: VoiceBookingsService,
    private readonly files: FilesService,
  ) {}

  private get scope() { return { tenantId: this.ctx.tenantId, facilityId: this.ctx.facilityId }; }

  can(permission: string): boolean { return (this.ctx.permissions as Set<string>).has(permission); }

  async timezone(): Promise<string> {
    return (await this.prisma.facility.findFirstOrThrow({ where: { id: this.ctx.facilityId, tenantId: this.ctx.tenantId }, select: { timezone: true } })).timezone;
  }

  async findTests(text: string): Promise<PricedTestMatch[]> { return this.lab.findTests(this.ctx, text); }

  async labTests(ids: string[]): Promise<LabPick[]> {
    const rows = await this.prisma.labTest.findMany({ where: { id: { in: ids }, ...this.scope, status: "ACTIVE" } });
    return rows.map((d) => ({ id: d.id, name: d.name, price: d.price.toFixed(2), reportHours: d.reportHours, fastingRequired: d.fastingRequired, prepEn: d.prepEn, prepHi: d.prepHi }));
  }

  async doctors(): Promise<DoctorPick[]> {
    const rows = await this.prisma.practitioner.findMany({ where: { ...this.scope, status: "ACTIVE" }, select: { id: true, displayName: true, department: { select: { name: true } } }, orderBy: { displayName: "asc" } });
    return rows.map((r) => ({ id: r.id, name: r.displayName, departmentName: r.department?.name ?? null }));
  }

  async departments(): Promise<string[]> {
    return (await this.prisma.department.findMany({ where: { ...this.scope, status: "ACTIVE" }, select: { name: true } })).map((d) => d.name);
  }

  async availability(doctorId: string, date: string): Promise<Slot[]> {
    return (await this.appointments.availability(this.ctx, doctorId, date)).map((s) => ({ startAt: s.startAt, endAt: s.endAt, available: s.available }));
  }

  async resolvePatient(ref: string, p: PatientInput): Promise<{ patientId: string; mrn: string | null }> {
    const { patientId } = await this.voice.resolvePatient(this.ctx, ref, { name: p.name, mobile: p.mobile, ageYears: p.ageYears, sex: p.sex } as Parameters<VoiceBookingsService["resolvePatient"]>[2]);
    const mrn = (await this.prisma.patientIdentifier.findFirst({ where: { tenantId: this.ctx.tenantId, patientId, type: "MRN" }, select: { value: true } }))?.value ?? null;
    return { patientId, mrn };
  }

  async patientExists(patientId: string): Promise<boolean> {
    return !!(await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: this.ctx.tenantId, status: "ACTIVE" }, select: { id: true } }));
  }

  async bookLab(i: LabBookingInput): Promise<LabBookingOut> {
    const { booking } = await this.lab.create(
      this.ctx, { patientId: i.patientId, testIds: i.testIds, collectionAt: new Date(i.collectionAt), homeCollection: i.homeCollection, ...(i.notes ? { notes: i.notes } : {}) },
      { source: i.source, fileId: i.fileId ?? null, idempotencyKey: i.idempotencyKey },
    );
    // a replayed booking comes back from storage with its time as text, hence new Date(...)
    return { id: booking.id, totalAmount: booking.totalAmount, collectionAt: new Date(booking.collectionAt).toISOString(), items: booking.items.map((x) => x.name) };
  }

  async bookAppointment(i: AppointmentInput): Promise<AppointmentOut> {
    const existing = await this.prisma.appointment.findFirst({ where: { tenantId: this.ctx.tenantId, externalRef: i.externalRef }, select: { id: true } });
    if (existing) return { id: existing.id };
    const a = await this.appointments.createExternal(this.ctx, {
      patientId: i.patientId, practitionerId: i.doctorId, startAt: new Date(i.startAt), durationMinutes: i.durationMinutes, externalRef: i.externalRef, source: i.source,
      ...(i.notes ? { notes: i.notes } : {}), ...(i.fileId ? { fileId: i.fileId } : {}),
    });
    return { id: a.id };
  }

  async storePrescription(i: { patientId: string; filename: string; contentType: string; data: Buffer }): Promise<{ fileId: string }> {
    // the same paper stored again for the same patient keeps its one copy, so a repeat is recognised and nothing is booked twice
    const sha = createHash("sha256").update(i.data).digest("hex");
    const already = await this.prisma.patientFile.findFirst({ where: { tenantId: this.ctx.tenantId, patientId: i.patientId, sha256: sha, kind: "DOCUMENT", status: "ACTIVE" }, select: { id: true } });
    if (already) return { fileId: already.id };
    const f = await this.files.upload(this.ctx, i.patientId, { kind: "DOCUMENT", filename: i.filename, title: "Prescription (scanned)" }, i.contentType, i.data);
    return { fileId: f.id };
  }

  async recordScan(i: { patientId: string | null; metadata: Record<string, unknown> }): Promise<void> {
    await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(this.ctx), {
      action: "PRESCRIPTION_SCANNED", entityType: i.patientId ? "Patient" : "Facility", entityId: i.patientId ?? this.ctx.facilityId, metadata: i.metadata as Record<string, string | number | boolean | null>,
    }));
  }
}

@Injectable()
export class FrontDeskPorts {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly lab: LabService,
    private readonly appointments: AppointmentsService, private readonly voice: VoiceBookingsService, private readonly files: FilesService,
  ) {}

  forContext(ctx: RequestContext): PrismaFrontDeskPort {
    return new PrismaFrontDeskPort(ctx, this.prisma, this.audit, this.lab, this.appointments, this.voice, this.files);
  }
}
