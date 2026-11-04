# Voicebot app

A separate program on the front-desk laptop (ADR-011). It listens and speaks in Hindi or English through the AI pod, understands what the caller wants, and books doctors and lab tests into MedOS through the front-desk API, signed in as its own narrow MedOS user (`voicebot-app`).

Page: http://localhost:5101 (this computer only).

## Set up (once)
1. MedOS running (`scripts\apps-up.ps1` starts everything) and the AI pod host running (`apps/ai-host/README.md`).
2. Create the app's MedOS user and settings file:
   ```powershell
   $env:MEDOS_ADMIN_PASSWORD = "<the hospital administrator's password>"
   node scripts/frontdesk-apps-provision.mjs --tenant <hospital code>
   ```
   This writes `.local/voicebot.env` (git-ignored; holds the app's password, never printed).
3. `pnpm --filter @medos/voicebot build`, then `node apps/voicebot/dist/main.js` (or `scripts\apps-up.ps1`).

## Settings (`.local/voicebot.env`)
`MEDOS_URL`, `MEDOS_WEB_URL`, `MEDOS_TENANT`, `MEDOS_USER`, `MEDOS_PASSWORD`, `AI_URL` (the tunnel, `http://127.0.0.1:8765`), `AI_TOKEN`, `LLM_MODEL` (`qwen2.5:14b`), `VOICEBOT_PORT` (5101).

## Use
Press **Speak** (allow the microphone), say for example "मुझे कल सुबह बच्चों के डॉक्टर से अपॉइंटमेंट चाहिए", then answer its questions (name, age, mobile). It reads the booking back and books only after "हाँ". If speaking is misheard twice it suggests typing. Bookings appear on the MedOS dashboard card "Voicebot and OCR activity" and on the patient's journey.

## Rules
Rates, doctors, free times and booking numbers come from MedOS; the language model only decides what was asked; every reply is a template. See ADR-010 and ADR-011. Tests: `pnpm --filter @medos/voicebot test` (routes), and `apps/api/src/modules/frontdesk/frontdesk.spec.ts` (the same dialogue against the real MedOS API).
