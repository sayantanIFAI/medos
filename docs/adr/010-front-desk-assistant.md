# ADR-010: In-app Hindi/English assistant, lab test bookings and prescription reading

**Status:** Accepted on 2026-11-04 at the owner's explicit request. It lifts the MLP-1 exclusion of AI (CLAUDE.md §10) for this one feature only. Not approved for real patient data (see Consequences).

## Context
Reception staff spend most of their time on three questions: "what does this test cost", "when is Dr X free" and "book it". The owner asked for (1) an assistant that understands spoken Hindi and answers those questions and books straight into MedOS, and (2) a way to give it an e-prescription and have the follow-up visit and lab tests booked automatically, using free OCR.

## Decisions
1. **The model decides what was asked; code decides what is true.** A language model turns a Hindi, English or mixed sentence into a small structured request (intent, test names, doctor or department, day, time). It never writes a reply and never states a price, name, time or number. Doctors, tests, rates, free slots and booking numbers come from MedOS records, and every sentence spoken back is a template filled from them. Days, times, ages and phone digits are read from the words by code and override whatever the model said.
2. **The language model runs on the remote AI host.** An Ollama-compatible `/api/chat` reached through `AI_REMOTE_URL` (or its own `ASSISTANT_LLM_URL`), model `ASSISTANT_LLM_MODEL` (default `qwen2.5:7b`). Output is schema-constrained JSON. If no model is connected or it fails, word rules answer a smaller set of requests instead, and the assistant keeps working.
3. **Booking needs an explicit "yes" to a read-back** of the patient, doctor or tests and time. It runs with the signed-in user's own permissions (`ASSISTANT_USE` plus `LAB_BOOK`, `APPOINTMENT_CREATE`, `PATIENT_READ`, `PATIENT_CREATE`), uses the same appointment and lab services as the screens, and is idempotent. A patient is matched only by the same mobile number and first name; anything less certain registers a new patient with a recorded duplicate override. Patients are never merged.
4. **Lab tests are booking only.** `LabTest` (catalogue, rate, aliases in Hindi and English, fasting and preparation notes) and `LabBooking` (patient, tests, collection time, source). There is no sample tracking, result entry or billing yet.
5. **Prescription reading runs on the remote AI host, not on the MedOS computer.** The picture or PDF is sent to the host (`POST /ocr`, EasyOCR for Hindi and English; PDFs with text use their text) and the text comes back. No OCR engine or model is installed in MedOS. If the host cannot be reached the scan fails with a plain message and the prescription is booked by hand. Tests and follow-ups are matched against the hospital's own catalogue and doctors. Only items matched with high certainty on a clear reading (confidence 55 or more) are booked; the rest are listed for staff to check. The scanned file is saved to the patient's documents.
6. **Voice runs on the remote AI host too.** The screen records a short clip, MedOS passes it to the host (`POST /asr`, faster-whisper) and gets the words back, which are then treated exactly like typed words. Replies are spoken by the host (`POST /tts`) and played in the browser. Neither the browser's own speech service nor any voice model on the MedOS computer is used. Typing always works.
7. **Conversations live in memory** (30 minutes, per user and hospital, never shared). The words spoken are not stored; the bookings they lead to are, with the usual audit trail (`LAB_BOOKED`, appointment events, `PRESCRIPTION_SCANNED`).

## Alternatives considered
A model that writes the replies (can invent a price or a time); a model with database access (breaks tenant isolation and audit); running the models on the MedOS computer (no GPU, 16 GB of memory, and the owner wants nothing heavy there); a paid hosted AI service; the browser's built-in speech (sends audio to its maker); a separate microservice inside MedOS (CLAUDE.md §2: the AI host is a replaceable outside service called over HTTP, MedOS stays one monolith).

## Consequences
- **Patient data leaves the MedOS computer.** Prescription pictures and voice clips go to the AI host (today a rented RunPod GPU pod reached through a private SSH tunnel and protected by a shared token; a free Kaggle notebook also works). That is acceptable for made-up demo patients only. Before real patients, the same `apps/ai-host/server.py` must run on a server the hospital controls, after the DPDP, consent and processing-agreement review. MedOS changes only the URL.
- **The pod is a shared, rented demo host** (it also carries another project; MedOS touches only `/workspace/medos-ai`). While the host is down, voice and reading say so and everything else works by hand.
- **The spoken voice (MMS-TTS) is non-commercial** (CC-BY-NC 4.0). Replace it before MedOS is sold.
- **Handwriting reads poorly** with EasyOCR. Unclear photos are never booked; they go to staff.
- **Model quality in Hindi is unmeasured** for this vocabulary. A 7B model is the minimum we would trust; the 1B models usually installed with Ollama are not enough. It needs an evaluation set before any pilot.
- Conversations are lost when the API restarts and are not shared between API instances.
- Needs the same clinical-safety, DPDP and security reviews as the rest of the system before real patient data.
