# MedOS Backlog

Nothing in this file is in MLP-1 scope. Items are added here, never implemented, until a milestone approves them (CLAUDE.md §56).

## 1. MLP-1 stage map and gate

Each stage runs: PLAN → REVIEW CODE → DESIGN → IMPLEMENT → MIGRATE → TEST → SECURITY REVIEW → LICENSE REVIEW → BUILD → E2E → SELF-REVIEW → DOCUMENT → REPORT. A stage passes only when `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass (plus Playwright where workflow behaviour exists), regression tests exist for every material issue found, and docs are synchronised. Work stops after each stage until `CONTINUE`.

| # | Stage | # | Stage |
|---|---|---|---|
| 0 | Repository audit and specification | 22 | Pharmacy medicine and batch masters |
| 1 | Monorepo / bootstrap / infrastructure | 23 | Pharmacy stock ledger |
| 2 | Tenant / facility foundation | 24 | Pharmacy procurement / stock receipt |
| 3 | Authentication | 25 | Prescription dispensing |
| 4 | RBAC and permissions | 26 | Ward / room / bed masters |
| 5 | Hospital masters | 27 | IPD admission |
| 6 | Number sequence engine | 28 | Bed assignments / transfers |
| 7 | Patient registration | 29 | IPD charges |
| 8 | Duplicate patient detection | 30 | Nursing notes / worklist |
| 9 | Encounter foundation | 31 | Medication Administration Record |
| 10 | Practitioner schedules and appointments | 32 | Intake / output |
| 11 | OPD queue | 33 | Discharge workflow |
| 12 | Vitals / observations | 34 | Discharge summary |
| 13 | OPD consultation | 35 | Printing / template system |
| 14 | Diagnoses / allergies | 36 | Core reports |
| 15 | Medication orders / prescription | 37 | Audit review |
| 16 | Consultation signing / amendment | 38 | Security hardening |
| 17 | Service catalogue | 39 | Performance / concurrency hardening |
| 18 | Billing foundation | 40 | Backup / restore / deployment readiness |
| 19 | Payments / receipts | 41 | Full OPD E2E certification |
| 20 | Refund / cancellation / financial controls | 42 | Full IPD E2E certification |
| 21 | Cashier shifts | 43 | MLP-1 release candidate review |

Stages 2, 3 and 4 are interdependent in practice (audit writes need an actor; tenant scoping needs a session). Stage 2 will use a minimal, tested tenant-context interface that Stage 3 satisfies, without building Stage 3 early.

## 2. Open decisions blocking stages

See `docs/product/mlp1.md` §14 (G1–G15). Hard blockers: **G15 before Stage 1** (Redis and object-storage licences); G4/G5 before Stage 2–3.

## 3. Deferred by milestone (from the product spec)

- **MLP-2:** LIMS, advanced inventory/procurement, OT, insurance, TPA, enhanced MRD.
- **MLP-3:** West Bengal localisation, Bengali UI, Swasthya Sathi workflows.
- **MLP-4:** ABDM, ABHA, interoperability, FHIR gateway.
- **MLP-5:** doctor AI copilot. **MLP-6:** nursing AI. **MLP-7:** live operational command centre. **MLP-8:** revenue intelligence. **MLP-9:** predictive hospital operations. **MLP-10:** patient super app.

## 4. Out-of-scope items captured so far

Radiology/PACS/DICOM, pathology, blood bank, dialysis, IVF, dental charting, advanced ED/ICU, ambulance, telemedicine, home healthcare, HRMS/payroll, general ledger/ERP accounting, CRM/marketing, packages/DRG, BI/data warehouse, multi-country, patient mobile app, purchase approval hierarchies, vendor tenders.

## 5. Candidate items surfaced during Stage 0 (unscheduled)

- Advance payments / patient deposits (see G8).
- Patient merge tool (duplicates are flagged, never auto-merged; manual merge is a later, audited workflow).
- Bulk data import (patients, medicines, opening stock, services) — design now keeps pathways open; tooling deferred (CLAUDE.md §47).
- Credit-note document generation beyond data compatibility.
- Bengali/Hindi string catalogues (architecture ready in MLP-1, content later).

## 6. Candidate items surfaced while building (unscheduled; see docs/certification.md §5)

- UI gaps: consultation amendment, patient demographics edit, draft-invoice edit, appointment reschedule, stock purchases/returns/adjustments, supplier management, role/permission editor, password reset/change, practitioner schedule editor, nursing tasks, IPD vitals, discharge waiver, report export (CSV/Excel).
- Patient photo and scanned documents (needs S3-compatible storage, CLAUDE.md §42); stock `TRANSFER` movements.
- Shared rate limiter and cache (Redis/Valkey) when running more than one API/web instance.
- PostgreSQL row-level security as defence in depth (G5).
- Upgrade to NestJS 11 (clears the remaining `pnpm audit` advisory); consider Argon2id (ADR-009).
- Point-in-time recovery, encrypted backups, scheduled restore drills.
- Localisation catalogues (Bengali, Hindi); accessibility audit.
