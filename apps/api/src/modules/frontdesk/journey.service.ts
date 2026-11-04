import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

/** Who made the booking: the voicebot app, the OCR app, the phone voice bot (BAANI), or staff at a screen. */
export type JourneyVia = "VOICEBOT" | "OCR" | "PHONE_BOT" | "STAFF";
export interface JourneyEvent {
  id: string;
  kind: "APPOINTMENT" | "LAB_BOOKING" | "PRESCRIPTION";
  via: JourneyVia;
  /** When it was recorded in MedOS. */
  at: string;
  /** The time of the visit or sample collection, when there is one. */
  scheduledFor: string | null;
  title: string;
  detail: string;
  status: string;
  reference: string;
  /** The scanned prescription this came from (bookings made by the OCR app), so the journey can group them. */
  fileId: string | null;
}
export interface ActivityEvent extends JourneyEvent { patient: { id: string; name: string; mrn: string | null } }

const shortRef = (id: string) => id.slice(0, 8).toUpperCase();
const viaOf = (source: string): JourneyVia => (source === "VOICE_ASSISTANT" ? "VOICEBOT" : source === "PRESCRIPTION" ? "OCR" : source === "VOICE_BOT" ? "PHONE_BOT" : "STAFF");
const SCANNED_TITLE = "Prescription (scanned)";

/**
 * One patient, one story: the voicebot booking, the scanned prescription, the lab test and the follow-up visit it led to, in time order.
 * Nothing new is stored for this; it reads the bookings and files MedOS already holds and labels where each came from.
 */
@Injectable()
export class JourneyService {
  constructor(private readonly prisma: PrismaService) {}

  private async events(ctx: RequestContext, where: { patientId?: string; recent?: boolean }, take: number): Promise<(JourneyEvent & { patientId: string })[]> {
    const base = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(where.patientId ? { patientId: where.patientId } : {}) };
    const fromApps = where.recent ? { source: { in: ["VOICE_ASSISTANT", "PRESCRIPTION", "VOICE_BOT"] as ("VOICE_ASSISTANT" | "PRESCRIPTION" | "VOICE_BOT")[] } } : {};
    const [appts, labs, files] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { ...base, ...fromApps }, orderBy: { createdAt: "desc" }, take,
        select: { id: true, patientId: true, createdAt: true, startAt: true, status: true, source: true, fileId: true, practitioner: { select: { displayName: true } }, department: { select: { name: true } } },
      }),
      this.prisma.labBooking.findMany({
        where: { ...base, ...(where.recent ? { source: { in: ["VOICE_ASSISTANT", "PRESCRIPTION"] } } : {}) }, orderBy: { createdAt: "desc" }, take,
        select: { id: true, patientId: true, createdAt: true, collectionAt: true, status: true, source: true, fileId: true, totalAmount: true, homeCollection: true, items: { select: { name: true } } },
      }),
      this.prisma.patientFile.findMany({
        where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(where.patientId ? { patientId: where.patientId } : {}), kind: "DOCUMENT", title: SCANNED_TITLE, status: "ACTIVE" },
        orderBy: { uploadedAt: "desc" }, take, select: { id: true, patientId: true, uploadedAt: true, fileName: true },
      }),
    ]);
    const out: (JourneyEvent & { patientId: string })[] = [
      ...appts.map((a) => ({
        id: a.id, patientId: a.patientId, kind: "APPOINTMENT" as const, via: viaOf(a.source), at: a.createdAt.toISOString(), scheduledFor: a.startAt.toISOString(),
        title: `Appointment with ${a.practitioner.displayName}`, detail: a.department?.name ?? "", status: a.status, reference: shortRef(a.id), fileId: a.fileId,
      })),
      ...labs.map((l) => ({
        id: l.id, patientId: l.patientId, kind: "LAB_BOOKING" as const, via: viaOf(l.source), at: l.createdAt.toISOString(), scheduledFor: l.collectionAt.toISOString(),
        title: `Lab: ${l.items.map((i) => i.name).join(", ")}`, detail: `₹${l.totalAmount.toFixed(2)}${l.homeCollection ? ", home collection" : ""}`, status: l.status, reference: shortRef(l.id), fileId: l.fileId,
      })),
      ...files.map((f) => ({
        id: f.id, patientId: f.patientId, kind: "PRESCRIPTION" as const, via: "OCR" as const, at: f.uploadedAt.toISOString(), scheduledFor: null,
        title: "Prescription scanned", detail: f.fileName, status: "STORED", reference: shortRef(f.id), fileId: f.id,
      })),
    ];
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, take);
  }

  /** Everything for one patient, newest first. */
  async forPatient(ctx: RequestContext, patientId: string): Promise<{ patient: { id: string; name: string; mrn: string | null }; events: JourneyEvent[] }> {
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true, firstName: true, lastName: true } });
    if (!p) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    const mrn = (await this.prisma.patientIdentifier.findFirst({ where: { tenantId: ctx.tenantId, patientId, type: "MRN" }, select: { value: true } }))?.value ?? null;
    const events = (await this.events(ctx, { patientId }, 100)).map(({ patientId: _p, ...e }) => e);
    return { patient: { id: p.id, name: [p.firstName, p.lastName].filter(Boolean).join(" "), mrn }, events };
  }

  /** The latest bookings and scans made by the apps, across patients, for the dashboard. */
  async recentFromApps(ctx: RequestContext, limit: number): Promise<ActivityEvent[]> {
    const events = await this.events(ctx, { recent: true }, limit);
    const ids = [...new Set(events.map((e) => e.patientId))];
    const patients = await this.prisma.patient.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId }, select: { id: true, firstName: true, lastName: true } });
    const mrns = await this.prisma.patientIdentifier.findMany({ where: { tenantId: ctx.tenantId, patientId: { in: ids }, type: "MRN" }, select: { patientId: true, value: true } });
    const nameOf = new Map(patients.map((p) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(" ")]));
    const mrnOf = new Map(mrns.map((m) => [m.patientId, m.value]));
    return events.map(({ patientId, ...e }) => ({ ...e, patient: { id: patientId, name: nameOf.get(patientId) ?? "", mrn: mrnOf.get(patientId) ?? null } }));
  }
}
