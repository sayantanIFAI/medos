import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planPrescription } from "./prescription.parser";

const DOCS = [
  { id: "d1", name: "Dr. Anita Sen", departmentName: "Cardiology" },
  { id: "d2", name: "Dr. Anil Sen", departmentName: "Cardiology" },
  { id: "d3", name: "Dr. Joydeep Sanyal", departmentName: "Neurology" },
];
const DEPTS = ["Cardiology", "Neurology", "Orthopaedics", "ENT", "General Medicine"];
const plan = (text: string) => planPrescription(text, [], DOCS, DEPTS);

describe("prescription reading", () => {
  it("finds a named doctor and an interval in weeks, days, months and Hindi", () => {
    for (const [line, days] of [
      ["Follow up with Dr. Joydeep Sanyal after 2 weeks", 14],
      ["Review with Dr Joydeep Sanyal in 10 days", 10],
      ["Follow-up Dr. Joydeep Sanyal after 1 month", 30],
      ["Dr. Joydeep Sanyal से 2 हफ्ते बाद फिर दिखाएं", 14],
      ["Review Dr. Joydeep Sanyal next week", 7],
    ] as [string, number][]) {
      const v = plan(line).visits[0];
      assert.equal(v?.doctorId, "d3", line);
      assert.equal(v?.afterDays, days, line);
      assert.equal(v?.confidence, "HIGH", line);
    }
  });

  it("only treats a name as a doctor when exactly one doctor fits, otherwise asks staff", () => {
    const v = plan("Follow up with Dr. Sen after 1 week").visits[0];
    assert.equal(v?.doctorId, null);
    assert.equal(v?.confidence, "MEDIUM");
    assert.match(v?.why ?? "", /more than one/);
  });

  it("a referral to a department is certain when it says refer, with or without a time", () => {
    const v = plan("Refer to Cardiologist").visits[0];
    assert.equal(v?.kind, "REFERRAL");
    assert.equal(v?.departmentFragment, "cardio");
    assert.equal(v?.confidence, "HIGH");
    assert.equal(v?.afterDays, 0);
  });

  it("a follow-up with no doctor, department or time is left for staff", () => {
    const v = plan("Review after some days").visits[0];
    assert.equal(v?.confidence, "MEDIUM");
    assert.equal(v?.departmentFragment, null);
    assert.equal(plan("Follow up").visits[0]?.confidence, "MEDIUM");
  });

  it("does not turn medicines, doses or ordinary words into visits", () => {
    assert.deepEqual(plan("Tab Paracetamol 500 mg twice a day for 5 days\nSyrup 5 ml at night\nAvoid oily food").visits, []);
  });

  it("keeps the line it read each item from, so a person can check it", () => {
    const v = plan("Rx\nFollow up with Dr. Anita Sen after 2 weeks.\nDiet advice").visits[0];
    assert.equal(v?.evidence, "Follow up with Dr. Anita Sen after 2 weeks.");
  });
});
