# Modules

Per-module purpose, entities, workflow and state rules, permissions and audit events (CLAUDE.md §54). The exact route list with permissions is generated in [`api-routes.md`](api-routes.md). Business rules live in `apps/api/src/modules/<module>/*.service.ts`; PostgreSQL enforces the hard invariants again in `packages/database/prisma/migrations`.

## Platform (`apps/api/src/common`, `modules/auth|tenants|facilities|users|settings|numbering|audit`)
| Concern | Behaviour |
|---|---|
| Tenant context | Taken only from the authenticated session; `AuthGuard` re-reads user, tenant, facility and permissions from the database on every request. |
| Auth | tenant code + username/email + password; scrypt hashes; 15-minute access JWT; opaque rotating refresh tokens (reuse revokes the family); lockout after repeated failures; per-route rate limits. |
| Permissions | `packages/shared/src/permissions.ts` (single source). Roles are bundles of permissions; custom roles supported. |
| Idempotency | `Idempotency-Key` mandatory on payments, refunds, credit notes, dispensing, purchases, stock adjustments; optional on patient create, walk-in, admit. A reused key with a different body is rejected (422). |
| Numbering | Concurrency-safe counters per tenant/facility (MRN, visit, admission, invoice, receipt, prescription, dispense…). |
| Settings | Per-facility, validated by a key registry; feature flags; print header/footer; discharge rules. Changes audited. |
| Errors | Stable codes, no stack traces, request id in every error and log line. |

## Clinical front desk
| Module | Entities and rules | Key permissions | Audit events |
|---|---|---|---|
| Patients | One canonical patient; MRN as identifier; trigram duplicate detection (never auto-merge); optimistic `version` on update; override needs `DUPLICATE_OVERRIDE` and is audited | PATIENT_READ/CREATE/UPDATE, DUPLICATE_OVERRIDE | PATIENT_CREATED, PATIENT_UPDATED, PATIENT_DUPLICATE_OVERRIDDEN |
| Appointments | Practitioner schedules, slot availability; exclusion constraints prevent double booking; walk-in; overbooking needs APPOINTMENT_OVERBOOK | APPOINTMENT_* | APPOINTMENT_CREATED/RESCHEDULED/CANCELLED/CHECKED_IN/NO_SHOW |
| OPD queue | Token per day per doctor; `call-next` uses `SKIP LOCKED`; completion blocked while the consultation is a draft; priority/emergency | QUEUE_READ/MANAGE | QUEUE_CALL, QUEUE_START… , QUEUE_PRIORITY_CHANGED |
| Encounters, vitals | Every clinical record references an encounter; vitals are append-only with enter-in-error | VITALS_READ/CREATE | ENCOUNTER_OPENED, VITALS_RECORDED, VITALS_ENTERED_IN_ERROR |

## Clinical records
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Consultation | DRAFT → SIGNED → AMENDED; signed content is never overwritten; amendment keeps every version with reason and actor | CONSULTATION_READ/CREATE/SIGN/AMEND | CONSULTATION_STARTED/SIGNED/AMENDED, DIAGNOSIS_RECORDED/REMOVED |
| Allergies | Recorded with severity; status changes keep history; matched against every prescription and dispense (acknowledgement is audited) | ALLERGY_WRITE | ALLERGY_RECORDED, ALLERGY_STATUS_CHANGED, *_ALLERGY_ACKNOWLEDGED |
| Prescriptions | One draft per encounter; signed with the consultation (OPD) or on its own (IPD orders); amendments supersede; stopping an item keeps the original | PRESCRIPTION_READ/CREATE/SIGN | PRESCRIPTION_DRAFT_SAVED/SIGNED/SUPERSEDED, PRESCRIPTION_ITEM_STOPPED |

## Money
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Billing | Draft invoices are editable; issued invoices never change (credit note, refund or cancel instead); totals computed server-side with decimal maths; split payments; overpayment rejected; deferred DB checks reconcile invoice totals to receipts, refunds and credit notes | INVOICE_*, PAYMENT_CREATE/REFUND, INVOICE_ADJUST | INVOICE_CREATED/ISSUED/CANCELLED, PAYMENT_RECEIVED, REFUND_CREATED, CREDIT_NOTE_CREATED, INVOICE_DISCOUNT_APPLIED |
| Cashier shifts | One open shift per cashier; cash needs an open shift; expected vs counted cash on close | CASHIER_SHIFT_MANAGE | SHIFT_OPENED/CLOSED |
| Pharmacy | Medicine master; batches with expiry; stock ledger is the source of truth and the balance is reconciled to it by the database; FEFO allocation under row locks; no expired or blocked batch is dispensed; returns restore stock | PHARMACY_READ/DISPENSE/PURCHASE/ADJUST_STOCK/MASTERS | PHARMACY_DISPENSED/RETURN, STOCK_OPENING_RECORDED, STOCK_ADJUSTED, PURCHASE_RECEIVED/RETURNED, MEDICINE_* |

