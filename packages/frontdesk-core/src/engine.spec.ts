import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeAName } from "./engine";

describe("what counts as a patient's name", () => {
  it("accepts real names in Hindi and English, with or without a title word", () => {
    for (const n of ["Ravi Mehta", "तपन दास", "सुनीता देवी", "Anita", "बच्चे राहुल", "Baby Das"]) assert.equal(looksLikeAName(n), true, n);
  });
  it("refuses the words a speech model hears in place of a name, so the question is asked again", () => {
    for (const n of ["बच्चे", "बच्चा", "बेटी", "मरीज़", "child", "patient", "yes", "हाँ", "मेरा नाम", "my name is", "", "x", "Ravi 45"]) assert.equal(looksLikeAName(n), false, n);
  });
});
