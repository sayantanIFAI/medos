# Voice bot link (BAANI → MedOS) — demo

Bookings made by phone through the voice bot ([sayantanIFAI/voicebot](https://github.com/sayantanIFAI/voicebot), running on a RunPod pod) appear in MedOS as appointments: the patient is registered, the booking carries a "Voice bot" label on the Appointments screen, and every step is audited. A cancellation or reschedule made through the voice bot is cancelled in MedOS too.

**Nothing on the pod is changed.** The bridge only reads what the voice bot already writes. No code is deployed there, nothing is restarted, and nothing is pushed to the voicebot repository.

## How it is connected

```
 caller ──► voice bot (pod) ──► clinic API books the slot, speaks the confirmation number,
                                and appends one line to /workspace/booking_log.csv
                                              ▲
            read only, over SSH               │  (the laptop dials out; nothing is opened inward)
                                              │
 laptop:   voice bridge ──────────────────────┘
              │  PUT /integrations/voice/…  (the bot's own MedOS login, one narrow role)
              ▼
           MedOS API ──► PostgreSQL
```

Every five seconds the bridge runs two read-only things on the pod over SSH:

1. **Read new lines of the booking log** (`stat`, `head`, `tail -c`). It keeps a byte position, so it only ever reads what is new, and after the laptop was off it catches up.
2. **Ask the voice bot's own lookup endpoint** whether a booking is still confirmed. This is `curl` to `127.0.0.1:8080` run *on the pod* with the pod's own token, so the token never leaves the pod. A booking is recorded in MedOS only while the clinic API still holds it as confirmed, and one that stops being confirmed (cancelled, or rescheduled to a new number) is cancelled in MedOS.

**Why this way**

- **The voice bot never depends on MedOS.** A phone booking is complete before MedOS hears of it, so a MedOS outage or a sleeping laptop cannot make a caller wait.
- **Nothing to deploy or restart on the pod.** It reads files and an endpoint that already exist.
- **Safe to repeat.** Every write is keyed by the voice bot's confirmation number: running twice, or deleting the bridge's state file, never books or registers twice.
- **No patient details kept by the bridge.** Its state file (`.local/voice-bridge-state.json`) holds booking numbers and a read position only; its log lines hold booking numbers and counts only.

## What was added (all in MedOS)

| Where | What |
|---|---|
| MedOS API `modules/integrations/voice.*` | `PUT /integrations/voice/doctors/:ref`, `PUT /integrations/voice/bookings/:ref`, `POST /integrations/voice/bookings/:ref/cancel`. Permission `VOICE_BOOKING_SYNC`. 13 tests in `voice.spec.ts` |
| MedOS schema | `Appointment.externalRef` (unique per hospital), `Appointment.source = VOICE_BOT`, `Practitioner.externalRef`. Migration `voice_bridge_refs` |
| Appointments screen | A "Voice bot" label on bookings the voice bot made |
| `apps/voice-bridge` | The bridge. 24 unit tests. Demo roster of doctors in `data/kcd-doctors.json` |
| `scripts/voice-bot-provision.mjs` | Creates the bot's MedOS user and role, writes `.local/voice-bridge.env` (the password is never printed) |

The bot's MedOS role ("Voice bot (BAANI)") can record voice bookings, read patients and appointments, and register a new patient. It cannot read invoices, prescriptions, notes or the audit trail, and cannot take any other action.

## Rules the bridge follows

- **Doctors come from a roster file.** The pod's booking log names the doctor but carries no doctor id, so MedOS finds the doctor by exact name (ignoring case); an unknown or ambiguous name is refused, not guessed. `data/kcd-doctors.json` holds the voice bot's 50 fictional doctors (from the voicebot repo seed at commit `c587a2e`, the version running on the pod) with their weekly chamber windows. All 11 doctor names in the pod's current log match it.
- **Patients are never merged automatically.** Same mobile number and same first name is treated as the same caller returning, so that patient is reused. Anything less certain creates a new patient and records a duplicate override for reception to review.
- **The voice bot owns slot rules.** MedOS does not re-check its own schedule for a booking the caller was already promised, but still refuses an overlap with another booked appointment.
- **Times are Kolkata time** (fixed +05:30).
- **Past bookings are skipped**, because MedOS refuses past appointments. The pod's current log is entirely in the past, so nothing from it is imported.
- **A booking MedOS refuses is parked, not lost,** and listed by the `once` command with a reason code (never the patient's details). `DOCTOR_NOT_MAPPED` means the doctor is not in MedOS; `PATIENT_AGE_REQUIRED` means a new caller gave no age. After fixing the cause, `replay` reads the log again (safe).

## Running it

One-time (MedOS running: `scripts/db-up.ps1`, then the `medos-api` and `medos-web` previews):

```powershell
$env:MEDOS_ADMIN_PASSWORD = "<the hospital administrator's password>"
node scripts/voice-bot-provision.mjs --ssh-host <pod ip> --ssh-port <pod ssh port>
pnpm --filter @medos/voice-bridge build
node apps/voice-bridge/dist/main.js doctors     # load the 50 doctors into MedOS (once)
```

Then, any time:

```powershell
node apps/voice-bridge/dist/main.js            # keep running; Ctrl+C to stop
node apps/voice-bridge/dist/main.js once       # catch up once, list anything needing attention, exit
node apps/voice-bridge/dist/main.js replay     # read the whole log again (nothing is booked twice)
```

The SSH key defaults to `~/.ssh/id_ed25519`. A new pod has a new SSH address: run the provision script again with the new `--ssh-host` and `--ssh-port`.

## Verified

- **MedOS** (full run, 422 tests before this change set's last additions; the 13 voice tests re-run after): permissions, tenant isolation, idempotency, patient reuse, cancellation, clash, strict validation, doctor by name and by short id.
- **Bridge** (24 tests): log reading including a byte-order mark, quoted fields and a half-written last line; shell-safe lookups; temporary failures keep the read position; nothing booked twice; cancellations; no personal details in log or state.
- **Against the real pod, read-only:** the SSH connection, the whole booking log (25 lines, all parsed, all 11 doctor names matched), and the pod's own lookup endpoint all work.
- **Against a local copy of the clinic API and real MedOS** (earlier rehearsal): 8 bookings recorded with patients and record numbers, a clinic-side cancellation carried across, a second run changed nothing.
- **Not yet seen with a live voice booking.** That is the demo itself.

## Limits

- **Availability is the voice bot's.** A slot booked at the MedOS reception desk is not seen by the voice bot. Making MedOS the source of slots is the next step for one shared calendar, and needs a change on the pod side.
- **A reschedule** is seen as the old booking no longer being confirmed, so it is cancelled in MedOS; the new booking (it gets a new number that never appears in the log) is not copied. Cancellations and new bookings are exact.
- **Lab-test bookings** by voice are not carried over (MedOS has no lab module yet).
- **Runs only while the command is running** on the laptop, and the laptop and pod must be reachable.
- The pod's service-token file `/workspace/.clinic_api_token` is world-readable (mode 666). That is a pod matter for the voice bot's owner; nothing here changes it.
