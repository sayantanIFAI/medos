import { TransientError, type MedosLike, type MedosReply } from "./types";

async function http(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new TransientError(`${init.method ?? "GET"} ${new URL(url).pathname}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface MedosLogin { baseUrl: string; tenantCode: string; identifier: string; password: string }

/** MedOS as the voice bot's own user: a role that can record voice bookings and little else. Logs in again when the short-lived token expires. */
export class MedosClient implements MedosLike {
  private token: string | null = null;
  constructor(private readonly cfg: MedosLogin) {}

  private async login(): Promise<void> {
    const r = await http(`${this.cfg.baseUrl}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantCode: this.cfg.tenantCode, identifier: this.cfg.identifier, password: this.cfg.password }),
    });
    const j = (await r.json().catch(() => ({}))) as { data?: { status?: string; tokens?: { accessToken: string } } };
    if (!r.ok || !j.data?.tokens?.accessToken) {
      if (r.status === 401 || r.status === 400) throw new Error("MedOS refused the voice bot's login. Check MEDOS_BOT_USER and MEDOS_BOT_PASSWORD.");
      throw new TransientError(`MedOS login: HTTP ${r.status}`);
    }
    this.token = j.data.tokens.accessToken;
  }

  private async send(method: "PUT" | "POST", path: string, body: unknown, retried = false): Promise<MedosReply> {
    if (!this.token) await this.login();
    const r = await http(`${this.cfg.baseUrl}${path}`, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` }, body: JSON.stringify(body),
    });
    if (r.status === 401 && !retried) { this.token = null; return this.send(method, path, body, true); }
    const json = (await r.json().catch(() => ({}))) as MedosReply["body"];
    return { status: r.status, body: json };
  }

  putDoctor(ref: string, body: unknown): Promise<MedosReply> { return this.send("PUT", `/integrations/voice/doctors/${encodeURIComponent(ref)}`, body); }
  putBooking(ref: string, body: unknown): Promise<MedosReply> { return this.send("PUT", `/integrations/voice/bookings/${encodeURIComponent(ref)}`, body); }
  cancelBooking(ref: string, reason: string): Promise<MedosReply> { return this.send("POST", `/integrations/voice/bookings/${encodeURIComponent(ref)}/cancel`, { reason }); }
}
