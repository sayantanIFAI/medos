# MLP-1 — Epics and User Stories

Status key: **Done** = implemented and covered by an executed automated test; **Done (UI untested)** = implemented, verified only manually or at API level; **Gap** = not confirmed built (see `docs/certification.md` §5); **Deferred** = consciously postponed (`REMINDER.md`). **Planned** = designed for MLP-2, not built; **Later** = planned for a later phase.
Roles: REC reception, DOC doctor, NUR nurse, CSH cashier, PHM pharmacist, MGR manager, ADM administrator.

## E1 Platform, authentication and authorization
| ID | Story | Acceptance criteria | Status |
|---|---|---|---|
| 1.1 | As any user I log in with hospital code, username or email, and password | Wrong credentials give a generic error; inactive users cannot log in; lockout after repeated failures | Done |
| 1.2 | As a user my session stays alive and can be ended | 15-min access token, rotating refresh token, reuse revokes the family, logout revokes | Done |
| 1.3 | As a user I change my password | Old password required; other sessions revoked | Done |
| 1.4 | As ADM I manage users and roles | Create, deactivate, assign roles; change takes effect on the next request | Done |
| 1.5 | As ADM I use custom roles | API supports custom roles; no dedicated editor screen confirmed | Gap (UI) |
| 1.6 | As the system I enforce permissions server-side | Every route declares a permission; 403 with stable code otherwise | Done |
| 1.7 | As the system I isolate tenants | Cross-tenant id sweep returns 404 on every route | Done |
| 1.8 | As the system I rate-limit auth endpoints | 429 after threshold (per instance) | Done / Deferred (shared limiter) |

## E2 Tenant, facility and master data
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 2.1 | ADM maintains facility, departments | Create, edit, inactivate | Done |
| 2.2 | ADM maintains wards, rooms, beds | Hierarchy; bed status explicit | Done |
| 2.3 | ADM maintains practitioners and their weekly schedules | Schedule editor changes bookable slots | Done |
| 2.4 | ADM maintains the service catalogue and prices | Used for charges and invoices | Done |
| 2.5 | ADM sets print header/footer, GST details, feature flags | Prints reflect settings; flags hide menus | Done |
| 2.6 | ADM configures numbering | Concurrency-safe sequences for MRN, visit, admission, invoice, receipt, prescription | Done |
| 2.7 | Supplier management screen | Create and edit suppliers | Gap (UI) |

## E3 Patient registration and identity
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 3.1 | REC registers a patient in under 45 seconds | Required fields only; MRN generated transactionally | Done |
| 3.2 | REC is warned about possible duplicates | Matches by mobile, name+mobile, name+DOB; never auto-merge | Done |
| 3.3 | REC deliberately creates a new patient despite matches | Needs DUPLICATE_OVERRIDE; audited | Done |
| 3.4 | Any clinician searches patients | By MRN, mobile or name; tenant-scoped; indexed | Done |
| 3.5 | REC edits demographics | Optimistic version check; audited | Done |
| 3.6 | REC uploads a photo and scanned documents | PNG/JPEG/PDF ≤ 5 MB, content-checked; one active photo; remove keeps history | Done |
| 3.7 | Patient identifiers beyond MRN | Separate identifier model | Done (model) |
| 3.8 | Patient merge tool | Merge duplicates | Deferred (backlog) |

## E4 Appointments and OPD queue
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 4.1 | REC books an appointment against a doctor schedule | Only free slots; no double booking even under race | Done |
| 4.2 | REC reschedules and cancels | Reason on cancel; state rules enforced | Done |
| 4.3 | REC marks no-show | Allowed only from BOOKED | Done |
| 4.4 | REC checks a patient in | Token issued per doctor per day | Done |
| 4.5 | REC creates a walk-in | Idempotent; queue entry created | Done |
| 4.6 | DOC calls next or a chosen patient | SKIP LOCKED; one doctor, one consultation at a time | Done |
| 4.7 | REC/DOC changes queue priority or emergency | Order changes; audited | Done |
| 4.8 | Overbooking by exception | Needs APPOINTMENT_OVERBOOK | Done |

## E5 Clinical: vitals, allergies, consultation, prescription
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 5.1 | DOC/NUR records vitals against an encounter | Append-only; wrong entry marked "entered in error" | Done |
| 5.2 | DOC/NUR records allergies | Severity; status history | Done |
| 5.3 | DOC records diagnoses | Add and remove with history | Done |
| 5.4 | DOC writes a consultation note as draft | Draft persists; unsaved text survives prescription save | Done |
| 5.5 | DOC creates a prescription | One draft per encounter; allergy matched to every item | Done |
| 5.6 | DOC signs the consultation | Note becomes immutable; prescription signed with it | Done |
| 5.7 | DOC amends a signed consultation | Reason required; every version kept with actor and time | Done |
| 5.8 | DOC stops or amends a signed prescription item | Amendment supersedes; original kept | Done (API) / Gap (UI) |
| 5.9 | Allergy override | Warning shown; acknowledgement audited | Done |

