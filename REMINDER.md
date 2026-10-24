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
