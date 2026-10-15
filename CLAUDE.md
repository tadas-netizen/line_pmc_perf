# CLAUDE.md

k6 performance tests for **pmc-line** (the LINE OA water-ordering app: storefront `/api/*` + admin
portal `/api/admin/*`, Next.js on Vercel, Firestore + GCS). This repo holds scripts only. The
system under test lives in the sibling checkout `../pmc-line`.

## Sources of truth

| What | Where | Authoritative for |
|---|---|---|
| API spec for load testing | `docs/api-spec-loadtest.md` (copied from the team's doc, 2026-10-12) | the 30 operations: paths, bodies, statuses, error messages, auth / scoping rules, the priority lines and their TPS ("List Load Test") |
| The app itself | `../pmc-line` (`src/app/api/**`, `packages/core/src/schemas.ts`) | when the spec and the code disagree, the code wins — then update the spec and the README table "How this differs from the spec" |
| Test accounts / seed | `../pmc-line` `pnpm seed:users`, `pnpm seed:perf` (spec §1.2–1.3) | usernames, roles, the perf data set |
| The previous toolkit | `../perf_test` (pmc-perf for pmc-api) | this repo is a port of its structure: lib / scenarios / scripts / runner. Same gate, same windows, same reports. Not a dependency |

Check `../pmc-line` freshness before relying on it: `git -C ../pmc-line log -1 --format=%cd`. On
2026-10-14 the local checkout was older than the spec (no users / partners sub-routes, no seed
scripts): the spec was written against `main` of 2026-10-12.

## Scenario numbering

TS-01 isolated endpoint (36 entries, one per operation / read mode) · TS-02 storefront (LINE OA
customer: products → discount → order) · TS-03 admin order desk · TS-04 admin dashboard · TS-All =
TS-01 (all) → TS-02 → TS-03 → TS-04 in sequence. Soak / stress / spike use the **priority mix**
(the spec's five TPS lines, one request per iteration).

## Conventions

- Every HTTP call goes through `lib/http.js` with a `name` tag (`<group>.<step>`). New tags must be
  added to the tag lists in `lib/thresholds.js` and to `lib/apiIds.js`, or they won't be gated / get
  no API ID in results.csv.
- **Targets: mock, local, stg, prod. No default.** `lib/config.js` refuses to start without
  `PERF_TARGET` or an explicit `PERF_BASE`. The stg / prod hosts live in `.env.stg` / `.env.prod`
  (`PERF_STG_BASE` / `PERF_PROD_BASE`), never in code.
- **Typed confirmation is a safety feature. Never weaken it:** stg / prod runs need
  `PERF_CONFIRM=STAGING` / `PRODUCTION` per run (scripts) and a typed modal (runner); a remote
  base that is neither needs `CUSTOM`. Don't store `PERF_CONFIRM` anywhere, and never run anything
  against stg or prod yourself unless the user explicitly asks for that run.
- **Login once per run.** `POST /api/admin/login` is bcrypt cost 12: the scenarios sign each role in
  once in `setup()` (`lib/auth.js sessions`) and share the cookie through setup data. Only the
  `auth` scenario and TS-01 `auth.login` log in per request, on purpose.
- Our own env vars use the **`PERF_` prefix**. Never name one `K6_*` (k6 reads any `K6_<OPTION>` as
  its own option). Only real k6 settings keep the `K6_` prefix.
- Validate after any change: `npm run inspect`, then `scripts/dry-run.sh smoke` (mock). New request
  paths need a matching route in `scripts/mock_line.py`.
- Against a real environment, `npm run smoke` must pass before any load run.
- `tools/runner.py` (web UI) whitelists scenarios and variables in its `CASES` table. A new scenario
  or `PERF_*` knob needs an entry there, or the page can't run or set it. Regenerate
  `docs/runner-settings.md` with `npm run settings-md` after editing `CASES`.
- `data/` and `results/` are gitignored. Never commit `.env` or anything with a password.
- Writes leave data behind (orders, perf products / codes / partners / users, GCS files) — the
  README's "What a run leaves behind" lists it; keep that list current when adding a write.
