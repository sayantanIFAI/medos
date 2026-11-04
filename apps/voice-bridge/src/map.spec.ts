import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanName, medosWeekday, mobileOf, startsAtMs, toBookingBody, toDoctorBody, toInstant } from "./map";
import type { VoiceBooking } from "./types";

const booking = (o: Partial<VoiceBooking> = {}): VoiceBooking => ({
  ref: "KCD-20261110-AB12CD34", doctorName: "Dr. Joydeep Sanyal", department: "Neurology", date: "2026-11-10", timeSlot: "18:40", slotMinutes: 10,
  patient: { name: "Anita Roy", age: 37, sex: "F", address: "Behala, Kolkata", phone: "98300 12345" }, ...o,
});

describe("voice bridge mapping", () => {
  it("reads the clinic's date and time as Kolkata time", () => {
    assert.equal(toInstant("2026-11-10", "18:40"), "2026-11-10T18:40:00+05:30");
    assert.equal(new Date(startsAtMs(booking())).toISOString(), "2026-11-10T13:10:00.000Z");
  });

  it("keeps a valid mobile and drops placeholders and half-heard numbers", () => {
    assert.equal(mobileOf("98300 12345"), "9830012345");
    assert.equal(mobileOf("+91 98300-12345"), "9830012345");
    assert.equal(mobileOf("not_provided"), undefined);
    assert.equal(mobileOf("12345"), undefined);
    assert.equal(mobileOf("5830012345"), undefined);
    assert.equal(mobileOf(null), undefined);
  });

  it("cleans a spoken name to what MedOS accepts without inventing anything", () => {
    assert.equal(cleanName("  Anita   Devi Roy "), "Anita Devi Roy");
    assert.equal(cleanName("সৌরভ মুখার্জী"), "সৌরভ মুখার্জী");
    assert.equal(cleanName("র‍্যা 123 Sen"), "র্যা Sen"); // joiner and digits removed
    assert.equal(cleanName("###"), "Unknown caller");
    assert.ok(cleanName("x".repeat(500)).length <= 118);
  });

  it("builds a booking body that names the doctor and carries only what the caller gave", () => {
    const body = toBookingBody(booking()) as Record<string, unknown>;
    assert.equal(body.status, "CONFIRMED");
    assert.equal(body.doctorName, "Dr. Joydeep Sanyal");
    assert.equal("doctorRef" in body, false);
    assert.equal(body.startAt, "2026-11-10T18:40:00+05:30");
    assert.equal(body.durationMinutes, 10);
    assert.deepEqual(body.patient, { name: "Anita Roy", mobile: "9830012345", ageYears: 37, sex: "FEMALE", address: "Behala, Kolkata" });
    const bare = toBookingBody(booking({ patient: { name: "Ravi", age: null, sex: "", address: "", phone: "not_provided" } })) as { patient: Record<string, unknown> };
    assert.deepEqual(bare.patient, { name: "Ravi", sex: "UNKNOWN" });
  });

  it("maps weekdays from Monday-first to Sunday-first and builds the schedule", () => {
    assert.equal(medosWeekday(0), 1);
    assert.equal(medosWeekday(6), 0);
    const d = toDoctorBody({ ref: "7", name: "Dr. Joydeep Sanyal", department: "Neurology", slotMinutes: 10,
      windows: [{ weekday: 2, start: "18:00", end: "20:00" }, { weekday: 0, start: "10:00", end: "12:00" }, { weekday: 4, start: "12:00", end: "12:00" }] }) as { schedule: { windows: unknown[] } };
    assert.deepEqual(d.schedule.windows, [
      { dayOfWeek: 1, start: "10:00", end: "12:00", slotMinutes: 10 },
      { dayOfWeek: 3, start: "18:00", end: "20:00", slotMinutes: 10 },
    ]);
  });
});
