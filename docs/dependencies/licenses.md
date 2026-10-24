# Dependency Licensing Policy and Inventory

MedOS is proprietary commercial software. Engineering records licences as known at the time of review; this is **not legal advice or legal certainty**. Final licence review by counsel is required before distribution.

## 1. Policy

**Allowed by default (permissive):** MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, PostgreSQL License, 0BSD, BlueOak-1.0.0, CC0/Unlicense (data/tooling).

**Stop and report before adding:** GPL, LGPL, MPL, EPL, CC-BY-SA and any other reciprocal licence; AGPL; SSPL; RSAL/BUSL or other source-available licences; non-commercial restrictions; unclear or missing licences; anything needing paid production licensing.

**Before adding any dependency:** (1) identify the package, (2) identify its licence (and its transitive licences), (3) state why it is needed, (4) confirm no existing dependency solves it, (5) record it below. Fewer dependencies is better.

**Applies to:** npm packages, copied code (e.g. shadcn/ui components), fonts, icons, Docker base images, and infrastructure services we ship or tell customers to run.

**Tooling (Stage 1):** a `pnpm licenses` based audit command with an allow-list that fails CI on disallowed or unknown licences, plus `pnpm audit` for vulnerabilities. Output is committed as a machine-readable report at each release candidate.

## 2. Planned stack (licences believed; verify at install time with the audit tool)

| Component | Role | Licence (believed) | Status |
|---|---|---|---|
| Node.js | runtime | MIT | planned |
| TypeScript | language | Apache-2.0 | planned |
| pnpm | package manager | MIT | planned (not installed) |
| Turborepo | monorepo tasks | MIT | planned |
| Next.js / React | web | MIT | planned |
| Tailwind CSS | styling | MIT | planned |
| shadcn/ui + Radix UI | UI primitives (source copied in) | MIT | planned |
| TanStack Query | data fetching | MIT | planned |
| React Hook Form | forms | MIT | planned |
| Zod | validation | MIT | planned |
| NestJS | API framework | MIT | planned |
| Prisma (ORM/client/migrate) | data access | Apache-2.0 | planned |
| PostgreSQL | database | PostgreSQL License | planned |
| Playwright | E2E | Apache-2.0 | planned |
| Vitest or Jest | unit tests | MIT | planned |
| Docker Engine / Compose | local infra | Apache-2.0 (Docker Desktop has separate commercial terms for larger organisations) | planned; not installed |
| Argon2 binding (`argon2` or `@node-rs/argon2`) | password hashing | believed MIT | decide Stage 3 |
| Decimal library (e.g. `decimal.js`) | money maths | believed MIT | decide Stage 18 |

## 3. Flagged items — decision needed before Stage 1

| Item | Concern | Options |
|---|---|---|
| **Redis server** | Redis 7.4+ moved to RSALv2/SSPL; Redis 8 added an AGPLv3 option. Releases up to 7.2 were BSD-3-Clause. Not linked into our code (separate service), but hosting/redistribution terms must be reviewed. | **Valkey** (BSD-3-Clause, Redis-protocol compatible; recommended to evaluate), Redis ≤7.2.x (frozen, no fixes), managed cache from a cloud provider, or avoid Redis in MLP-1 (rate limiting and locks via PostgreSQL). Client library `ioredis` is MIT. |
| **MinIO** (S3-compatible dev/self-host storage) | AGPLv3; community edition status has also been changing. Running it unmodified as a separate service is commonly accepted, but AGPL is on the stop-and-report list. | Cloud S3 (AWS/R2) in all environments; SeaweedFS (believed Apache-2.0); local filesystem adapter for dev behind the same storage interface. Verify each before adoption. |

No decision has been made. These are reported, not added. Stage 1 will not add either service until approved.

## 4. Inventory of material runtime dependencies

None yet. Stage 0 adds no code and no dependencies. (`D:\Claude\package.json` at the workspace root belongs to unrelated work and is not part of MedOS.)

| Package | Version | Licence | Why needed | Added in stage |
|---|---|---|---|---|
| — | — | — | — | — |

## Audit result (2026-10-05)

`pnpm licenses:audit` (scripts/license-audit.mjs) scanned ~640 installed packages: MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, BlueOak-1.0.0, (MIT OR CC0-1.0), Python-2.0 (a permissive PSF licence, build-time only) and CC-BY-4.0 (data package, build-time only). **No GPL, AGPL, SSPL or unknown licences.** Redis and MinIO are not used (ADR-009). Playwright and Chromium are used for tests only (Apache-2.0 / BSD).