## E6 Billing and payments
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 6.1 | REC/CSH creates and edits a draft invoice | Server-side decimal totals | Done |
| 6.2 | CSH issues an invoice | Lines and totals frozen; DB rejects change | Done |
| 6.3 | CSH takes payment, split across modes | Cash, UPI, card, bank, other; overpayment rejected; idempotent | Done |
| 6.4 | CSH opens and closes a cashier shift | Cash needs an open shift; expected vs counted shown | Done |
| 6.5 | CSH issues a refund | Confirmation; cannot exceed paid; audited | Done |
| 6.6 | MGR applies a discount | INVOICE_DISCOUNT; audited | Done |
| 6.7 | MGR cancels an invoice or issues a credit note | Reason required; original preserved | Done |
| 6.8 | Receipts and invoices print | HTML and PDF; reprints stamped DUPLICATE COPY | Done |
| 6.9 | Advance payments and deposits | | Deferred (backlog) |
| 6.10 | GST/tax review | Per-line tax, MRP-inclusive medicines | Deferred (external review) |

## E7 Pharmacy
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 7.1 | PHM sees signed prescriptions first | Drafts never appear | Done |
| 7.2 | PHM dispenses with FEFO batch selection | No expired or blocked batch; no oversell under concurrency | Done |
| 7.3 | PHM takes payment while dispensing | Opens shift if needed; idempotent | Done |
| 7.4 | PHM handles patient returns | Stock restored to ledger | Done |
| 7.5 | PHM receives purchases | Batch and expiry recorded; ledger PURCHASE | Done |
| 7.6 | PHM returns stock to supplier | Ledger PURCHASE_RETURN | Done |
| 7.7 | PHM adjusts or writes off stock | Reason; ledger ADJUSTMENT/DAMAGE; confirmation | Done |
| 7.8 | PHM maintains the medicine master | Create and edit; audited | Done |
| 7.9 | Stock transfer between locations | | Gap |
| 7.10 | Ledger reconciles to balances | DB check on every change | Done |

## E8 Inpatient: beds and admissions
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 8.1 | REC admits a patient under a consultant | One active admission per patient | Done |
| 8.2 | REC/NUR allocates and transfers beds | Full assignment history; Ward A → ICU → Ward B reconstructable | Done |
| 8.3 | Bed status is explicit | AVAILABLE, OCCUPIED, RESERVED, CLEANING, MAINTENANCE | Done |
| 8.4 | Staff post charges to an admission | Catalogue or free-price (needs billing rights); void keeps record | Done |
| 8.5 | Bed-day charges accrue per assignment | Posted from history | Done |
| 8.6 | Cancel an admission | Allowed before clinical activity; audited | Done |

## E9 Nursing and medication administration
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 9.1 | NUR sees ward worklist | Admissions by ward and bed | Done |
| 9.2 | NUR records notes and addenda | Original never overwritten | Done |
| 9.3 | NUR records tasks | Create and complete | Done (API) |
| 9.4 | Medication schedule is generated from signed orders | Order and administration are separate | Done |
| 9.5 | NUR records Given, Held, Missed, Refused | Time, actor, remarks | Done (Given/Hold in UI; Missed/Refused API) |
| 9.6 | NUR records intake and output | Enter-in-error supported | Done |

## E10 Discharge
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 10.1 | DOC marks the patient fit for discharge | Prerequisite for clearances | Done |
| 10.2 | Departments clear their steps | Configurable steps; each audited | Done |
| 10.3 | Waive a step with a reason | Reason mandatory; audited | Done (API) / Gap (UI) |
| 10.4 | Consultant signs the discharge summary | Only the treating consultant | Done |
| 10.5 | CSH raises the final bill from pending charges | Charges marked billed | Done |
| 10.6 | Discharge completes only when paid | Part payment still blocks | Done |
| 10.7 | Completion releases the bed and closes the encounter | Bed goes to cleaning | Done |

## IPD additions: surgery and OPD-to-IPD conversion (MLP-2, planned)

These epics belong to the inpatient (IPD) area. They extend E8 (beds and admissions), E9 (nursing) and E10 (discharge). Roles used here: SUR surgeon, ANE anaesthetist, OTC OT coordinator, OTN OT nurse, DA Doctor Assistant. Surgery needs a new set of permissions (for example SURGERY_READ, SURGERY_CREATE, SURGERY_SIGN, OT_SCHEDULE, OT_CHECKLIST, ANAESTHESIA_RECORD) so that a signature stays with the right professional. Everything below is **Planned**; none of it is built.

