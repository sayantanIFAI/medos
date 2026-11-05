import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { nameMatchesBySound } from "@medos/frontdesk-core";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { Ctx, parse, RequirePermissions } from "../../common/http";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { JourneyService } from "./journey.service";
import { FrontDeskPorts } from "./prisma-port";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const source = z.enum(["VOICE_ASSISTANT", "PRESCRIPTION"]);
const matchSchema = z.object({ text: z.string().max(4000) }).strict();
const lookupSchema = z.object({ ids: z.array(z.string().uuid()).max(20) }).strict();
const availabilityQuery = z.object({ doctorId: z.string().uuid(), date: dateStr }).strict();
const resolveSchema = z.object({
  ref: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(120), mobile: z.string().trim().max(20).optional(),
  ageYears: z.number().int().min(0).max(130).optional(), sex: z.enum(["MALE", "FEMALE", "UNKNOWN"]).default("UNKNOWN"),
}).strict();
const labBookingSchema = z.object({
  patientId: z.string().uuid(), testIds: z.array(z.string().uuid()).min(1).max(20), collectionAt: z.string().datetime(), homeCollection: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(120), source, fileId: z.string().uuid().nullish(), notes: z.string().max(500).optional(),
}).strict();
const appointmentSchema = z.object({
  patientId: z.string().uuid(), doctorId: z.string().uuid(), startAt: z.string().datetime(), durationMinutes: z.number().int().min(5).max(240),
  externalRef: z.string().trim().min(8).max(120), source, fileId: z.string().uuid().nullish(), notes: z.string().max(500).optional(),
}).strict();
const prescriptionQuery = z.object({ patientId: z.string().uuid(), filename: z.string().trim().max(120).default("prescription") }).strict();
const scanSchema = z.object({ patientId: z.string().uuid().nullable(), metadata: z.record(z.unknown()) }).strict();
const searchQuery = z.object({ q: z.string().trim().min(2).max(60) }).strict();
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(15) }).strict();

/**
 * The front-desk API: what the voicebot app and the OCR app (and the built-in Assistant) may ask of MedOS. Each route does one thing with
 * the caller's own rights; the apps sign in as their own narrow MedOS users, so MedOS's permission checks, tenant scoping, audit trail and
 * idempotency apply to everything they do. The apps never touch the database.
 */
@Controller("frontdesk")
export class FrontDeskController {
  constructor(private readonly ports: FrontDeskPorts, private readonly prisma: PrismaService, private readonly journey: JourneyService) {}

  /** The hospital's time zone and what this caller may do, so an app can say "your account cannot book" before trying. */
  @RequirePermissions("ASSISTANT_USE")
  @Get("context")
  async context(@Ctx() ctx: RequestContext) {
    const port = this.ports.forContext(ctx);
    const user = await this.prisma.user.findFirst({ where: { id: ctx.userId, tenantId: ctx.tenantId }, select: { fullName: true } });
    return { data: { timezone: await port.timezone(), permissions: [...ctx.permissions], userName: user?.fullName ?? "" } };
  }

