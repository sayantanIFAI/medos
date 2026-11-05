import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MedosClient, OcrEngine } from "@medos/frontdesk-core";
import { buildRoutes } from "./routes";

const PNG = fs.readFileSync(path.resolve(__dirname, "..", "..", "api", "src", "test", "fixtures", "prescription-sample.png"));
const TEXT = "Patient: Tapan Das   Age: 6\nInvestigations: CBC\nFollow up with Dr. Nandini Roy after 1 week";
const calls: string[] = [];
const PATIENT = "3f2a9a52-2b1c-4f0e-8d57-1d3c9a6b7e10";

/** A MedOS that answers like the front-desk API; it records what the app asked it to do. */
const medos = {
  can: () => true, timezone: async () => "Asia/Kolkata", patientExists: async () => true,
  findTests: async () => [{ testId: "t1", name: "Complete Blood Count (CBC)", matched: "cbc", confidence: "HIGH" as const, reason: "acronym" as const, price: "400.00" }],
  doctors: async () => [{ id: "d1", name: "Dr. Nandini Roy", departmentName: "Paediatrics" }], departments: async () => ["Paediatrics"],
  availability: async () => [{ startAt: new Date(Date.now() + 8 * 86_400_000).toISOString(), endAt: new Date(Date.now() + 8 * 86_400_000 + 900_000).toISOString(), available: true }],
  labTests: async () => [{ id: "t1", name: "Complete Blood Count (CBC)", price: "400.00", reportHours: 6, fastingRequired: false, prepEn: null, prepHi: null }],
  storePrescription: async () => { calls.push("store"); return { fileId: "f1" }; },
  bookLab: async (i: { testIds: string[] }) => { calls.push("lab:" + i.testIds.join(",")); return { id: "a1b2c3d4-0000", totalAmount: "400.00", collectionAt: new Date().toISOString(), items: ["Complete Blood Count (CBC)"] }; },
  bookAppointment: async () => { calls.push("appointment"); return { id: "e5f6a7b8-0000" }; },
  recordScan: async () => { calls.push("audit"); },
  resolvePatient: async (ref: string, p: { name: string }) => { calls.push("register:" + p.name); return { patientId: PATIENT, mrn: "DEMO-9" }; },
  searchPatients: async (q: string) => (q.toLowerCase().includes("tapan") ? [{ id: PATIENT, name: "Tapan Das", mrn: "DEMO-1", ageYears: 6, sex: null, mobileLast4: "3210" }] : []),
} as unknown as MedosClient;
const ocr: OcrEngine = { readImage: async () => ({ text: TEXT, confidence: 90, engine: "fake" }), readPdf: async () => ({ text: TEXT, confidence: 100, engine: "pdf-text" }) };
const routes = buildRoutes({ ocr, medos: async () => medos, status: async () => ({ ok: true }) });
const req = (q: Record<string, string> = {}, body: Buffer = PNG, method = "POST") => ({ method, path: "/", query: new URLSearchParams(q), headers: {}, body });
const run = (key: string, r: ReturnType<typeof req>) => (routes[key] as NonNullable<(typeof routes)[string]>)(r);
const isInvalid = (e: { code?: string }) => e.code === "VALIDATION_FAILED";

describe("OCR app routes", () => {
  it("'read' shows what the paper asks for and a name to start the search with, and books nothing", async () => {
    calls.length = 0;
    const out = (await run("POST /api/read", req())).json as { tests: { name: string }[]; patientGuess: string | null };
    assert.equal(out.tests[0]?.name, "Complete Blood Count (CBC)");
    assert.equal(out.patientGuess, "Tapan Das");
    assert.deepEqual(calls, ["audit"], "only the audit line; no booking and no stored file");
  });

  it("finds the patient for staff to choose, and shows only the last digits of the mobile number", async () => {
    const rows = (await run("GET /api/patients", req({ q: "Tapan" }, Buffer.alloc(0), "GET"))).json as { name: string; mobileLast4: string }[];
    assert.equal(rows[0]?.name, "Tapan Das");
    assert.equal(rows[0]?.mobileLast4, "3210");
    assert.deepEqual((await run("GET /api/patients", req({ q: "Nobody" }, Buffer.alloc(0), "GET"))).json, []);
    await assert.rejects(run("GET /api/patients", req({ q: "x" }, Buffer.alloc(0), "GET")), isInvalid);
  });

  it("'scan' for a chosen patient books the certain tests and keeps the paper", async () => {
    calls.length = 0;
    const out = (await run("POST /api/scan", req({ patientId: PATIENT, autoBook: "true", filename: "rx.png" }))).json as { booked: { lab: { tests: string[] } | null }; fileId: string | null };
    assert.ok(out.booked.lab);
    assert.equal(out.fileId, "f1");
    assert.ok(calls.includes("lab:t1") && calls.includes("store"));
  });

  it("registers a new patient when nobody on the list is right, and refuses a bad age or mobile number", async () => {
    calls.length = 0;
    const out = (await run("POST /api/patients", req({}, Buffer.from(JSON.stringify({ name: "Pavan Kumar", ageYears: 30, mobile: "9812345670" }))))).json as { id: string; mrn: string; mobileLast4: string };
    assert.equal(out.id, PATIENT);
    assert.equal(out.mobileLast4, "5670");
    assert.deepEqual(calls, ["register:Pavan Kumar"]);
    await assert.rejects(run("POST /api/patients", req({}, Buffer.from(JSON.stringify({ name: "Pavan", ageYears: 200 })))), isInvalid);
    await assert.rejects(run("POST /api/patients", req({}, Buffer.from(JSON.stringify({ name: "Pavan", ageYears: 30, mobile: "12345" })))), isInvalid);
    await assert.rejects(run("POST /api/patients", req({}, Buffer.from(JSON.stringify({ name: "Pavan", ageYears: 30, extra: 1 })))), isInvalid);
  });

  it("refuses to book without a patient, and a bad request is a plain 400", async () => {
    await assert.rejects(run("POST /api/scan", req({ autoBook: "true" })), isInvalid);
    await assert.rejects(run("POST /api/scan", req({ patientId: "not-a-uuid" })), isInvalid);
    await assert.rejects(run("POST /api/read", req({}, Buffer.from("not a picture at all"))), isInvalid);
  });
});
