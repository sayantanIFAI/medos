import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "./bridge";
import { StateStore } from "./state";
import { toInstant } from "./map";
import { TransientError, type MedosLike, type MedosReply, type PodLike, type RosterDoctor, type VoiceBooking } from "./types";

const NOW = Date.parse("2026-11-10T04:00:00Z");
const vb = (n: number, o: Partial<VoiceBooking> = {}): VoiceBooking => ({
  ref: `KCD-${n}`, doctorName: "Dr. A", department: "Neurology", date: "2026-11-12", timeSlot: "11:00", slotMinutes: 10,
  patient: { name: "Anita Roy", age: 37, sex: "F", address: "Behala", phone: "9830012345" }, ...o,
});

/** The pod: a log that only grows, and the set of bookings the clinic still holds as confirmed. */
class FakePod implements PodLike {
  log: VoiceBooking[] = [];
  confirmed = new Set<string>();
  readsFrom: number[] = [];
  down = false;
  add(...b: VoiceBooking[]) { for (const x of b) { this.log.push(x); this.confirmed.add(x.ref); } }
  async readLog(offset: number) {
    if (this.down) throw new TransientError("ssh down");
    this.readsFrom.push(offset);
    return { bookings: this.log.slice(offset), next: this.log.length };
  }
  async stillConfirmed(refs: string[]) { if (this.down) throw new TransientError("ssh down"); return new Set(refs.filter((r) => this.confirmed.has(r))); }
}

class FakeMedos implements MedosLike {
  bookings = new Map<string, { status: string; body: Record<string, unknown> }>();
  doctors = new Set<string>(["Dr. A"]);
  down = false;
  refuse: Record<string, { status: number; code: string }> = {};
  async putDoctor(ref: string): Promise<MedosReply> { const created = !this.doctors.has(ref); this.doctors.add(ref); return { status: created ? 201 : 200, body: { data: { created, scheduleChanged: created } } }; }
  async putBooking(ref: string, body: unknown): Promise<MedosReply> {
    if (this.down) return { status: 503, body: {} };
    const b = body as { doctorName: string };
    const refused = this.refuse[ref];
    if (refused) return { status: refused.status, body: { error: { code: refused.code, message: "x" } } };
    if (!this.doctors.has(b.doctorName)) return { status: 422, body: { error: { code: "DOCTOR_NOT_MAPPED", message: "x" } } };
    if (this.bookings.has(ref)) return { status: 200, body: { data: { outcome: "unchanged" } } };
    this.bookings.set(ref, { status: "BOOKED", body: b as unknown as Record<string, unknown> });
    return { status: 201, body: { data: { outcome: "created" } } };
  }
  async cancelBooking(ref: string): Promise<MedosReply> {
    if (this.down) return { status: 503, body: {} };
    const have = this.bookings.get(ref);
    if (!have) return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
    have.status = "CANCELLED";
    return { status: 200, body: { data: { outcome: "cancelled" } } };
  }
}

const make = (o: { now?: () => number } = {}) => {
  const pod = new FakePod();
  const medos = new FakeMedos();
  const store = new StateStore(null);
  const logs: string[] = [];
  const bridge = new Bridge(pod, medos, store, { now: o.now ?? (() => NOW), log: (l) => logs.push(l) });
  return { pod, medos, store, bridge, logs };
};

