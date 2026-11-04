# ADR-011: The voicebot and the OCR reader are separate apps that reach MedOS only through an API

Status: accepted (owner request, 2026-11-04). Builds on [ADR-010](010-front-desk-assistant.md); the rules there (the model decides what was asked, MedOS records decide what is true, a spoken "yes" to a read-back before any booking, patients never merged automatically) still hold.

## Context
ADR-010 put the assistant inside the MedOS API. The owner wants the two front-desk tools to be separate programs on the front-desk laptop: a **voicebot** (listens, speaks, books) and a **prescription reader** (OCR, books the tests and follow-up). They should use the GPU pod for the heavy AI work, and everything they book must flow into MedOS so the dashboard updates and one patient has one connected journey: a doctor booked by voice, a prescription scanned, the lab tests and follow-up that came from it.

## Decision
```
laptop                                                       GPU pod (RunPod)
 voicebot app  :5101 ─┐  speech, voice, language model ───►  server.py (Whisper, EasyOCR, MMS-TTS, Qwen via Ollama)
 OCR app       :5102 ─┤  (SSH tunnel, loopback only)
                      │  bookings, rates, doctors, files
                      └──────────────►  MedOS API  /frontdesk/*  ──►  PostgreSQL ──► MedOS web (dashboard, patient journey)
```
- **Two apps, own processes, own pages** (`apps/voicebot`, `apps/ocr-app`). Each is a small local server on `127.0.0.1` with its own page. They call the pod for AI and MedOS for everything else. They never touch the database.
- **One shared package, `@medos/frontdesk-core`** holds the logic both apps and MedOS need: Hindi/English understanding, doctor and lab matching, the booking dialogue (`FrontDeskEngine`), the prescription rules and scan flow (`scanPrescription`), the pod client and the MedOS client. The MedOS API's built-in Assistant screen runs the same engine, so there is one copy of the rules, not three.
- **One port between the logic and MedOS** (`FrontDeskPort`). Two implementations: HTTP to `/frontdesk/*` (`MedosClient`, used by the apps) and direct service calls inside the API (`PrismaFrontDeskPort`, used by the built-in screen and as the server side of the HTTP routes).
- **Each app is its own MedOS user** ("voicebot-app", "ocr-app") with one narrow role, "Front-desk apps": rates, doctors, free times, lab and appointment booking, registering a caller, keeping a scanned prescription. No bills, notes, prescriptions or audit access. MedOS checks permission on every route, scopes by tenant and facility, applies idempotency and audits under the app's own name.
- **One journey per patient, derived not duplicated.** Bookings already carry their origin (`source`: `VOICE_ASSISTANT` = voicebot app, `PRESCRIPTION` = OCR app, `VOICE_BOT` = phone bot). The new `Appointment.fileId` links a follow-up to the scanned paper (lab bookings already had it). `GET /frontdesk/journey/:patientId` merges appointments, lab bookings and scanned papers in time order; `GET /frontdesk/activity` feeds the dashboard card. Both screens refresh themselves every 8 to 10 seconds.

## Consequences
- **Where data goes:** voice clips and prescription pictures go from the laptop to the pod only. MedOS receives bookings, the patient's details as spoken or chosen, and the scanned paper (stored with the patient, once per patient and picture). The pod keeps nothing.
- **A MedOS outage** stops booking (the app says so; nothing is queued or guessed). **A pod outage** stops listening, speaking and reading; typing and booking by hand in MedOS continue.
- **The apps listen on loopback only**, refuse any other Host name and require a custom header on every POST, so another website open in the browser cannot drive them.
- **The OCR app never chooses the patient.** The name on the paper only starts a search; staff pick the person. A repeat of the same paper for the same patient books nothing twice; the same paper for another patient is a new booking.
- **Conversations live in the voicebot app's memory** (30 minutes); restarting it ends them. The built-in Assistant screen keeps working unchanged.
- **Unchanged limits from ADR-010:** the pod is a rented, shared demo host; patient data leaves the laptop, so made-up patients only until the privacy review (DPDP) is done; the spoken voice (MMS-TTS) is non-commercial; accuracy is only spot-checked.
- **Not part of this change:** the phone voice bot (BAANI) keeps feeding MedOS through the voice bridge (`voice-bridge.md`); its bookings show on the journey as "Phone bot".
