# REMINDER — deliberately deferred work

Things we agreed to postpone. Nothing here blocks local development and testing. Revisit before any hospital pilot or deployment.

## Deployment (not needed while developing and testing locally)
- **Docker images and `docker-compose.yml`** (`docker/api.Dockerfile`, `docker/web.Dockerfile`) are written but have **never been built or run** (no Docker on the dev machine). Expect small fixes on first run.
- **GitHub Actions workflow** (`.github/workflows/ci.yml`) is written but has **never run**.
- HTTPS termination / reverse proxy, secrets manager, log shipping, health-check wiring.
- Production environment separation (local / staging / production databases, secrets, domains) per CLAUDE.md §50.
- Explicit-approval production deploy process (CLAUDE.md §52).

## Security and platform hardening
- **PostgreSQL row-level security (RLS)** as defence in depth (spec gap G5). Today isolation relies on tenant-scoped queries, composite foreign keys and the id-sweep test.
- **Shared rate limiter** (Redis/Valkey or equivalent). Rate limiting is per API instance today, so N instances multiply the limit. The web BFF's refresh single-flight cache is also per instance (use sticky sessions or a shared cache when scaling).
- **Upgrade NestJS to v11** (clears the one remaining moderate `pnpm audit` advisory in `@nestjs/core`).
- Consider **Argon2id** instead of scrypt (ADR-009).
- Patient photos and documents are stored on **local disk** today (`apps/api/src/modules/documents`, `STORAGE_DIR`). Swap the storage driver for an S3-compatible store (CLAUDE.md §42) before running more than one API instance.
- PDF output uses built-in Latin fonts: Bengali/Hindi text in **printed PDFs** is replaced with "?" until a Unicode font is embedded (needs a font licence review, e.g. Noto Sans Bengali/Devanagari under OFL). Printed HTML uses the browser's fonts and is fine.
- **Translation coverage:** Bengali and Hindi cover menus, headings, buttons, labels, table headings, tabs, statuses and select options (about 600 strings). Sentences built from data (e.g. "Currently 5 Oct with Dr X"), server error messages and print documents are still English. Have a native speaker review the wording before a pilot.
- Uploaded files are not virus-scanned.

## Backups and recovery
- **Point-in-time recovery** (WAL archiving or managed-provider PITR).
- **Encryption at rest** for backups and the database volume; off-host backup storage.
- A **scheduled** backup job and a **scheduled restore drill** (`scripts/backup.ps1`, `scripts/restore-test.ps1` exist and were verified manually).

## External reviews (not engineering decisions)
- **Clinical-safety review** (allergy matching, dose/frequency rules, amendment workflow).
- **GST / tax review** (per-line tax, MRP-inclusive medicine pricing, rounding) — spec gap G6.
- **Data-protection / legal review** (India DPDP Act 2023, record retention, consent, patient documents) — spec gap G14.
- **Penetration test** and an **accessibility audit**.
- Multi-user **load test** (only single-machine volume tests were run: 30,000 patients, 60,000 audit events).

## Product ideas parked in `docs/backlog.md`
Advance payments/deposits, patient merge tool, bulk import, CSV import, MLP-2+ items.

## Voice bot link (BAANI to MedOS): see docs/voice-bridge.md
- Demo only, and **nothing on the pod was changed**: the bridge reads the pod's booking log and lookup endpoint over SSH. No push to the voicebot repo.
- Availability is still the voice bot's: a slot booked at the MedOS desk is not seen by the voice bot. For one shared calendar MedOS must become the slot source (needs a pod-side change, to be decided with the voice bot's owner).
- A rescheduled booking is cancelled in MedOS but its replacement is not copied (the log never lists the new number).
- Lab-test bookings by voice are not carried over (no lab module).
- The bridge runs only while its command runs on the laptop; there is no always-on service.
- Pod matter for the voice bot's owner: `/workspace/.clinic_api_token` is mode 666 (world-readable).
- The roster of doctors is a snapshot file (`apps/voice-bridge/data/kcd-doctors.json`); refresh it if the voice bot's doctors change.

## Voicebot app and OCR app (ADR-011)
- Two separate programs on the laptop (`apps/voicebot` :5101, `apps/ocr-app` :5102). Start everything with `scripts\apps-up.ps1` (database, SSH tunnel to the pod, API, web, both apps); stop with `scripts\apps-up.ps1 -Stop`. They call the pod for AI and MedOS's `/frontdesk/*` API for bookings, as their own narrow MedOS users (create them with `scripts/frontdesk-apps-provision.mjs`, which writes `.local/voicebot.env` and `.local/ocr-app.env`).
- One patient journey in MedOS (patient page, plus the dashboard card "Voicebot and OCR activity"). The existing built-in Assistant screen still works and runs the same engine.
- Needs: the pod host running (`scripts\ai-pod.ps1`), the tunnel window open, MedOS API running. Apps hold conversations in memory only.
- Open: apps are not packaged as installers or Windows services (they are started by the script); the journey is derived from bookings, so a booking cancelled in MedOS shows its status rather than disappearing; no web production build was run for the new journey cards.

## Front desk assistant (ADR-010): Hindi/English assistant, lab booking, prescription reading
- **Nothing AI runs on the MedOS computer.** Prescription reading (OCR), speech to text, spoken replies and the language model run on a rented RunPod GPU pod (`apps/ai-host`, set-up in its README; a free Kaggle notebook is the fallback), reached through an SSH tunnel (`scripts/ai-tunnel.ps1`). MedOS calls it with `AI_REMOTE_URL` + `AI_REMOTE_TOKEN` (put in `.local/ai-remote.env`). Without them the Assistant still types and books from simple word rules, and says voice and reading are not connected.
- **The pod is a shared, rented demo host.** It also holds another project under `/workspace`, which MedOS never touches (only `/workspace/medos-ai`). It costs money while running; if the pod restarts run `scripts/ai-pod.ps1`. Before real patients, run the same `server.py` on a server the hospital controls: only the URL changes.
- **Patient data leaves the MedOS computer** (prescription pictures, voice clips) over the SSH tunnel to the pod. Made-up patients only until the DPDP / consent / processing-agreement review is done.
- **The spoken voice (Meta MMS-TTS) is non-commercial (CC-BY-NC 4.0).** Replace it with a commercially licensed Hindi voice before MedOS is sold.
- **Not measured:** Whisper's Hindi accuracy at a noisy front desk, EasyOCR on photographed prescriptions, and Qwen's reading of Hindi sentences. Handwriting reads badly; unclear readings are never booked. Tried live on 2026-11-04 with one synthetic Hindi sentence and two printed prescriptions only.
- Conversations are in memory (30 minutes, per API instance); an API restart ends them.
- Lab bookings are booking only: no billing, sample tracking or results. The lab catalogue and rates are demo data; set the real rates in Administration.
- Needs clinical-safety, DPDP and security review like everything else before real patient data.
