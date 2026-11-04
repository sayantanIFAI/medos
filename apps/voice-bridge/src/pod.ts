import { execFile } from "node:child_process";
import { parseCsv, statusOf, toBooking } from "./csv";
import { TransientError, type PodLike, type VoiceBooking } from "./types";

export interface PodAccess {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

const LOG_FILE = "/workspace/booking_log.csv";
const TOKEN_FILE = "/workspace/.clinic_api_token";
const CLINIC = "http://127.0.0.1:8080";
const REF = /^[A-Za-z0-9._:-]{3,80}$/;

/** Runs one command on the pod and returns what it printed. Each call is a fresh, short SSH connection. */
export function sshRun(p: PodAccess, command: string): Promise<string> {
  const args = [
    "-p", String(p.port), "-i", p.keyPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new",
    `${p.user}@${p.host}`, command,
  ];
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 45_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new TransientError(`ssh to the pod failed: ${err.message.split("\n")[0]}`));
      else resolve(stdout);
    });
  });
}

/**
 * Reads the voice bot's pod WITHOUT changing it: `stat`/`head`/`tail` on the booking log it already writes, and its own
 * `/api/v1/bookings/lookup` endpoint called on the pod itself with the pod's own token (the token never leaves the pod).
 */
export class PodReader implements PodLike {
  constructor(private readonly pod: PodAccess, private readonly slotMinutes = 10, private readonly run: (cmd: string) => Promise<string> = (c) => sshRun(pod, c)) {}

  async readLog(offset: number): Promise<{ bookings: VoiceBooking[]; next: number }> {
    const out = await this.run(
      `F=${LOG_FILE}; if [ -f "$F" ]; then echo "SIZE=$(stat -c %s "$F")"; echo "HEAD=$(head -n 1 "$F" | tr -d '\\r')"; tail -c +${Math.max(0, Math.floor(offset)) + 1} "$F"; else echo SIZE=0; echo HEAD=; fi`,
    );
    const nl1 = out.indexOf("\n");
    const nl2 = out.indexOf("\n", nl1 + 1);
    const size = Number(/^SIZE=(\d+)/.exec(out.slice(0, nl1))?.[1]);
    if (nl1 < 0 || nl2 < 0 || !Number.isFinite(size)) throw new TransientError("the booking log could not be read");
    if (size < offset) return { bookings: [], next: 0 }; // the file was replaced or emptied: start again (replays are harmless)
    const header = out.slice(nl1 + 1, nl2).replace(/^HEAD=/, "").replace(/^﻿/, "").split(",").map((h) => h.trim());
    let data = out.slice(nl2 + 1);
    let bomBytes = 0;
    if (offset === 0 && data.startsWith("﻿")) { data = data.slice(1); bomBytes = 3; } // the byte-order mark is 3 bytes of the file, and counts
    const { records, consumed } = parseCsv(data);
    const bookings: VoiceBooking[] = [];
    for (const rec of records) {
      if (rec[0] === "kind" || rec[0] === "﻿kind") continue; // the header line
      if (statusOf(header, rec) !== "confirmed") continue;
      const b = toBooking(header, rec, this.slotMinutes);
      if (b) bookings.push(b);
    }
    return { bookings, next: offset + bomBytes + Buffer.byteLength(data.slice(0, consumed), "utf8") };
  }

  async stillConfirmed(refs: string[]): Promise<Set<string>> {
    const safe = refs.filter((r) => REF.test(r)); // validated, so nothing here can reach the shell
    if (!safe.length) return new Set();
    const loop = safe.map((r) => `echo "REF=${r}"; curl -s -m 8 -H "Authorization: Bearer $T" "${CLINIC}/api/v1/bookings/lookup?confirmation_id=${r}"; echo`).join("; ");
    const out = await this.run(`T=$(cat ${TOKEN_FILE}); ${loop}`);
    const found = new Set<string>();
    for (const block of out.split(/^REF=/m).slice(1)) {
      const nl = block.indexOf("\n");
      const ref = block.slice(0, nl).trim();
      let body: { found?: boolean; bookings?: { confirmation_id: string }[] };
      try { body = JSON.parse(block.slice(nl + 1).trim()) as typeof body; } catch { throw new TransientError(`the clinic API gave no readable answer for ${ref}`); }
      if (body.found === true && body.bookings?.some((b) => b.confirmation_id === ref)) found.add(ref);
    }
    return found;
  }
}
