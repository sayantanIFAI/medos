import type { VoiceBooking } from "./types";

/**
 * Reads complete CSV records (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes). A record is complete only once its
 * line break has arrived, so a line the voice bot is still writing is left for the next read. `consumed` counts characters.
 */
export function parseCsv(text: string): { records: string[][]; consumed: number } {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let consumed = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      records.push(row);
      row = []; field = ""; consumed = i + 1;
    } else field += c;
  }
  return { records, consumed };
}

const clean = (s: string | undefined): string => (s ?? "").trim();

/** Maps one record to a booking, using the file's own header so a reordered or extended log still reads. Anything that is not a doctor appointment is skipped. */
export function toBooking(header: string[], rec: string[], slotMinutes: number): VoiceBooking | null {
  const at = (name: string) => clean(rec[header.indexOf(name)]);
  if (header.indexOf("confirmation_id") < 0 || at("kind") !== "doctor") return null;
  const age = Number.parseInt(at("age"), 10);
  const ref = at("confirmation_id");
  if (!ref || !at("doctor") || !/^\d{4}-\d{2}-\d{2}$/.test(at("visit_date")) || !/^\d{2}:\d{2}$/.test(at("time_slot"))) return null;
  return {
    ref, doctorName: at("doctor"), department: at("department"), date: at("visit_date"), timeSlot: at("time_slot"), slotMinutes,
    patient: { name: at("patient_name"), age: Number.isFinite(age) ? age : null, sex: at("sex"), address: at("address"), phone: at("patient_phone") || at("caller_phone") },
  };
}

/** The log's status column; a booking is only recorded while it reads "confirmed". */
export const statusOf = (header: string[], rec: string[]): string => clean(rec[header.indexOf("status")]).toLowerCase();