## E10A Surgery and OT (part of IPD)
| ID | Story | Acceptance criteria | Status |
|---|---|---|---|
| 10A.1 | As SUR I create a surgical case linked to the patient's admission or OPD visit | Procedure, side (laterality), urgency (emergency, urgent, elective), expected stay and estimate; case number generated safely | Planned |
| 10A.2 | As the system I move a case through explicit states | PROPOSED, WORK_UP, READY, SCHEDULED, IN_THEATRE, IN_RECOVERY, POST_OP, CLOSED; no skipping; postponement and cancellation need a reason; every change audited | Planned |
| 10A.3 | As SUR I record surgical, anaesthesia and blood consent | Witness, language used, date and time; signed consent is immutable; a missing consent blocks scheduling | Planned |
| 10A.4 | As ANE I complete the pre-anaesthetic check | History, airway, ASA grade, fasting plan, planned anaesthesia type; signed by the anaesthetist | Planned |
| 10A.5 | As DA I order pre-operative tests and track medical fitness | Results linked to the case; missing or abnormal items flagged; physician fitness recorded | Planned |
| 10A.6 | As billing I prepare the estimate and package for the case | Package or itemised estimate; shown to the family; insurance pre-authorisation status tracked | Planned |
| 10A.7 | As the system I enforce a readiness gate before scheduling | Consent, PAC, fitness, estimate and bed must be complete; override needs a permission and reason and is audited | Planned |
| 10A.8 | As ADM I maintain OT masters | Theatres, tables, session templates, instrument sets and implant catalogue | Planned |
| 10A.9 | As OTC I book a theatre, date, time, team and bed | No double booking of a theatre, surgeon, anaesthetist or bed (enforced by the database) | Planned |
| 10A.10 | As OTC I handle emergency cases | Reserved emergency capacity; an emergency can pre-empt an elective slot with the bumped case rebooked and the reason recorded | Planned |
| 10A.11 | As OTN I confirm equipment, instrument sterility, implants and blood are ready | Checklist with sterile status and expiry; unready items shown as blockers | Planned |
| 10A.12 | As ward nurse I complete the pre-operative nursing checklist | Identity band, fasting, site marking, allergies, jewellery and valuables, pre-medication, consent present | Planned |
| 10A.13 | As the OT team we complete the WHO safety checklist | Sign In, Time Out, Sign Out with times and who confirmed; steps cannot be skipped; incision cannot be logged before Time Out | Planned |
| 10A.14 | As ANE I keep the anaesthesia record | Drugs, doses, fluids, vitals at intervals, events, blood loss; corrections keep history; signed by the anaesthetist | Planned |
| 10A.15 | As SUR I write the operation note | Procedure done, findings, implants, complications, plan; signed by the surgeon; later changes are amendments with reason | Planned |
| 10A.16 | As OTN I record swab, instrument and needle counts and specimens | Counts reconciled before closure; a mismatch must be resolved or escalated; specimens labelled and handed over | Planned |
| 10A.17 | As OTN I record implants and consumables used | Batch and serial numbers; posted as charges to the admission; implant details printable for the patient | Planned |
| 10A.18 | As the recovery nurse I record PACU observations | Vitals, pain, nausea, consciousness; criteria to leave recovery; destination ward or ICU | Planned |
| 10A.19 | As SUR I sign post-operative orders | Analgesia, fluids, antibiotics, diet, mobilisation, monitoring; flows into the nursing medication chart (E9) | Planned |
| 10A.20 | As billing I generate the surgery bill from the package | Package, theatre charges, surgeon and anaesthetist fees, consumables and implants; items used but not billed are flagged | Planned |
| 10A.21 | As the OT in-charge I keep the OT register | Auto-filled from cases, printable, cannot be edited after the day is closed | Planned |
| 10A.22 | As the infection-control nurse I monitor surgical site infection | Post-op follow-up check list; infection recorded against the case | Planned |
| 10A.23 | As MGR I see OT reports | Utilisation, first-case-on-time, turnover time, cancellations with reasons, by surgeon and theatre | Planned |
| 10A.24 | As the same-day surgery team I run a day-care pathway | Admit, operate, recover and discharge on the same day with the same safety gates | Planned |
| 10A.25 | As OTC I receive scheduling suggestions | Based on each surgeon's recorded durations, team and readiness; urgent cases always take priority over revenue; OTC approves | Later |
| 10A.26 | As OTN I track equipment location and readiness | Tags or barcodes with last-seen location and sterile status | Later |
| 10A.27 | As the OT team we use a timed theatre transcript draft | Audio only with consent and notice; draft only; surgeon and anaesthetist verify and sign; retention policy applied | Later |