## Inpatient
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Beds and admissions | Ward → room → bed; one active admission per patient; one open bed assignment per admission; a bed is occupied by at most one admission; transfers keep the full bed history; admissions are closed (read-only) after discharge | ADMISSION_READ/CREATE/TRANSFER | ADMISSION_CREATED/CANCELLED, BED_TRANSFERRED, BED_STATUS_CHANGED |
| IPD charges | Pending → billed/voided; bed days accrue per assignment | CHARGE_CREATE (free-price lines need billing rights) | CHARGE_POSTED/VOIDED, BED_CHARGES_POSTED |
| Nursing and MAR | Notes with addenda; tasks; medication schedule generated from signed orders; GIVEN/MISSED/HELD/REFUSED recorded separately from the order; intake/output with enter-in-error | NURSING_READ/DOCUMENT/MEDICATION_ADMINISTER | NURSING_NOTE_*, NURSING_TASK_CREATED, MAR_SCHEDULE_GENERATED, MEDICATION_GIVEN, INTAKE_OUTPUT_* |
| Discharge | Doctor marks fit first; configurable clearance steps; waiver needs a reason; final bill from pending charges; summary signed by the treating consultant; completion releases the bed and closes the encounter; cannot complete with an unpaid final bill | ADMISSION_DISCHARGE (+ step permissions) | DISCHARGE_STEP_CLEARED/WAIVED, FINAL_INVOICE_CREATED, DISCHARGE_SUMMARY_*, ADMISSION_DISCHARGED |

## Documents
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Patient files | Photo (one active) and scanned documents; PNG/JPEG/PDF only, content-checked, ≤ 5 MB; bytes on disk (S3 later), metadata in PostgreSQL; removal hides the file but keeps it and its history; the database forbids edits and deletes | PATIENT_READ (view), PATIENT_UPDATE (upload, remove) | PATIENT_FILE_UPLOADED, PATIENT_FILE_VIEWED (documents), PATIENT_FILE_REMOVED |

## Front desk assistant (ADR-010)
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Lab (`modules/lab`) | Catalogue of tests with rate, report time, fasting and preparation notes, and Hindi/English aliases; bookings for a patient with a collection time (not in the past); total computed server-side; a booked booking can be cancelled with a reason; replays by key never book twice. Booking only: no sample tracking, results or billing yet | LAB_READ, LAB_BOOK, ADMIN_MASTERS (catalogue) | LAB_BOOKED, LAB_BOOKING_CANCELLED |
| Assistant (`modules/assistant`) | A language model on the remote AI host turns Hindi/English words into a request; code finds the tests, doctors, rates and free slots and writes every reply from templates. Booking needs a spoken "yes" to a read-back, runs with the user's own permissions, and never merges patients. Without a model it falls back to word rules | ASSISTANT_USE (+ LAB_READ/LAB_BOOK, APPOINTMENT_*, PATIENT_READ/CREATE for what it books) | the bookings' own events; patient matches as VOICE_PATIENT_MATCHED |
| Remote AI host (`apps/ai-host`) | Speech to text (`/assistant/transcribe`), spoken replies (`/assistant/speak`), prescription reading and the language model all run on a GPU pod (RunPod; Kaggle as fallback), not on the MedOS computer; MedOS passes bytes through, stores none, and says plainly when the host is not connected | ASSISTANT_USE | none (nothing is stored); the bookings that follow have their own |
| Prescription scan | The picture is read on the remote AI host; tests and follow-ups matched to the hospital's own catalogue and doctors; only certain items on a clear reading are booked, the rest are listed for staff; the file is saved to the patient's documents | ASSISTANT_USE + PATIENT_READ (+ LAB_BOOK, APPOINTMENT_CREATE to book) | PRESCRIPTION_SCANNED |
| Front-desk API (`modules/frontdesk`) | What the two separate apps may ask of MedOS (ADR-011): `GET /frontdesk/context`, `POST tests/match` and `tests/lookup`, `GET doctors`, `departments`, `availability`, `patients/search` and `patients/:id/exists`, `POST patients/resolve`, `lab-bookings`, `appointments`, `prescriptions` (the scanned file) and `prescription-scans` (audit). Each route needs `ASSISTANT_USE` plus the permission for its action, runs with the caller's own rights, is idempotent where it books, and rejects unknown fields | ASSISTANT_USE + LAB_READ / LAB_BOOK / APPOINTMENT_READ / APPOINTMENT_CREATE / PATIENT_READ / PATIENT_CREATE / PATIENT_UPDATE | APPOINTMENT_CREATED, LAB_BOOKED, PRESCRIPTION_SCANNED, file upload, all under the app's own user |
| Patient journey (`GET /frontdesk/journey/:patientId`, `GET /frontdesk/activity`) | One patient's appointments, lab bookings and scanned prescriptions in time order, each labelled voicebot / OCR scan / phone bot / staff and grouped by the scanned paper (`fileId`); the activity feed lists the latest from the apps across patients. Read only, derived from existing records; shown on the patient page and the dashboard (refreshes every 8 to 10 s) | PATIENT_READ + APPOINTMENT_READ + LAB_READ | none (reads) |
| Voicebot app (`apps/voicebot`) and OCR app (`apps/ocr-app`) | Two separate local programs (ports 5101, 5102), each its own MedOS user with the narrow role "Front-desk apps", calling the AI pod for listening, speaking, reading and the model, and MedOS only through the front-desk API; shared logic in `packages/frontdesk-core` | n/a (their own MedOS user) | their bookings are audited under their own user |
| Voice bot link (`modules/integrations`, `apps/voice-bridge`) | Records bookings the phone voice bot already confirmed, keyed by its confirmation number; see [`voice-bridge.md`](voice-bridge.md) | VOICE_BOOKING_SYNC (bot account only) | appointment events |

## Read side
| Module | Notes |
|---|---|
| Print | Server-rendered, fully escaped HTML or PDF (`?format=pdf`) for invoice, receipt, prescription, discharge summary and patient label, from one document model; locked-down CSP; reprints are stamped "DUPLICATE COPY"; every print is audited (`DOCUMENT_PRINTED`, with its format). |
| Reports | 13 bounded operational reports (date ranges ≤ 93 days, facility-scoped, `REPORT_READ`). |
| Audit viewer | Read-only list with filters; the table is append-only at the database level. |

## Known limitations
See [`certification.md`](certification.md#known-limitations).
