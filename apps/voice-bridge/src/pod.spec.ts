import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./csv";
import { PodReader } from "./pod";
import { TransientError } from "./types";

const HEADER = "kind,confirmation_id,booked_at,patient_name,age,sex,address,patient_phone,caller_phone,doctor,department,tests,visit_date,visit_day,time_slot,status,paid,serial_number";
const row = (ref: string, o: Record<string, string> = {}) => {
  const f: Record<string, string> = {
    kind: "doctor", confirmation_id: ref, booked_at: "2026-11-04 10:00:00", patient_name: "Anita Roy", age: "37", sex: "F", address: '"Behala, near ""Tram"" depot"',
    patient_phone: "9830012345", caller_phone: "9830012345", doctor: "Dr. Joydeep Sanyal", department: "Neurology", tests: "", visit_date: "2026-11-10",
    visit_day: "Tuesday", time_slot: "18:40", status: "confirmed", paid: "no", serial_number: "", ...o,
  };
  return HEADER.split(",").map((h) => f[h]).join(",");
};
const frame = (size: number, body: string) => `SIZE=${size}\nHEAD=${HEADER}\n${body}`;

describe("csv", () => {
  it("reads quoted fields, doubled quotes and line breaks inside quotes", () => {
    const { records, consumed } = parseCsv('a,"b,c","d ""e"""\r\n1,"two\nlines",3\n');
    assert.deepEqual(records, [["a", "b,c", 'd "e"'], ["1", "two\nlines", "3"]]);
    assert.equal(consumed, 'a,"b,c","d ""e"""\r\n1,"two\nlines",3\n'.length);
  });

  it("leaves an unfinished line for the next read", () => {
    const text = "a,b\nc,d";
    const { records, consumed } = parseCsv(text);
    assert.deepEqual(records, [["a", "b"]]);
    assert.equal(text.slice(consumed), "c,d");
  });
});

describe("pod reader", () => {
  it("reads new confirmed doctor bookings, skips the header, other kinds and cancelled lines, and moves the offset by bytes", async () => {
    const body = ["﻿" + HEADER, row("KCD-1"), row("KCD-2", { kind: "lab_test" }), row("KCD-3", { status: "cancelled" }), row("KCD-4", { patient_name: "সৌরভ" })].join("\n") + "\n";
    const pod = new PodReader({ host: "h", port: 1, user: "u", keyPath: "k" }, 10, async () => frame(Buffer.byteLength(body), body));
    const r = await pod.readLog(0);
    assert.deepEqual(r.bookings.map((b) => b.ref), ["KCD-1", "KCD-4"]);
    assert.equal(r.bookings[0]?.patient.address, 'Behala, near "Tram" depot');
    assert.equal(r.bookings[0]?.doctorName, "Dr. Joydeep Sanyal");
    assert.equal(r.bookings[0]?.slotMinutes, 10);
    assert.equal(r.next, Buffer.byteLength(body, "utf8"));
  });

  it("does not take a half-written last line", async () => {
    const whole = row("KCD-1") + "\n";
    const partial = row("KCD-2").slice(0, 40);
    const pod = new PodReader({ host: "h", port: 1, user: "u", keyPath: "k" }, 10, async () => frame(100, whole + partial));
    const r = await pod.readLog(50);
    assert.deepEqual(r.bookings.map((b) => b.ref), ["KCD-1"]);
    assert.equal(r.next, 50 + Buffer.byteLength(whole));
  });

  it("starts again from the top when the log is smaller than the read position", async () => {
    const pod = new PodReader({ host: "h", port: 1, user: "u", keyPath: "k" }, 10, async () => frame(10, ""));
    assert.deepEqual(await pod.readLog(500), { bookings: [], next: 0 });
  });

  it("asks the clinic API on the pod, with a validated shell-safe list, which bookings are still confirmed", async () => {
    let seen = "";
    const pod = new PodReader({ host: "h", port: 1, user: "u", keyPath: "k" }, 10, async (cmd) => {
      seen = cmd;
      return 'REF=KCD-1\n{"found":true,"bookings":[{"confirmation_id":"KCD-1"}]}\n\nREF=KCD-2\n{"found":false,"bookings":[]}\n\n';
    });
    const live = await pod.stillConfirmed(["KCD-1", "KCD-2", "x; rm -rf /"]);
    assert.deepEqual([...live], ["KCD-1"]);
    assert.ok(seen.includes("confirmation_id=KCD-1") && !seen.includes("rm -rf"));
    assert.ok(seen.includes("$(cat /workspace/.clinic_api_token)"), "the token is read on the pod, not sent from here");
  });

  it("treats an unreadable answer as 'cannot tell', never as 'gone'", async () => {
    const pod = new PodReader({ host: "h", port: 1, user: "u", keyPath: "k" }, 10, async () => "REF=KCD-1\n\n");
    await assert.rejects(() => pod.stillConfirmed(["KCD-1"]), TransientError);
  });
});