## E10B OPD-to-IPD conversion tracker
| ID | Story | Acceptance criteria | Status |
|---|---|---|---|
| 10B.1 | As DOC I advise admission or surgery during an OPD consultation | Reason, urgency, expected stay, ward type and diagnosis recorded as an admission advice linked to the OPD visit | Planned |
| 10B.2 | As the system I track each advice through explicit states | ADVISED, ACCEPTED, ADMITTED, DEFERRED, DECLINED, REFERRED_OUT, LOST; a reason is mandatory for DECLINED, REFERRED_OUT and LOST; every change audited | Planned |
| 10B.3 | As REC I admit from an advice in one step | Patient, diagnosis, consultant and bed preference pre-filled; the admission is linked back to the advice; no automatic admission | Planned |
| 10B.4 | As REC or MGR I see a conversion tracker board | List by status, age of the advice, doctor, department and urgency; filters; overdue advices highlighted | Planned |
| 10B.5 | As DA I follow up patients who have not been admitted | Follow-up tasks with call outcomes and the next date; optional voice-bot reminders; the patient's choice is recorded | Planned |
| 10B.6 | As billing I attach an estimate and insurance check to the advice | Cost estimate or package, eligibility and pre-authorisation status shown to the family before they decide | Planned |
| 10B.7 | As the bed manager I run a waiting list when no bed is free | Ordered by clinical urgency, then time; bed becoming free offers the next patient; changes audited | Planned |
| 10B.8 | As SUR I convert an advice of surgery into a surgical case | Creates the case in E10A with the OPD findings carried over; the tracker shows the case state | Planned |
| 10B.9 | As the emergency doctor I use a fast path from OPD to admission | Marked urgent, skips the waiting list, notifies the ward and bed manager; reason recorded | Planned |
| 10B.10 | As MGR I see conversion reports | Advised vs admitted rate, time from advice to admission, drop-off reasons, by doctor, department and diagnosis | Planned |
| 10B.11 | As the patient or family I receive reminders and instructions about the advised admission | In the chosen language; what to bring, fasting, cost estimate; opt-out respected | Planned |
| 10B.12 | As DOC I see rule-based suggestions that a patient may need admission | Transparent criteria set by the hospital for named conditions; the doctor must accept; nothing admits a patient automatically | Later |
| 10B.13 | As the system I keep privacy and permission rules | Only staff with admission or follow-up permission see the tracker; patient details are limited to what the role needs | Planned |

## E11 Reports
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 11.1 | MGR runs 13 operational reports | OPD counts (daily, doctor, department), collections, payment modes, cashier shifts, current and daily admissions, discharges, occupancy, pharmacy sales, stock, low stock, near-expiry, outstanding | Done |
| 11.2 | Ranges are bounded and facility-scoped | ≤ 93 days | Done |
| 11.3 | MGR exports a report to CSV | Formula-injection safe | Done |

## E12 Audit
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 12.1 | Every important mutation writes an audit event | Same transaction; actor, entity, request id | Done |
| 12.2 | ADM/MGR views and filters the audit log | Read-only; append-only at DB level | Done |

## E13 Printing and documents
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 13.1 | Print invoice, receipt, prescription, discharge summary, patient label | One document model → HTML or PDF; escaped; audited | Done |
| 13.2 | Admission form print | | Gap |
| 13.3 | Indic scripts in PDF | Needs embedded Unicode font | Deferred |

## E14 Localisation
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 14.1 | User switches the UI to Bengali or Hindi | ~600 strings; fallback to English; Latin digits | Done |
| 14.2 | Native-speaker translation review | | Deferred |

## E15 Quality, security and operations
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 15.1 | Mandatory OPD and IPD workflows pass end-to-end | API and browser, real database | Done |
| 15.2 | Security tests: IDOR, replay, concurrency, state transitions | Automated | Done |
| 15.3 | Backup and verified restore | Scripts; manual drill passed | Done (manual) |
| 15.4 | Seed realistic synthetic data | 1,000 patients, 12 admissions, 100 medicines, 50 invoices | Done |
| 15.5 | Docker images, compose, CI | Written, never run | Deferred |
| 15.6 | PostgreSQL RLS, shared rate limiter, PITR, encryption | | Deferred |
| 15.7 | Clinical, GST, DPDP, penetration, accessibility reviews | External | Deferred |

## E16 Shell and UX
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 16.1 | Role-appropriate navigation | Derived from permissions and feature flags | Done |
| 16.2 | Global patient search in the shell | Fast, tenant-scoped | Done |
| 16.3 | Dashboard per role | Worklists and counts | Done |
| 16.4 | Clear errors, no internal terms | Stable codes mapped to sentences | Done |
