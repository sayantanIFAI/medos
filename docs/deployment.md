# Deployment, backup and recovery

Status of each item is stated honestly: **verified** means it was run in the development environment; **written, not run** means the file exists but this environment could not execute it.

## Environments

| | local | staging | production |
|---|---|---|---|
| PostgreSQL | project cluster on `127.0.0.1:54329` (`scripts/db-up.ps1`) or compose `db` | own instance | **managed PostgreSQL** (recommended) |
| Secrets | `.env` (git-ignored) | secret manager | secret manager |
| Data | synthetic seed only | synthetic or anonymised | real; never copied downwards |

Each environment has its own database, secrets and domain. Never point staging or local at production data.

## Configuration

All configuration is environment variables (`.env.example` lists them). The API refuses to start with a missing or short `JWT_ACCESS_SECRET` (< 32 chars) or an invalid `DATABASE_URL`. Do not commit `.env`; do not bake secrets into images.

## Docker (written, not run)

`docker/api.Dockerfile` builds shared → database (Prisma client) → API, and runs as the non-root `node` user with a health check on `/api/v1/health`. `docker-compose.yml` starts PostgreSQL 17, runs migrations once (`migrate`), then starts the API.

```bash
cp .env.example .env      # then set real secrets
docker compose up -d --build
```

Docker is not installed on the development machine, so these files have **not** been built or started here. First step on any machine with Docker: build, start, and call `GET /api/v1/health/ready`. The runtime image is the full build image (simple and correct, but larger than a pruned image); pruning with `pnpm deploy` is a later optimisation.

## Migrations

`pnpm db:migrate` runs `prisma migrate deploy` (non-interactive, safe in CI). Never edit a migration that has been deployed; add a new one. Several migrations contain hand-written SQL (triggers, constraints) that Prisma does not model.

## Seed data (verified)

```powershell
$env:SEED_PASSWORD = '<choose a password>'   # omit to generate one (printed once)
pnpm db:seed
```

Creates one tenant (`demo-hospital`) through the real API: 8 departments, 10 doctors, 12 nurses, 6 other staff, 1,000 patients, 100 booked appointments plus 30 current OPD visits, 20 beds in 2 wards, 12 admissions, 100 medicines with 200 batches, 50 invoices (some paid, some outstanding). Takes ~35 s. Re-running does nothing if the tenant exists. It refuses to run when `NODE_ENV=production`.

## Backup and restore (verified)

```powershell
.\scripts\backup.ps1  -Database medos_dev -OutDir D:\backups      # pg_dump custom format + SHA-256 + readability check
.\scripts\restore.ps1 -File D:\backups\<file>.dump -Database medos_restored   # refuses to overwrite an existing database
.\scripts\restore-test.ps1 -Source medos_dev                       # full drill
```

`restore-test.ps1` backs up, restores into a scratch database, and compares row counts, money totals and stock units for 15 checks, then proves the append-only audit trigger still blocks edits in the restored copy. Last run: **15 checks identical, triggers intact**.

Production requirements not covered by these scripts:

- **Point-in-time recovery** (WAL archiving or the managed provider's PITR). Logical dumps alone lose everything since the last dump.
- **Encryption at rest** for backups and the database volume; store backups off the database host.
- A **scheduled** backup job and a **scheduled restore drill**. A backup that has never been restored is not evidence of recoverability.

## Health and logging

- `GET /api/v1/health` (liveness) and `GET /api/v1/health/ready` (database reachable).
- Logs are structured JSON on stdout with `requestId`, tenant, facility and user ids, route, status and duration. Passwords, tokens and clinical content are never logged. Ship stdout to the platform's log collector.

## Known limitations

- Rate limiting is in-process (per API instance). Behind several instances the effective limit multiplies; a shared store (Redis) is a backlog item.
- One advisory item remains in `pnpm audit`: `@nestjs/core` ≤ 11.1.17 (moderate). It requires a Nest 11 upgrade.
- Production deployment should require explicit approval; there is no auto-deploy.
