# MLP-1 certification and release-candidate review (Stages 41–43)

Date of last full run: 2026-10-05. Everything below was **executed** in the development environment (Windows 11, PostgreSQL 17 local cluster, Node 22, Chromium via Playwright). "Not run" means the artefact exists but could not be exercised here.

## 1. Verification evidence

| Check | Result |
|---|---|
| `pnpm lint` (all 6 packages) | pass |
| `pnpm typecheck` | pass |
| `pnpm build` (shared, database, api, web) | pass |
| API tests (`@medos/api`) | **411 / 411** on the final full run — real HTTP against a real PostgreSQL database. One earlier full run showed 1 failure that did not reproduce (12 targeted reruns of the performance, security, files and print specs plus one full rerun all passed); the cause was not identified. |
| Shared tests | 7 / 7 |
| Web unit tests | 13 / 13 |
| Browser end-to-end (Playwright, Chromium, production build, seeded DB) | **13 / 13** |
| Backup → restore → verify drill (`scripts/restore-test.ps1`) | 15 checks identical, append-only trigger intact after restore |
| Licence audit (`pnpm licenses:audit`, ~640 packages) | no GPL/AGPL/SSPL/unknown; permissive licences only |
| `pnpm audit --prod` | 1 moderate (see §5) — down from 16 findings (7 high) after overrides |
| Seed (`pnpm db:seed`) | 1 tenant, 8 departments, 10 doctors, 12 nurses, 1,000 patients, 100 booked + 30 current OPD visits, 20 beds, 12 admissions, 100 medicines / 200 batches, 50 invoices (~35 s) |

## 2. Mandatory workflows

**OPD (CLAUDE.md §36)** — certified two ways:
- API: `apps/api/src/e2e/opd.e2e.spec.ts`: real login → register → check-in → queue → doctor starts → vitals → diagnosis → prescription → consultation signed (signed note cannot be overwritten) → invoice issued → split payment → pharmacy queue shows the signed prescription (and not the draft) → FEFO dispense with payment → receipts printable → stock ledger reconciles → audit events present, ordered and attributed → reports agree.
- Browser: `apps/web/e2e/opd.spec.ts`: the same journey through the real screens, across reception, doctor and pharmacist sign-ins, plus a negative test (receptionist cannot reach pharmacy/admin) and a duplicate-patient test.

**IPD (CLAUDE.md §37)** —
- API: `apps/api/src/e2e/ipd.e2e.spec.ts` and the flow test in `discharge.spec.ts`: register → admit → bed → vitals → note → order → medication given (not inferred from the order) → ward medicine charged to the admission → charge → transfer Ward A → ICU → Ward B (path reconstructed from history) → clearances → signed summary → final bill → part payment still blocks discharge → full payment → discharge → bed released → audit and reports.
- Browser: `apps/web/e2e/ipd.spec.ts`: admit under a named consultant → doctor orders and signs → nurse note, medication chart, "given" → doctor clears fitness → nurse clears → doctor charge (catalogue service) and charges review → summary signed by the treating consultant → pharmacist clears → cashier raises final bill and takes payment → doctor discharges → bed shows "cleaning".

## 3. Defects found by the certification work (all fixed, with regression coverage)

Found by the browser tests / manual UI verification and fixed before this report:
- Saving a prescription re-synchronised the form and **erased the unsaved consultation note** (and vice versa).
- Pickers rendered inside a `<label>` re-dispatched the click to the "change" button, so **a selected patient was immediately cleared**.
- Several screens assumed API shapes that differ from reality (age object, charges wrapper, medication-chart rows, worklist counts, discharge blockers) and crashed or showed blanks; corrected against the live API.
- No UI existed for inpatient medication orders; an **Orders tab** was added so a doctor can order and sign, which feeds the nurse's medication chart.
- Pharmacist taking cash had no way to open a shift from the payment step; added.

Found earlier on the API side (each has a regression test): trigger bugs in invoice reconciliation, a booking-race deadlock, permission list duplicates, unauthorised/stale-state paths in discharge, and others recorded in the stage history.

## 4. Spec gap resolutions (docs/product/mlp1.md §14)

| Gap | Outcome |
|---|---|
| G1 | Sequence is `OPD_VISIT`; the UI shows "Visit" numbers. |
| G2 | Appointment owns the scheduling lifecycle; queue entry owns real-time flow; one domain service keeps them in sync. |
| G3 | Permission list extended (`ALLERGY_WRITE`, `DUPLICATE_OVERRIDE`, `CASHIER_SHIFT_MANAGE`, `APPOINTMENT_OVERBOOK`, `INVOICE_ADJUST`, `PHARMACY_MASTERS`, `CHARGE_CREATE`). |
| G4 | Login takes tenant code + identifier; tenant/facility come only from the session afterwards. |
| G5 | **Not implemented**: no PostgreSQL row-level security. Isolation relies on tenant-scoped queries, composite foreign keys and a sweep test over every id route. Recommended hardening before multi-tenant production. |
| G6 | Per-line tax, decimal-safe, half-up to 2 dp; medicines are MRP-inclusive. **Needs a tax/legal review**; not certified. |
| G7 | Cash requires an open cashier shift; non-cash does not. |
| G8 | Overpayment rejected; advance payments deferred (backlog). |
| G9 | Refunds and credit notes are separate records; `REFUNDED` only for a full refund. |
| G10 | Prescription is signed with the consultation (OPD) or on its own (IPD orders). |
| G11 | One `MedicationOrder` model for OPD and IPD. |
| G12 | Server-rendered HTML and PDF (pdfkit, Latin fonts) from one document model. |
| G13 | scrypt instead of Argon2 (ADR-009). |
| G14 | **Flagged for legal review** (DPDP Act 2023, retention). Engineering does not certify compliance. |
| G15 | No Redis in MLP-1; patient files on local disk behind a storage interface (ADR-009). |

## 5. Known limitations (read before any production use)

**Not production-approved.** This is a release candidate for review. Deferred items are tracked in [`../REMINDER.md`](../REMINDER.md). Summary:

- Docker images, compose stack and the CI workflow were written but **never run** (no Docker here).
- No PostgreSQL row-level security (G5); rate limiting is per API instance.
- `pnpm audit`: 1 moderate advisory in `@nestjs/core`, fixed only by a Nest 11 upgrade.
- Backups are logical dumps only: no point-in-time recovery, encryption or scheduled restore drill.
- PDFs use Latin fonts only (Bengali/Hindi text prints as "?"); Bengali/Hindi UI strings need native-speaker review; uploaded files are not virus-scanned; files live on local disk.
- Not verified as built in the UI: stock `TRANSFER` movements, supplier management, a custom-role editor, discharge waivers and OPD prescription stop/amend. Check before relying on them.
- Verification scope: Chromium only, one machine; no multi-user load test, accessibility audit, penetration test, clinical-safety review, GST/tax review or data-protection review.

## 6. Recommended next steps
1. Run the Docker build, compose stack and CI workflow; fix what surfaces.
2. Decide on PostgreSQL row-level security; upgrade to Nest 11.
3. Independent reviews: clinical safety, tax/GST, DPDP, penetration test.
4. Pilot with synthetic then anonymised data in a staging environment before any real patient data.
