import { toBookingBody, toDoctorBody, startsAtMs } from "./map";
import { StateStore } from "./state";
import { TransientError, type MedosLike, type PodLike, type RosterDoctor, type VoiceBooking } from "./types";

export interface BridgeOptions {
  now?: () => number;
  /** A booking whose time has already passed is not recorded (MedOS refuses past appointments). */
  pastGraceMs?: number;
  log?: (line: string) => void;
}

export interface Counts { recorded: number; skipped: number; failed: number }

/**
 * Moves what the voice bot has confirmed into MedOS. It only reads on the pod side and only writes to MedOS, and every write is
 * keyed by the voice bot's own confirmation number, so running it twice, or after the laptop slept, changes nothing it should not.
 * A booking is recorded only while the voice bot's own clinic API still holds it as confirmed. Log lines carry booking numbers and
 * counts only, never names or phone numbers.
 */
export class Bridge {
  private readonly now: () => number;
  private readonly pastGraceMs: number;
  private readonly log: (line: string) => void;
  private lastReconcile = 0;

  constructor(private readonly pod: PodLike, private readonly medos: MedosLike, private readonly store: StateStore, opts: BridgeOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.pastGraceMs = opts.pastGraceMs ?? 2 * 60_000;
    this.log = opts.log ?? ((l) => console.log(l));
  }

  private get s() { return this.store.state; }

  /** Loads the demo roster so each booking has a doctor to land on. Safe to repeat: unchanged doctors and schedules change nothing. */
  async syncDoctors(doctors: RosterDoctor[]): Promise<{ created: number; updated: number; failed: number }> {
    const out = { created: 0, updated: 0, failed: 0 };
    for (const d of doctors) {
      const r = await this.medos.putDoctor(d.ref, toDoctorBody(d));
      if (r.status === 201) out.created++;
      else if (r.status === 200) { if ((r.body.data as { scheduleChanged?: boolean } | undefined)?.scheduleChanged) out.updated++; }
      else if (r.status >= 500 || r.status === 429 || r.status === 401) throw new TransientError(`doctor ${d.ref}: HTTP ${r.status}`);
      else { out.failed++; this.log(`doctor ${d.ref} not loaded: ${r.body.error?.code ?? r.status}`); }
    }
    this.log(`doctors: ${out.created} new, ${out.updated} schedules changed, ${out.failed} failed`);
    return out;
  }

  /** Throws TransientError when the cause is temporary, so the caller stops and tries again later. */
  private async record(b: VoiceBooking): Promise<"recorded" | "failed"> {
    const r = await this.medos.putBooking(b.ref, toBookingBody(b));
    if (r.status >= 200 && r.status < 300) {
      this.s.tracked[b.ref] = { startsAt: startsAtMs(b) };
      delete this.s.failed[b.ref];
      this.log(`${b.ref} recorded (${(r.body.data as { outcome?: string } | undefined)?.outcome ?? r.status})`);
      return "recorded";
    }
    if (r.status >= 500 || r.status === 429 || r.status === 401) throw new TransientError(`${b.ref}: HTTP ${r.status}`);
    this.s.failed[b.ref] = { code: r.body.error?.code ?? String(r.status), message: r.body.error?.message ?? "refused", at: new Date(this.now()).toISOString() };
    this.log(`${b.ref} NOT recorded: ${this.s.failed[b.ref]?.code}`);
    return "failed";
  }

  /** New lines of the voice bot's booking log. The read position moves only after the whole batch is handled, and replays are harmless. */
  async pullNew(): Promise<Counts> {
    const c: Counts = { recorded: 0, skipped: 0, failed: 0 };
    const { bookings, next } = await this.pod.readLog(this.s.logOffset);
    const upcoming = bookings.filter((b) => {
      const past = startsAtMs(b) < this.now() - this.pastGraceMs;
      if (past) c.skipped++;
      return !past;
    });
    const live = upcoming.length ? await this.pod.stillConfirmed(upcoming.map((b) => b.ref)) : new Set<string>();
    for (const b of upcoming) {
      if (!live.has(b.ref)) { c.skipped++; continue; } // cancelled already, or the log line is older than the clinic's database
      c[await this.record(b)]++;
    }
    this.s.logOffset = next;
    this.store.save();
    return c;
  }

  /** Watches recorded upcoming bookings: one the clinic no longer holds as confirmed was cancelled or rescheduled, so it is cancelled here too. */
  async reconcile(everyMs = 60_000): Promise<number> {
    if (this.now() - this.lastReconcile < everyMs) return 0;
    this.lastReconcile = this.now();
    for (const [ref, t] of Object.entries(this.s.tracked)) if (t.startsAt < this.now() - this.pastGraceMs) delete this.s.tracked[ref];
    const refs = Object.keys(this.s.tracked);
    let changed = 0;
    for (let i = 0; i < refs.length; i += 25) {
      const chunk = refs.slice(i, i + 25);
      const live = await this.pod.stillConfirmed(chunk);
      for (const ref of chunk) {
        if (live.has(ref)) continue;
        const r = await this.medos.cancelBooking(ref, "Cancelled or rescheduled through the voice bot");
        if (r.status >= 500 || r.status === 429 || r.status === 401) throw new TransientError(`${ref}: HTTP ${r.status}`);
        if (r.status === 404) delete this.s.tracked[ref]; // MedOS never recorded it, so there is nothing to cancel
        else if (r.status >= 200 && r.status < 300) { delete this.s.tracked[ref]; changed++; this.log(`${ref} cancellation recorded (${(r.body.data as { outcome?: string } | undefined)?.outcome ?? r.status})`); }
        else { delete this.s.tracked[ref]; this.s.failed[ref] = { code: r.body.error?.code ?? String(r.status), message: r.body.error?.message ?? "refused", at: new Date(this.now()).toISOString() }; }
      }
    }
    this.store.save();
    return changed;
  }

  /** One round of everything that is due. Temporary trouble is reported and retried on the next round. */
  async tick(): Promise<void> {
    try {
      const n = await this.pullNew();
      if (n.recorded || n.failed) this.log(`pulled: ${n.recorded} recorded, ${n.skipped} skipped, ${n.failed} not recorded`);
      await this.reconcile();
    } catch (e) {
      if (e instanceof TransientError) this.log(`will retry: ${e.message}`);
      else throw e;
    }
  }
}
