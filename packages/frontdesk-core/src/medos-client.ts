import { DomainError, type ErrorCode } from "@medos/shared";
import type { AppointmentInput, AppointmentOut, DoctorPick, FrontDeskPort, PricedTestMatch, LabBookingInput, LabBookingOut, LabPick, PatientInput, Slot } from "./port";

export interface MedosConfig {
  /** e.g. http://127.0.0.1:4000/api/v1 */
  baseUrl: string;
  tenantCode: string;
  /** The app's own MedOS user (a narrow service role), never a person's login. */
  identifier: string;
  password: string;
  timeoutMs?: number;
}

export interface PatientHit { id: string; name: string; mrn: string | null; ageYears: number | null; sex: string | null; mobileLast4: string | null }

/**
 * The voicebot app and the OCR app reach MedOS only through this client: HTTP calls to the front-desk API, as the app's own MedOS user.
 * MedOS enforces that user's permissions, keeps the audit trail and applies idempotency, so a bug here cannot book what the user may not.
 */
export class MedosClient implements FrontDeskPort {
  private token: string | null = null;
  private perms = new Set<string>();
  private tz = "Asia/Kolkata";
  private userName = "";

  private constructor(private readonly cfg: MedosConfig) {}

  /** Signs in and learns the hospital's time zone and what this user may do. */
  static async connect(cfg: MedosConfig): Promise<MedosClient> {
    const c = new MedosClient(cfg);
    await c.refreshContext();
    return c;
  }

  get user(): string { return this.userName; }
  get baseUrl(): string { return this.cfg.baseUrl; }

  private async login(): Promise<void> {
    const r = await this.raw("POST", "/auth/login", { tenantCode: this.cfg.tenantCode, identifier: this.cfg.identifier, password: this.cfg.password }, false);
    const token = (r as { tokens?: { accessToken?: string } }).tokens?.accessToken;
    if (!token) throw new DomainError("INTERNAL_ERROR", "MedOS did not return a sign-in token", 502);
    this.token = token;
  }

  async refreshContext(): Promise<void> {
    const ctx = await this.call<{ timezone: string; permissions: string[]; userName: string }>("GET", "/frontdesk/context");
    this.tz = ctx.timezone; this.perms = new Set(ctx.permissions); this.userName = ctx.userName;
  }

  private async raw(method: string, path: string, body?: unknown, auth = true, binary?: { data: Buffer; contentType: string }): Promise<unknown> {
    let r: Response;
    try {
      r = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        method, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
        headers: { ...(binary ? { "content-type": binary.contentType } : body !== undefined ? { "content-type": "application/json" } : {}), "x-medos-csrf": "1", ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: binary ? new Uint8Array(binary.data) : body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new DomainError("INTERNAL_ERROR", "MedOS is not reachable right now", 503, { reason: e instanceof Error ? e.message : "unknown" });
    }
    const json = (await r.json().catch(() => ({}))) as { data?: unknown; error?: { code?: string; message?: string; details?: unknown } };
    if (r.status === 401 && auth) { const e = new DomainError("UNAUTHENTICATED", "MedOS session ended", 401); throw e; }
    if (!r.ok) throw new DomainError((json.error?.code ?? "INTERNAL_ERROR") as ErrorCode, json.error?.message ?? `MedOS answered HTTP ${r.status}`, r.status);
    return json.data;
  }

  /** One authenticated call; signs in first, and signs in again once if the token has expired. */
  private async call<T>(method: string, path: string, body?: unknown, binary?: { data: Buffer; contentType: string }): Promise<T> {
    if (!this.token) await this.login();
    try { return (await this.raw(method, path, body, true, binary)) as T; }
    catch (e) {
      if (e instanceof DomainError && e.httpStatus === 401) { await this.login(); return (await this.raw(method, path, body, true, binary)) as T; }
      throw e;
    }
  }

  // ───── FrontDeskPort ─────

  can(permission: string): boolean { return this.perms.has(permission); }
  async timezone(): Promise<string> { return this.tz; }
  findTests(text: string): Promise<PricedTestMatch[]> { return this.call("POST", "/frontdesk/tests/match", { text: text.slice(0, 4000) }); }
  labTests(ids: string[]): Promise<LabPick[]> { return ids.length ? this.call("POST", "/frontdesk/tests/lookup", { ids }) : Promise.resolve([]); }
  doctors(): Promise<DoctorPick[]> { return this.call("GET", "/frontdesk/doctors"); }
  departments(): Promise<string[]> { return this.call("GET", "/frontdesk/departments"); }
  availability(doctorId: string, date: string): Promise<Slot[]> { return this.call("GET", `/frontdesk/availability?doctorId=${encodeURIComponent(doctorId)}&date=${encodeURIComponent(date)}`); }
  resolvePatient(ref: string, patient: PatientInput): Promise<{ patientId: string; mrn: string | null }> { return this.call("POST", "/frontdesk/patients/resolve", { ref, ...patient }); }
  async patientExists(patientId: string): Promise<boolean> {
    try { return (await this.call<{ exists: boolean }>("GET", `/frontdesk/patients/${encodeURIComponent(patientId)}/exists`)).exists; }
    catch (e) { if (e instanceof DomainError && e.httpStatus === 404) return false; throw e; }
  }
  bookLab(input: LabBookingInput): Promise<LabBookingOut> { return this.call("POST", "/frontdesk/lab-bookings", input); }
  bookAppointment(input: AppointmentInput): Promise<AppointmentOut> { return this.call("POST", "/frontdesk/appointments", input); }
  storePrescription(input: { patientId: string; filename: string; contentType: string; data: Buffer }): Promise<{ fileId: string }> {
    return this.call("POST", `/frontdesk/prescriptions?patientId=${encodeURIComponent(input.patientId)}&filename=${encodeURIComponent(input.filename)}`, undefined, { data: input.data, contentType: input.contentType });
  }
  async recordScan(input: { patientId: string | null; metadata: Record<string, unknown> }): Promise<void> { await this.call("POST", "/frontdesk/prescription-scans", input); }

  // ───── beyond the port: finding the patient named on a paper ─────

  searchPatients(q: string): Promise<PatientHit[]> { return this.call("GET", `/frontdesk/patients/search?q=${encodeURIComponent(q)}`); }
}