  @RequirePermissions("ASSISTANT_USE", "LAB_READ")
  @Post("tests/match") @HttpCode(200)
  async matchTests(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ports.forContext(ctx).findTests(parse(matchSchema, body).text) }; }

  @RequirePermissions("ASSISTANT_USE", "LAB_READ")
  @Post("tests/lookup") @HttpCode(200)
  async lookupTests(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ports.forContext(ctx).labTests(parse(lookupSchema, body).ids) }; }

  @RequirePermissions("ASSISTANT_USE", "APPOINTMENT_READ")
  @Get("doctors")
  async doctors(@Ctx() ctx: RequestContext) { return { data: await this.ports.forContext(ctx).doctors() }; }

  @RequirePermissions("ASSISTANT_USE", "APPOINTMENT_READ")
  @Get("departments")
  async departments(@Ctx() ctx: RequestContext) { return { data: await this.ports.forContext(ctx).departments() }; }

  @RequirePermissions("ASSISTANT_USE", "APPOINTMENT_READ")
  @Get("availability")
  async availability(@Ctx() ctx: RequestContext, @Query() query: unknown) { const q = parse(availabilityQuery, query); return { data: await this.ports.forContext(ctx).availability(q.doctorId, q.date) }; }

  @RequirePermissions("ASSISTANT_USE", "PATIENT_READ", "PATIENT_CREATE")
  @Post("patients/resolve") @HttpCode(200)
  async resolve(@Ctx() ctx: RequestContext, @Body() body: unknown) { const b = parse(resolveSchema, body); return { data: await this.ports.forContext(ctx).resolvePatient(b.ref, b) }; }

  @RequirePermissions("ASSISTANT_USE", "PATIENT_READ")
  @Get("patients/search")
  async searchPatients(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const { q } = parse(searchQuery, query);
    const byIdent = await this.prisma.patientIdentifier.findMany({ where: { tenantId: ctx.tenantId, type: "MRN", value: { contains: q, mode: "insensitive" } }, select: { patientId: true }, take: 8 });
    const words = q.split(/\s+/).filter(Boolean);
    const select = { id: true, firstName: true, lastName: true, estimatedAgeYears: true, mobile: true } as const;
    const rows = await this.prisma.patient.findMany({
      where: {
        tenantId: ctx.tenantId, status: "ACTIVE",
        OR: [{ id: { in: byIdent.map((x) => x.patientId) } }, { mobile: { contains: q.replace(/\D/g, "") || "no-digits" } }, { AND: words.map((w) => ({ OR: [{ firstName: { contains: w, mode: "insensitive" as const } }, { lastName: { contains: w, mode: "insensitive" as const } }] })) }],
      },
      select, orderBy: { createdAt: "desc" }, take: 8,
    });
    // A name typed in English letters ("pavan") must also find the same name saved in Devanagari ("पवन"), and the other way round: match by sound.
    if (rows.length < 8 && /\p{L}/u.test(q)) {
      const seen = new Set(rows.map((r) => r.id));
      const pool = await this.prisma.patient.findMany({ where: { tenantId: ctx.tenantId, status: "ACTIVE" }, select, orderBy: { createdAt: "desc" }, take: 5000 });
      for (const p of pool) {
        if (rows.length >= 8) break;
        if (!seen.has(p.id) && nameMatchesBySound(q, [p.firstName, p.lastName].filter(Boolean).join(" "))) rows.push(p);
      }
    }
    const mrns = await this.prisma.patientIdentifier.findMany({ where: { tenantId: ctx.tenantId, type: "MRN", patientId: { in: rows.map((r) => r.id) } }, select: { patientId: true, value: true } });
    const mrnOf = new Map(mrns.map((m) => [m.patientId, m.value]));
    return { data: rows.map((r) => ({ id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(" "), mrn: mrnOf.get(r.id) ?? null, ageYears: r.estimatedAgeYears, sex: null, mobileLast4: r.mobile ? r.mobile.slice(-4) : null })) };
  }

  @RequirePermissions("ASSISTANT_USE", "PATIENT_READ")
  @Get("patients/:id/exists")
  async exists(@Ctx() ctx: RequestContext, @Param("id", new ParseUUIDPipe()) id: string) {
    // an unknown or other hospital's patient is a plain 404, like every other route with an id
    if (!(await this.ports.forContext(ctx).patientExists(id))) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    return { data: { exists: true } };
  }

  @RequirePermissions("ASSISTANT_USE", "LAB_BOOK")
  @Post("lab-bookings") @HttpCode(200)
  async bookLab(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ports.forContext(ctx).bookLab(parse(labBookingSchema, body)) }; }

  @RequirePermissions("ASSISTANT_USE", "APPOINTMENT_CREATE")
  @Post("appointments") @HttpCode(200)
  async bookAppointment(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ports.forContext(ctx).bookAppointment(parse(appointmentSchema, body)) }; }

  /** The scanned picture or PDF, kept with the patient (the request body is the file). */
  @RequirePermissions("ASSISTANT_USE", "PATIENT_UPDATE")
  @Post("prescriptions") @HttpCode(200)
  async storePrescription(@Ctx() ctx: RequestContext, @Query() query: unknown, @Headers("content-type") contentType: string | undefined, @Req() req: Request) {
    const q = parse(prescriptionQuery, query);
    return { data: await this.ports.forContext(ctx).storePrescription({ patientId: q.patientId, filename: q.filename, contentType: (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "", data: req.body as Buffer }) };
  }

  @RequirePermissions("ASSISTANT_USE")
  @Post("prescription-scans") @HttpCode(200)
  async recordScan(@Ctx() ctx: RequestContext, @Body() body: unknown) { const b = parse(scanSchema, body); await this.ports.forContext(ctx).recordScan({ patientId: b.patientId, metadata: b.metadata }); return { data: { recorded: true } }; }

  // ───── the patient journey ─────

  @RequirePermissions("PATIENT_READ", "APPOINTMENT_READ", "LAB_READ")
  @Get("journey/:patientId")
  async patientJourney(@Ctx() ctx: RequestContext, @Param("patientId", new ParseUUIDPipe()) patientId: string) { return { data: await this.journey.forPatient(ctx, patientId) }; }

  /** The latest bookings and scans made by the apps, for the dashboard. */
  @RequirePermissions("PATIENT_READ", "APPOINTMENT_READ", "LAB_READ")
  @Get("activity")
  async activity(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.journey.recentFromApps(ctx, parse(activityQuery, query).limit) }; }
}
