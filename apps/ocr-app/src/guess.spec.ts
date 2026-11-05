import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guessPatientName } from "./guess";

describe("guessing the patient's name from a prescription", () => {
  it("reads the name after Patient / Name, stopping at the next field", () => {
    assert.equal(guessPatientName("Dr. Anita Sen\nPatient: Sunita Devi   Age: 54   Date: 04/11/2026"), "Sunita Devi");
    assert.equal(guessPatientName("Name - Mr. Rajesh Kumar, 45/M"), "Rajesh Kumar");
    assert.equal(guessPatientName("Patient Name: Tapan Das Age 6"), "Tapan Das");
    assert.equal(guessPatientName("मरीज़: सुनीता देवी  उम्र: 54"), "सुनीता देवी");
  });
  it("reads a titled name with the age in brackets when there is no Patient label", () => {
    assert.equal(guessPatientName("Apollo Clinic\nDr. P K Hazra\nMR. GURUJYOTI SINGH (37y Male)\nDate: 1-08-2015"), "GURUJYOTI SINGH");
    assert.equal(guessPatientName("Mrs. Sunita Devi, 54 years"), "Sunita Devi");
  });
  it("gives nothing when there is no name, rather than guessing", () => {
    assert.equal(guessPatientName("Investigations: CBC, Lipid Profile\nFollow up after 2 weeks"), null);
    assert.equal(guessPatientName(""), null);
  });
});
