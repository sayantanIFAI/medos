# MedOS MLP-1 — Manual Test Guide by User

Start: http://localhost:3000. Hospital code `demo-hospital`. Password for every user: `Demo-Passw0rd-2026!`.
Users: `reception1`, `doctor1`, `doctor2`, `nurse1`, `cashier1`, `pharmacist1`, `manager1`, `admin`. There is no sign-up: the administrator creates users (Admin → Users).
Each user sees only the menus their permissions allow; a missing menu is correct behaviour.

Suggested order: reception1 → doctor1 → cashier1 → pharmacist1 → nurse1 / doctor2 → manager1 → admin.

## 1. reception1 (Dashboard, Patients, Appointments, OPD queue, Admissions, Billing)
| Feature | How to test | What to check |
|---|---|---|
| Register patient | Patients → New patient; name, sex, DOB/age, mobile | MRN generated; photo upload (PNG/JPEG ≤ 5 MB) works |
| Duplicate detection | Register same name and mobile again | "Possible matches" list; choose existing or deliberately create new |
| Search | MRN, mobile, part of name | Fast and correct results |
| Edit patient | Edit address and save; save from two tabs | Saves; second stale save warns of conflict |
| Documents | Upload PDF, view, remove; try an .exe renamed .pdf | Removed file disappears; fake file rejected |
| Appointments | Book, reschedule, cancel (reason) | No double booking; reschedule moves the slot |
| Check-in / walk-in | Check in a booking; create a walk-in | Token appears in OPD queue |
| Queue | Change priority or emergency | Order updates |
| Admit | Admissions → Admit; consultant, ward, bed | Bed occupied; same patient cannot be admitted twice |
| Billing | Create and edit a draft invoice | Cannot issue or take payment |
| Print | Patient label | HTML and PDF open |
| Access | Open /admin or /pharmacy by URL | Denied or redirected |

## 2. doctor1 (OPD queue, Patients, Appointments, Admissions, Dashboard, Nursing)
| Feature | How to test | What to check |
|---|---|---|
| Call patient | OPD queue → call next | Status in consultation |
| Vitals | BP, pulse, temperature, SpO2, weight | In history; wrong entry marked "entered in error" |
| Allergy | Add e.g. Penicillin | Banner on the visit |
| Note | Complaints, examination, diagnosis; save draft | Draft persists on reload |
| Prescription | Add medicines; prescribe an allergic drug | Warning; override audited |
| Sign | Sign consultation | Note read-only |
| Amend | Amend with reason | Original kept in history with reason and actor |
| Print prescription | PDF | Correct number; reprint stamped DUPLICATE COPY |
| IPD orders | Admission → Orders; order and sign | Reaches nurse's medication chart |
| Discharge | Mark fit, sign summary | Final discharge blocked until bill paid |
| Access | No Billing or Pharmacy | Direct URLs denied |

## 3. doctor2
Same rights as doctor1. Test: a patient in consultation with doctor1 cannot be started by doctor2; amending another doctor's note works and the audit shows who; each doctor sees their own queue.

## 4. nurse1 (Nursing, Admissions, Patients, Dashboard)
| Feature | How to test | What to check |
|---|---|---|
| Ward view | Nursing | Counts match admissions |
| Vitals | Admission → Nursing tab | Latest and history update |
| Notes | Note then addendum | Original never overwritten |
| Medication chart | After doctor1 signs an order: Given / Hold / Missed / Refused | Separate from the order; time and actor recorded |
| Intake/output | Add, then mark one in error | Struck through, not removed |
| Bed transfer | Move to another bed/ward | History shows full path; old bed goes to cleaning |
| Clearance | Clear nursing step | Recorded |
| Access | No Billing or Pharmacy | Denied |

## 5. cashier1 (Billing, Dashboard, Patients)
| Feature | How to test | What to check |
|---|---|---|
| Open shift | Opening cash | Cash payments blocked without a shift |
| Invoice | Create and issue | Server totals; lines frozen after issue |
| Split payment | ₹500 cash + rest UPI | Balance zero, status PAID; overpayment rejected |
| Receipt | Print PDF | Unique receipt number |
| Refund | Partial refund, confirm | Cannot exceed paid |
| Charges | Add service charge to an admission | Appears in final bill |
| Final bill | Raise and pay for discharge | Discharge possible only after full payment |
| Close shift | Counted cash | Expected vs counted shown |
| Access | No discount or cancel | Those need manager1 |

## 6. pharmacist1 (Pharmacy, Billing, Patients, Dashboard)
| Feature | How to test | What to check |
|---|---|---|
| Prescription queue | Open Pharmacy | Signed prescriptions only, no drafts |
| Dispense | Dispense with payment | Earliest-expiry unexpired batch (FEFO); stock falls |
| Allergy | Dispense to allergic patient | Warning; acknowledgement audited |
| Insufficient stock | Dispense more than held | Clean rejection |
| Return | Patient return | Stock restored |
| Purchase | Supplier, medicine, batch, expiry, qty | Ledger shows PURCHASE |
| Purchase return | Return to supplier | PURCHASE_RETURN entry |
| Adjustment | Adjust/write off with reason | Movement recorded |
| Medicine master | Add/edit medicine | Appears in pickers |
| Low / near-expiry | Stock lists | Flagged items |
| Cash | Take cash | Prompt to open a shift |

## 7. manager1 (Dashboard, Reports, Billing, Audit)
| Feature | How to test | What to check |
|---|---|---|
| Reports | Run all 13 | Totals match what you created; >93-day range rejected |
| Export | Export CSV | Opens in Excel correctly |
| Discount | Discount on draft invoice | Recalculates; audited |
| Cancel invoice | Cancel issued unpaid invoice | Reason required; stays visible as cancelled |
| Adjust / credit note | Apply | Original lines unchanged |
| Audit | Filter by user, action, date | Entries in time order with right names |
| Access | No clinical editing, no Admin | Denied |

## 8. admin (Dashboard, Reports, Administration, Audit)
| Feature | How to test | What to check |
|---|---|---|
| Users | Create, assign role, deactivate, reactivate | New user can log in; deactivated user cut off at once |
| Roles | View roles | Permissions listed |
| Schedules | Edit a doctor's schedule | Appointment slots change |
| Masters | Departments, wards, rooms, beds | Appear in pickers |
| Services | Add a priced service | Appears in charges |
| Settings | Print header/footer, GST, feature flags | Prints change; turning IPD/Pharmacy off hides the menu |
| Numbering | Check formats | New records follow them |
| Audit | Review log | Read-only |
| Language | Switch to Bengali / Hindi | Labels change; digits stay Latin |
| Password | Account → Change password | Old password required |

## Checks for every user
Logout then Back must not show data; repeated wrong passwords lock the account; hidden menus are also denied by URL; double-click on Pay or Dispense must not act twice; untranslated strings fall back to English.

## End-to-end scenarios
1. **OPD:** reception1 registers and checks in → doctor1 vitals, diagnosis, prescription, sign → cashier1 invoice and split payment → pharmacist1 dispenses → manager1 confirms reports and audit.
2. **IPD:** reception1 admits → doctor1 orders medicine → nurse1 vitals, note, "Given" → add charge, transfer bed → doctor1 marks fit → nurse1 and pharmacist1 clear → cashier1 final payment → doctor1 discharges → bed shows "cleaning".

## Known gaps
Not confirmed in the UI: stock transfers, supplier management screen, custom-role editor, discharge waiver, OPD prescription stop/amend, admission form print. Report what you find.
