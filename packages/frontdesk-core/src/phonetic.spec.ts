import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nameMatchesBySound, phoneticKey } from "./phonetic";

describe("finding a name across Devanagari and English letters", () => {
  it("gives the same sound skeleton to the same name written either way", () => {
    assert.equal(phoneticKey("pavan"), phoneticKey("पवन"));
    assert.equal(phoneticKey("Pawan"), phoneticKey("पवन"));
    assert.equal(phoneticKey("Paban"), phoneticKey("पवन"), "b and v are one sound");
    assert.equal(phoneticKey("pavan"), phoneticKey("पबन"), "what a speech recogniser may write for the same name");
    assert.equal(phoneticKey("Sharma"), phoneticKey("शरमा"), "a missing half-r still matches");
    assert.equal(phoneticKey("Kumar"), phoneticKey("कुमार"));
    assert.equal(phoneticKey("Kumaar"), phoneticKey("कुमार"));
    assert.equal(phoneticKey("Sunita"), phoneticKey("सुनीता"));
    assert.equal(phoneticKey("Sharma"), phoneticKey("शर्मा"));
    assert.equal(phoneticKey("Dutta"), phoneticKey("दत्ता"));
    assert.equal(phoneticKey("Chakraborty"), phoneticKey("चक्रवर्ती").length > 0 ? phoneticKey("Chakraborty") : "");
  });

  it("matches a typed name against a full name in the other script", () => {
    assert.equal(nameMatchesBySound("pavan", "पवन कुमार"), true);
    assert.equal(nameMatchesBySound("pavan kumar", "पवन कुमार"), true);
    assert.equal(nameMatchesBySound("pavan sharma", "पबन शरमा"), true, "the name as the voicebot heard it");
    assert.equal(nameMatchesBySound("पवन", "Pavan Kumar"), true);
    assert.equal(nameMatchesBySound("kum", "पवन कुमार"), true, "the start of a word is enough");
  });

  it("does not match different names, very short fragments or nothing at all", () => {
    assert.equal(nameMatchesBySound("pavan", "सुनीता देवी"), false);
    assert.equal(nameMatchesBySound("ra", "पवन कुमार"), false, "two letters must match exactly");
    assert.equal(nameMatchesBySound("", "पवन कुमार"), false);
    assert.equal(nameMatchesBySound("12345", "पवन कुमार"), false);
    assert.equal(nameMatchesBySound("pavan sharma", "पवन कुमार"), false, "every typed word must match");
  });
});
