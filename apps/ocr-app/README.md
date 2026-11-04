# OCR app (prescription reader)

A separate program on the front-desk laptop (ADR-011). It sends a prescription picture or PDF to the AI pod to be read (EasyOCR, Hindi and English), shows what the paper asks for, and, for a patient staff choose, books the lab tests and follow-up visit into MedOS through the front-desk API, signed in as its own narrow MedOS user (`ocr-app`).

Page: http://localhost:5102 (this computer only).

## Set up (once)
Same as the voicebot app: `node scripts/frontdesk-apps-provision.mjs --tenant <hospital code>` writes `.local/ocr-app.env`; then `pnpm --filter @medos/ocr-app build` and `node apps/ocr-app/dist/main.js` (or `scripts\apps-up.ps1`). Settings: `MEDOS_URL`, `MEDOS_WEB_URL`, `MEDOS_TENANT`, `MEDOS_USER`, `MEDOS_PASSWORD`, `AI_URL`, `AI_TOKEN`, `OCR_APP_PORT` (5102).

## Use
1. Choose or drop a prescription (PNG, JPEG or PDF, up to 5 MB) and press **Read prescription**. Nothing is booked yet.
2. The name on the paper starts a patient search; **choose the right person** (the app never picks one for you).
3. **Book for this patient.** The paper is stored with the patient; tests read with an exact name on a clear reading are booked; a follow-up with a named doctor and time is booked at the earliest free slot. Anything uncertain (blurry photo, inexact spelling, a visit with no time) is listed under "Needs a person".
4. Open the patient's journey in MedOS from the result.

Scanning the same paper for the same patient again books nothing twice. Handwriting reads poorly; a reading below 55% confidence is never booked. Tests: `pnpm --filter @medos/ocr-app test` (routes, name guessing), and `apps/api/src/modules/frontdesk/frontdesk.spec.ts` (the same scan flow against the real MedOS API).