describe("voice bridge", () => {
  it("loads the roster once and leaves a second load unchanged", async () => {
    const { bridge } = make();
    const d: RosterDoctor[] = [{ ref: "1", name: "Dr. A", department: "Neurology", slotMinutes: 10, windows: [{ weekday: 0, start: "10:00", end: "12:00" }] }];
    assert.deepEqual(await bridge.syncDoctors(d), { created: 1, updated: 0, failed: 0 });
    assert.deepEqual(await bridge.syncDoctors(d), { created: 0, updated: 0, failed: 0 });
  });

  it("records new confirmed bookings and moves its read position to the end of what it read", async () => {
    const { pod, medos, store, bridge } = make();
    pod.add(vb(1), vb(2), vb(3));
    assert.deepEqual(await bridge.pullNew(), { recorded: 3, skipped: 0, failed: 0 });
    assert.equal(medos.bookings.size, 3);
    assert.equal(store.state.logOffset, 3);
    assert.deepEqual(Object.keys(store.state.tracked).sort(), ["KCD-1", "KCD-2", "KCD-3"]);
    pod.add(vb(4));
    await bridge.pullNew();
    assert.deepEqual(pod.readsFrom, [0, 3]);
    assert.equal(medos.bookings.size, 4);
  });

  it("a second run, or a lost state file, records nothing twice", async () => {
    const { pod, medos, bridge, store } = make();
    pod.add(vb(1), vb(2));
    await bridge.pullNew();
    store.state.logOffset = 0;
    await bridge.pullNew();
    assert.equal(medos.bookings.size, 2);
  });

  it("only records what the clinic still holds as confirmed: a stale or already-cancelled log line is skipped", async () => {
    const { pod, medos, bridge } = make();
    pod.add(vb(1), vb(2));
    pod.confirmed.delete("KCD-2");
    assert.deepEqual(await bridge.pullNew(), { recorded: 1, skipped: 1, failed: 0 });
    assert.deepEqual([...medos.bookings.keys()], ["KCD-1"]);
  });

  it("skips a booking whose time has passed without asking the pod or MedOS", async () => {
    const { pod, medos, bridge } = make();
    pod.add(vb(1, { date: "2026-11-09", timeSlot: "10:00" }), vb(2));
    assert.deepEqual(await bridge.pullNew(), { recorded: 1, skipped: 1, failed: 0 });
    assert.equal(medos.bookings.size, 1);
  });

  it("keeps its place and tries again when MedOS or the pod cannot be reached, losing and repeating nothing", async () => {
    const { pod, medos, bridge, store } = make();
    pod.add(vb(1), vb(2));
    medos.down = true;
    await bridge.tick(); // reports "will retry", does not throw
    assert.equal(store.state.logOffset, 0);
    assert.equal(medos.bookings.size, 0);
    medos.down = false;
    pod.down = true;
    await bridge.tick();
    assert.equal(store.state.logOffset, 0);
    pod.down = false;
    await bridge.tick();
    assert.equal(medos.bookings.size, 2);
    assert.equal(store.state.logOffset, 2);
  });

  it("parks a refused booking, moves on, and lists it for a person", async () => {
    const { pod, medos, bridge, store } = make();
    medos.refuse["KCD-1"] = { status: 422, code: "PATIENT_AGE_REQUIRED" };
    pod.add(vb(1), vb(2, { doctorName: "Dr. Unknown" }), vb(3));
    const c = await bridge.pullNew();
    assert.deepEqual(c, { recorded: 1, skipped: 0, failed: 2 });
    assert.equal(store.state.logOffset, 3);
    assert.equal(store.state.failed["KCD-1"]?.code, "PATIENT_AGE_REQUIRED");
    assert.equal(store.state.failed["KCD-2"]?.code, "DOCTOR_NOT_MAPPED");
    assert.deepEqual([...medos.bookings.keys()], ["KCD-3"]);
  });

  it("cancels in MedOS a booking the clinic no longer holds as confirmed (cancelled or rescheduled)", async () => {
    const { pod, medos, bridge, store } = make();
    pod.add(vb(1), vb(2));
    await bridge.pullNew();
    pod.confirmed.delete("KCD-1");
    assert.equal(await bridge.reconcile(0), 1);
    assert.equal(medos.bookings.get("KCD-1")?.status, "CANCELLED");
    assert.equal(medos.bookings.get("KCD-2")?.status, "BOOKED");
    assert.deepEqual(Object.keys(store.state.tracked), ["KCD-2"]);
  });

  it("quietly stops watching a booking MedOS never recorded", async () => {
    const { pod, medos, bridge, store } = make();
    pod.add(vb(1));
    await bridge.pullNew();
    medos.bookings.clear(); // MedOS has no record of it
    pod.confirmed.delete("KCD-1");
    assert.equal(await bridge.reconcile(0), 0);
    assert.deepEqual(store.state.tracked, {});
    assert.deepEqual(store.state.failed, {});
  });

  it("does not cancel anything when the pod cannot be reached", async () => {
    const { pod, medos, bridge } = make();
    pod.add(vb(1));
    await bridge.pullNew();
    pod.down = true;
    await bridge.tick();
    pod.down = false;
    assert.equal(medos.bookings.get("KCD-1")?.status, "BOOKED");
  });

  it("stops watching a booking once its time has passed", async () => {
    let now = NOW;
    const { pod, bridge, store } = make({ now: () => now });
    pod.add(vb(1));
    await bridge.pullNew();
    now = Date.parse(toInstant("2026-11-12", "11:30"));
    await bridge.reconcile(0);
    assert.equal(Object.keys(store.state.tracked).length, 0);
  });

  it("never writes a name or phone number to its log or its state", async () => {
    const { pod, bridge, store, logs } = make();
    pod.add(vb(1));
    await bridge.tick();
    const all = logs.join("\n") + JSON.stringify(store.state);
    for (const secret of ["Anita", "Roy", "9830012345", "Behala"]) assert.equal(all.includes(secret), false, secret);
  });

  it("surfaces a non-temporary failure instead of hiding it", async () => {
    const { pod, bridge } = make();
    pod.readLog = async () => { throw new Error("unexpected"); };
    await assert.rejects(() => bridge.tick(), /unexpected/);
  });
});
