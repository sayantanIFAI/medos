import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { editDistance, normalizeText, TestIndex } from "./lab-match";

const TESTS = [
  { id: "cbc", name: "Complete Blood Count (CBC)", aliases: ["blood count", "cbp", "खून की जांच", "ब्लड काउंट"] },
  { id: "fbs", name: "Blood Sugar Fasting", aliases: ["fbs", "fasting sugar", "sugar", "खाली पेट शुगर"] },
  { id: "ppbs", name: "Blood Sugar PP", aliases: ["ppbs", "pp sugar", "sugar", "खाने के बाद शुगर"] },
  { id: "hba1c", name: "HbA1c", aliases: ["glycosylated haemoglobin", "ए1सी"] },
  { id: "lipid", name: "Lipid Profile", aliases: ["cholesterol test", "लिपिड प्रोफाइल"] },
  { id: "tsh", name: "Thyroid (TSH)", aliases: ["thyroid", "थायराइड"] },
  { id: "esr", name: "ESR", aliases: ["erythrocyte sedimentation rate"] },
];
const idx = new TestIndex(TESTS);
const ids = (text: string, conf?: "HIGH" | "MEDIUM") => idx.find(text).filter((m) => !conf || m.confidence === conf).map((m) => m.testId).sort();

describe("lab test matching", () => {
  it("normalises Latin, Devanagari and punctuation", () => {
    assert.equal(normalizeText("  Lipid-Profile,  CBC! "), "lipid profile cbc");
    assert.equal(normalizeText("थायराइड  जांच।"), "थायराइड जांच");
  });

  it("finds tests by name, alias and acronym in a prescription line, trusting capitals for acronyms", () => {
    assert.deepEqual(ids("Advised: CBC, HbA1c, Lipid Profile, TSH.", "HIGH"), ["cbc", "hba1c", "lipid", "tsh"]);
    assert.deepEqual(ids("Investigations: FBS, PPBS", "HIGH"), ["fbs", "ppbs"]);
    assert.deepEqual(ids("ESR"), ["esr"]);
  });

  it("does not take an ordinary lower-case word for an acronym", () => {
    const m = idx.find("the cbp of the day");
    assert.equal(m.find((x) => x.testId === "cbc")?.confidence, "MEDIUM");
  });

  it("marks a phrase that fits more than one test as ambiguous, never as sure", () => {
    const m = idx.find("blood sugar check, sugar test");
    const sugar = m.filter((x) => x.testId === "fbs" || x.testId === "ppbs");
    assert.ok(sugar.length >= 2);
    assert.ok(sugar.every((x) => x.confidence === "MEDIUM" && x.reason === "ambiguous"));
  });

  it("understands Hindi names and Hinglish", () => {
    assert.deepEqual(ids("मुझे थायराइड और लिपिड प्रोफाइल की जांच करानी है", "HIGH"), ["lipid", "tsh"]);
    assert.deepEqual(ids("mujhe खून की जांच karwani hai", "HIGH"), ["cbc"]);
    assert.deepEqual(ids("खाली पेट शुगर और खाने के बाद शुगर", "HIGH"), ["fbs", "ppbs"]);
  });

  it("each stretch of text is used once, so a longer name wins over a shorter one inside it", () => {
    const m = idx.find("Complete Blood Count");
    assert.deepEqual(m.map((x) => x.testId), ["cbc"]);
  });

  it("allows one spelling slip from OCR but only as MEDIUM, and never for short words", () => {
    const m = idx.find("lipid profle");
    assert.equal(m[0]?.testId, "lipid");
    assert.equal(m[0]?.confidence, "MEDIUM");
    assert.equal(m[0]?.reason, "spelling");
    assert.deepEqual(idx.find("tsx"), []);
  });

  it("finds nothing in unrelated text and never invents a test", () => {
    assert.deepEqual(idx.find("Tab Paracetamol 500mg twice a day for 5 days"), []);
    assert.deepEqual(idx.find(""), []);
  });

  it("edit distance stops early", () => {
    assert.equal(editDistance("kitten", "kitten"), 0);
    assert.equal(editDistance("profile", "profle"), 1);
    assert.ok(editDistance("abc", "xyz") > 1);
  });
});
