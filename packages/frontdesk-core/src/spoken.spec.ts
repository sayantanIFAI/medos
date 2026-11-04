import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dayHints, spokenDigits, spokenNumber } from "./spoken";

describe("spoken numbers, days and times", () => {
  it("reads Hindi number words, Devanagari digits and plain digits for an age", () => {
    for (const [text, n] of [["पैंतालीस साल", 45], ["45 साल", 45], ["४५", 45], ["उम्र बीस", 20], ["निन्यानवे", 99], ["साठ साल के", 60], ["सात", 7], ["twenty", null], ["बहत्तर", 72], ["तेरा साल", 13], ["सोला साल", 16]] as [string, number | null][]) {
      assert.equal(spokenNumber(text), n, text);
    }
    assert.equal(spokenNumber("1234"), null);
  });

  it("reads a mobile number said digit by digit in Hindi, English or digits", () => {
    assert.equal(spokenDigits("नौ आठ तीन शून्य एक दो तीन चार पाँच छह"), "9830123456");
    assert.equal(spokenDigits("9830012345"), "9830012345");
    assert.equal(spokenDigits("9 8 3 0 0 1 2 3 4 5"), "9830012345");
    assert.equal(spokenDigits("nine eight three zero zero one two three four five"), "9830012345");
    assert.equal(spokenDigits("९८३०० १२३४५"), "9830012345");
    assert.equal(spokenDigits("नौ आठ तीन शून्य शून्य डबल एक दो तीन चार"), "9830011234".padEnd(10, "x").slice(0, 10).replace(/x/g, ""));
  });

  it("reads the day from the words, not from a model", () => {
    assert.equal(dayHints("कल सुबह").dayOffset, 1);
    assert.equal(dayHints("परसों शाम को").dayOffset, 2);
    assert.equal(dayHints("आज").dayOffset, 0);
    assert.equal(dayHints("tomorrow morning").dayOffset, 1);
    assert.equal(dayHints("सोमवार को").weekday, 1);
    assert.equal(dayHints("on Friday").weekday, 5);
    assert.equal(dayHints("somvar ko").weekday, 1);
    assert.equal(dayHints("कुछ नहीं").dayOffset, null);
  });

  it("reads clock times, using the part of the day, and invents nothing", () => {
    assert.equal(dayHints("शाम 5 बजे").time, "17:00");
    assert.equal(dayHints("सुबह 9 बजे").time, "09:00");
    assert.equal(dayHints("11 baje").time, "11:00");
    assert.equal(dayHints("5:30 pm").time, "17:30");
    assert.equal(dayHints("8 am").time, "08:00");
    assert.equal(dayHints("पाँच बजे").time, "17:00");
    assert.equal(dayHints("दोपहर 2 बजे").time, "14:00");
    assert.equal(dayHints("08:30").time, "08:30");
    assert.equal(dayHints("कल शाम को").time, null); // a part of the day is not a time
    assert.equal(dayHints("हड्डी के डॉक्टर").time, null);
    assert.equal(dayHints("शाम").partOfDay, "evening");
  });
});
