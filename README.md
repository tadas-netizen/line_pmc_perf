# pmc-line-perf — k6 performance tests for pmc-line

Load tests for **pmc-line**, the LINE OA water-ordering app (storefront `/api/*` + admin portal
`/api/admin/*`; Next.js on Vercel, Firestore + GCS). The API under test is
[`docs/api-spec-loadtest.md`](docs/api-spec-loadtest.md) (30 operations, the team's spec of
2026-10-12). The toolkit is a port of `../perf_test` (pmc-perf for pmc-api): same layout, gate,
measured windows, reports and runner — rewritten for pmc-line's endpoints, cookie auth and data.

**Status: validated on 2026-10-14** against the local mock (`scripts/mock_line.py`) **and against the
real app** (`../pmc-line` main of 2026-10-14, booted by `scripts/local-stack.sh`: throwaway
emulators + the perf seed with 2,000 orders + a production build on :3100): smoke with every section
(85 checks, 0 failed requests), Check over all 17 read entries, TS-01 target / write, TS-02, TS-03 and
TS-04 all PASS. Nothing has run against stg / prod.

## Scenario numbering

| Scenario | What | Spec line |
|---|---|---|
| **Smoke** | one pass through every request path, strict checks | all 30 |
| **Check** | every ticked endpoint for a moment at a low rate, one k6 run — functional | — |
| **TS-01 Endpoint** | ONE endpoint at a fixed rate (target) or a ladder; 36 entries, one per operation / read mode | all |
| **TS-02 Storefront** | LINE OA customer: catalog → maybe a discount code → order with slip, as orders/s | #1 (10 TPS), #2, #3 |
| **TS-03 Admin orders** | the admin order desk: list → filter → next page → slip → note / status | #7 (50 TPS), #8, #9, #27 |
| **TS-04 Dashboard** | the admin dashboard: stats + partners together, sometimes a date range | #10 (50 TPS), #15 |
| **TS-All** | TS-01 (all endpoints) → TS-02 → TS-03 → TS-04, one after another | |
| **Soak / Stress / Spike** | the **priority mix**: one request per iteration drawn from the five spec lines by weight (order 10 · products 50 · admin orders 50 · dashboard 50 · admin products 10 → 170 TPS reproduces the table) | #1, #3, #7, #10, #11 |
| **Sign-in** | `POST /api/admin/login` on its own — bcrypt cost 12, a CPU measurement, never a throughput target | #5 |

## Target environments

Four targets: **mock**, **local**, **stg**, **prod**. **There is no default:** without a target
every script refuses to start, so a forgotten variable can never send load anywhere real.

| Target | How | Where |
|---|---|---|
| **mock** | `scripts/dry-run.sh <scenario>` or the runner's "local (mock)" | `scripts/mock_line.py` on 127.0.0.1:18090 — every route of the spec, 2,000 fake orders, the seed accounts |
| **local** | `PERF_TARGET=local PERF_BASE=http://localhost:3100 k6 run …` or the runner's "local pmc-line" | pmc-line on this machine, booted by `scripts/local-stack.sh up` the way its own `tests/load/run.sh` does: throwaway Firestore + fake-GCS emulators on 8085 / 4448 (in memory, never the dev stack's 8080 / 4443), the perf seed (`PERF_ORDERS`, default 2,000; the emulator fits ≈ 20,000), a **production build** on :3100 (a dev build's compile latency would fake the numbers). `down` discards everything |
| **stg** | `PERF_TARGET=stg PERF_CONFIRM=STAGING k6 run …`, or the runner's amber **STAGING** button | the host in `PERF_STG_BASE` (`.env.stg`) — **not stored in the repo** |
| **prod** | `PERF_TARGET=prod PERF_CONFIRM=PRODUCTION k6 run …`, or the runner's red **PRODUCTION** button | the host in `PERF_PROD_BASE` (`.env.prod`) — **not stored in the repo** |

An explicit `PERF_BASE` overrides the preset. A base on the stg / prod host is guarded like the
target; a base on any other remote host needs `PERF_CONFIRM=CUSTOM`.

### Human-error guard: typed confirmation

- **Scripts** (`lib/config.js`): any run that reaches stg or prod needs the word for that run:
  `PERF_CONFIRM=STAGING` or `PERF_CONFIRM=PRODUCTION`, exact and case-sensitive. **Never store
  `PERF_CONFIRM` in `.env` or a job definition.**
- **Runner:** selecting STAGING or PRODUCTION opens a modal where you must **type** the word
  (paste is blocked), and **every Run** on stg / prod asks again. The server checks the word too
  and passes it to k6 for that run only. The runner never takes `PERF_TARGET` / `PERF_CONFIRM` /
  `PERF_BASE` from `.env` files or from the shell it was started from.
- **`scripts/dry-run.sh`** is mock-only: it clears `PERF_TARGET` / `PERF_CONFIRM`.

**Accounts per environment:** shared values in `.env`, per-environment ones in `.env.local` /
`.env.stg` / `.env.prod` (read in that order). On local targets the **perf seed's** accounts are the
defaults (`perfadmin01` SUPER_ADMIN, `perfuser02` PARTNER_ADMIN, `perfuser03` PARTNER_VIEWER, all
`perf-pass`, spec §1.3) — `pnpm seed:users` no longer has fixed passwords (they come from `SEED_*`
env or are generated), so the spec's `admin / admin123` cannot be assumed. stg / prod must set their
own `PERF_ADMIN_*`, `PERF_PARTNER_*`, `PERF_VIEWER_*`. All `.env*` files are gitignored except
`.env.example`.

**Before any stg or prod run** (each item reaches real customers and admins on prod):
1. **Approval and window**, the team told before every run (the runner asks for this each time).
   Run stress last, or not at all, without a kill switch agreed.
2. **Dedicated perf accounts** (SUPER_ADMIN, PARTNER_ADMIN, PARTNER_VIEWER) and agreed partner
   codes. `PERF_PARTNERS` limits the storefront to perf partners if the catalog mixes real ones.
3. **Writes are real** (spec §1.4): `POST /api/orders` creates real orders, uploads real slips and
   advances the real running number; the admin writes change real order statuses / notes and
   create perf products, discount codes, partners and users. See
   [What a run leaves behind](#what-a-run-leaves-behind) and agree how perf data is excluded from
   reports and cleaned up. There is **no rate limit and no CSRF** on the app (spec §0): the only
   natural ceilings are Firestore / GCS quotas and the per-partner order counter.
4. **`POST /api/admin/login` is bcrypt cost 12**: the scenarios sign each role in **once per run**
   and share the cookie (12 h). Only the Sign-in scenario and TS-01 `auth.login` log in per
   request, on purpose and at 2/s.
5. **Vercel**: function duration, concurrency and bandwidth are billed; a spike scales functions
   out cold (the first 30 s at peak are reported separately).

## Commitment under test

**Exactly two conditions decide PASS/FAIL** (`lib/thresholds.js` `GATE`), both over the **whole
run: ramp up + hold + ramp down**:

| Gate | k6 threshold | default |
|---|---|---|
| **1. p95 latency ≤ gate** | `p(95)<=…`, blended **and** per endpoint (`name` tag) | 300 ms (`PERF_GATE_P95`) |
| **2. Error rate < gate**, where a response slower than the slow gate counts as an error | `req_failed rate<…` (`lib/http.js`: HTTP error **or** duration > slow gate) | 1 % (`PERF_GATE_ERR`), slow = 1 s (`PERF_GATE_SLOW_MS`) |

The numbers are inherited from pmc-perf; pmc-line has no agreed figure yet, so they are
env-overridable until the team decides (then change the defaults in `lib/thresholds.js`).

**Throughput unit: TPS** = HTTP requests per second. A TS-02 order is ≈ 2.3 requests, a TS-03
iteration ≈ 4, a TS-04 load ≈ 2.3, a mix iteration exactly 1.

Still **measured and reported, never gated**: p99 / max / avg / med / p90; the two parts of the
error rate (HTTP errors `httpErrRate`, slow responses `slowRate`); the checks rate; the **target
throughput** of TS-03 / TS-04 (requests vs 95 % of the offered rate over the window, verdict
`targetFloor` / `targetMet`); orders placed (TS-02); TS-01 achieved vs offered (`delivered`) and
prep failures. **Smoke** stays strict (every check must pass, no failed request). **Stop rules**
(stress stops at the first step over the gate; TS-01 ladders at p95 > 2× the gate or errors > 5 %)
end a run early; they don't decide PASS/FAIL.

## Layout

```
lib/
  config.js       env → config: targets, the typed-confirmation guard, accounts, partners, files
  auth.js         POST /api/admin/login → cookie pmc_admin_session; sessions() once per run in setup()
  http.js         get/postJson/putJson/patchJson/del/postMultipart wrappers: `name` tag, Cookie header, checks
  catalog.js      live test data: GET /api/products → partners + products; GET /api/admin/orders → the order pool
  data.js         the slip / image file (fixtures/slip.png), Thai statuses, Thai-time dates, ids
  endpoints.js    TS-01 catalogue: 36 entries (kind / who / api / db / rate / heavy / run)
  journeys.js     TS-02 storefront, TS-03 admin orders, TS-04 dashboard, the priority mix
  thresholds.js   the gate (env-overridable) + per-tag sub-metrics + tag lists
  phases.js       step plan + `phase` (measured window) and `stage` (ramp-up / hold / ramp-down) tags
  report.js       per-run report.html + results.csv
  errors.js       classifies failed requests: Vercel edge / pmc-line route / network
  apiIds.js       tag / scenario → the spec's operation ids (LN-01 … LN-30) for results.csv
  summary.js      handleSummary → summary.json + verdict.json
scenarios/
  smoke.js                1 VU × 1 pass, strict checks: is the SCRIPT working?
  check.js                every ticked endpoint for a moment at a low rate, one k6 run (functional)
  ts01-endpoint.js        ONE endpoint at a fixed rate, target or ladder, ramps measured
  ts02-storefront.js      customer orders at N orders/s (default 10 ≈ 23 TPS), spread over partners
  ts03-admin-orders.js    admin order desk at 50 TPS (≈ 12.5 iterations/s)
  ts04-dashboard.js       admin dashboard at 50 TPS (≈ 22 loads/s)
  auth.js                 bcrypt login at 2/s, standard shape
  soak.js                 the mix at 170 TPS, ramp 30 s → hold 15 min → ramp down 30 s
  spike.js                0 → 340 TPS in 10 s, hold 5 min (first 30 s = cold start, reported)
  stress.js               50 → 1,000 TPS in +50 steps, each 30 s ramp + 5 min hold, judged per step
scripts/
  mock_line.py      local mock of every route of the spec, for dry-running the scripts
  dry-run.sh        start the mock, point the scripts at it, run one scenario with the k6 dashboard
  local-stack.sh    the local target: throwaway emulators → perf seed → production build → :3100 (up / down / status)
  ts01-queue.sh     TS-01 Endpoint (Group Run): a list of endpoints, one after another (TS01_RATES)
  ts-all.sh         TS-All: TS-01 (all) → TS-02 → TS-03 → TS-04, one after another
  rollup.ts         verdict.json files → markdown comparison table
  entrypoint.sh     container entrypoint (scenario select, execution segments, outputs)
tools/
  runner.py         local web UI: pick a scenario, run it, watch live charts, replay past runs
  runner.html       its page (served by runner.py; no build, no external scripts; EN / TH)
  runner_th.py      Thai text for the settings table (the page's TH language)
fixtures/slip.png   the 59 KB PNG every order uploads (and the admin image uploads)
docs/
  api-spec-loadtest.md  the API spec (source of truth for paths, bodies, statuses, messages)
  runner-settings.md    every runner setting, generated from tools/runner.py (npm run settings-md)
Dockerfile          FROM grafana/k6:1.3.0
```

## Load shape

Every load scenario uses the same shape (kept from pmc-perf):

```
ramp up 30 s  →  HOLD 5 min  →  ramp down 30 s        ← all of it is measured and gated
PERF_RAMP        PERF_HOLD       PERF_RAMP_DOWN
```

- Requests carry two tags (`lib/phases.js`): `phase` = the measured window (`s1` = ramp up + hold
  + ramp down; in ladders step `sN` = its ramp + hold, the last also takes the ramp-down) and
  `stage` = `ramp-up` / `hold` / `ramp-down`, display only.
- **TS-02 / TS-03 / TS-04** run at a fixed arrival rate (`PERF_ORDERS_PER_SEC` /
  `PERF_TARGET_RPS`): the offered load holds even when the server slows. `PERF_VUS=<n>` switches
  TS-03 / TS-04 to n VUs walking back to back.
- **Soak** keeps a 15-min hold (`PERF_SOAK_HOLD`). **Spike** keeps its 10 s jump; the first 30 s at
  peak are also shown as `stage:coldstart`. **Stress** steps +50 TPS (`PERF_STRESS_STEP`), each
  step measured on its own window, stopping at the first step over the gate (judged 30 s in).

## Smoke test: check the script before any load

`scenarios/smoke.js` runs one pass through every request path with strict gates: checks must be
100 % and failed requests 0. `PERF_DEBUG=1` prints the status and body of every failed check.

| Section | What | Creates data |
|---|---|---|
| `public` | `GET /api/products`, `POST /api/discount/validate` (referral and promotion doors — both HTTP 200), `GET /api/product-image` (only with `PERF_IMAGE_FILE_ID`) | no |
| `auth` | login as every configured role (super / partner / viewer), logout | no |
| `neg` | no cookie → 401 · viewer write → 403 · partner admin asking for another partner → 403 · inactive account → 401 (`PERF_INACTIVE_USER` / `_PASS`) | no |
| `ts01` | every TS-01 **read** endpoint once, through TS-01's own code | no |
| `order` | ONE real order with a slip | **1 order + 1 slip in GCS** |
| `writes` | every TS-01 **write** endpoint once | perf product / partner / user / code (inactive), images |

```sh
npm run smoke                                    # public,auth,neg,ts01 (read-only, default)
npm run smoke:all                                # + order, writes
PERF_SMOKE_SECTIONS=public,neg npm run smoke     # pick sections
```

**Dry run without a real environment:** `scripts/dry-run.sh <scenario>` starts the mock, points
the scripts at it, runs k6 (with the web dashboard at http://127.0.0.1:5665, saved as
`results/<run>_report.html` on k6 ≥ 0.49) and stops the mock. Dry runs default to shorter holds
(`PERF_HOLD=2m`, soak 2 min, stress 20 s steps up to 150 TPS). `MOCK_ERROR_RATE=0.05` makes the
mock fail 5 % of calls (half as the app's 500 envelope, half as a Vercel 504 page) to rehearse the
error reporting. A mock pass proves the script, not the app.

```sh
scripts/dry-run.sh smoke
scripts/dry-run.sh check
PERF_ENDPOINT=admin.dashboard PERF_STEPS=5,10,20 scripts/dry-run.sh ts01
PERF_HOLD=5m scripts/dry-run.sh ts03
DASHBOARD=0 scripts/dry-run.sh ts02
```

## Reports

Every load run writes these files (`lib/report.js`, `lib/errors.js`):

| File | Made by | What it is |
|---|---|---|
| `<run>_<scenario>_round-N_report.html` | k6 (`handleSummary`) | Self-contained page: PASS/FAIL banner; KPI tiles; one row per measured window (all requests + each endpoint tag, or each step), expandable to the gate, latency spread, status codes, where the time went, that tag's checks; p95 bars against the gate; steps and capacity; notes (target throughput, orders placed, cold start, stress crossing points); checks; the run's settings (passwords hidden). `#light` forces the light theme. |
| `…_results.csv` | k6 (+ `tools/runner.py` for error times) | One row per measured window: run, date, target, scenario, row, window, requests, avg/min/med/p90/p95/p99/max, error %, TPS, offered TPS, PASS/FAIL, notes, **ID** (the spec's operation id `LN-07`, or `TS-03`), start / end time (Thai time). Paste into the results sheet (runner: "copy rows"). |
| `…_summary.json` / `…_verdict.json` | k6 | Full k6 data / the compact verdict (`scripts/rollup.ts` reads these). |
| **Error detail** section in the HTML | `tools/runner.py`, after the run | Every failed request classified by **where it failed**: Vercel edge (timeout 504, payload 413, WAF, 502), the pmc-line route (its `{success:false, error}` envelope, with the error text as the code), or network; counts, time range and a per-minute table. |
| `…_report.png` | `tools/runner.py` (needs Google Chrome) | Light-theme screenshot of the report. |

`node scripts/rollup.ts results` builds the markdown comparison across runs.

## Runner (local web UI)

```sh
python3 tools/runner.py            # or: npm run runner
# open http://127.0.0.1:8765 → target → scenario → settings → Run
```

- **Targets:** mock (starts `scripts/mock_line.py`), local pmc-line (:3100; a checklist with
  status lights — app answering, products present, admin login, slip fixture — and "prepare now"
  = `scripts/local-stack.sh up`, a few minutes the first time), STAGING and PRODUCTION (typed word
  to select and before every run).
- **Only whitelisted scenarios and variables can be run** (`CASES` in `tools/runner.py`). The page
  sends no paths or URLs; it listens on 127.0.0.1 only; POSTs need its own header.
- **Live charts** from k6's raw output (`K6_OUT=json` into `results/_live/`): TPS vs target, p50 /
  p95 vs the gate, responses by status, hold shaded, KPIs, failed requests by tag + status, error
  detail + errors per minute. The per-second series is kept as `results/<run>_live.json` for replay.
- **Endpoint checklist** (TS-01 Group Run / Check): quick picks reads / heavy / auth / writes /
  **no DB write** / all / none, a TPS box per endpoint (placeholder = the endpoint's default from
  the spec's lines), what each call leaves in the DB, "use last passing rate" from this target's
  passing TS-01 runs.
- **Run plan** (duration, requests, peak TPS, orders created, write requests), the account checks
  (only what the run needs blocks it: public endpoints need none), the "Heads-up" / "Started" /
  "Finished" chat messages, the result table with the reason for each FAIL, Peak for ladders, rows
  for the results sheet, history with replay. The latest run survives a runner restart.
- **Language:** EN / TH (`tools/runner_th.py`). Settings guide:
  [`docs/runner-settings.md`](docs/runner-settings.md).

## TS-01: individual endpoint test

TS-02/03/04 are journeys. TS-01 tests **one endpoint at a time** at a rate you set
(`PERF_RPS`, default = the endpoint's `rate` in `lib/endpoints.js`: 50 for the spec's admin orders
/ products / dashboard lines, 10 for `orders.create`, 20 other reads, 5 writes, 2 bcrypt-bound
calls, 1 heavy reads) or a ladder (`PERF_STEPS=25,50,100`: capacity = the highest step within the
gate).

| Group | Entries | Leaves behind |
|---|---|---|
| `focus` (5) ★ | the spec's "List Load Test" lines: `orders.create` (10 TPS), `products.list` (50), `admin.orders.list` (50), `admin.dashboard` (50), `admin.products.list` (10) — `npm run ts01:focus`, the runner's "★ focus" quick pick; the same five, by the same weights, are the soak / stress / spike mix | orders only (`orders.create`) |
| `reads` (15) | `products.list`, `products.image`, `discount.validate`, `auth.logout`, `admin.orders.list` / `.filter` / `.page`, `admin.dashboard` / `.range`, `admin.products.list` / `.search`, `admin.partners.list`, `admin.users.list`, `admin.discount.list`, `admin.slip` | nothing (`products.list` and the dashboard fill the app's 30 s caches) |
| `heavy` (2) | `admin.orders.all` (no `limit`: every order in scope), `admin.orders.search` (`?q=`: full scan) | nothing — but every request reads every order in scope; a scenario of their own, 1 TPS by default, never in TS-All or the mix |
| `auth` (1) | `auth.login` — a fresh bcrypt login per request | nothing |
| `writes` (18) | `orders.create`; `admin.orders.setStatus` / `.note`; products create / update / delete; partners create / update / active; users create / update / active; discount create / update / active; `admin.upload.productImage` / `.delete` / `.qr` | see below |

The admin cookie is obtained **once in `setup()`** and shared by every VU. A write endpoint acts on
a **per-VU fixture** it creates once as `prep.*` (an inactive product / partner / user / promotion
code), so VUs never collide; `create` endpoints use a unique id per request and delete it again as
prep where a delete route exists (products, product images).

```sh
PERF_ENDPOINT=admin.orders.list k6 run scenarios/ts01-endpoint.js                 # target, 50 TPS
PERF_ENDPOINT=products.list PERF_STEPS=25,50,100,200 k6 run scenarios/ts01-endpoint.js  # ladder
npm run ts01:focus                                                              # the spec's five lines, one by one
npm run ts01:reads                                                              # every read, one by one
scripts/ts01-queue.sh heavy                                                     # the two unbounded reads
node scripts/rollup.ts results
```

## TS-02 / TS-03 / TS-04

- **TS-02 Storefront** (`PERF_ORDERS_PER_SEC`, default 10): per iteration `GET /api/products?partner=`
  → with probability `PERF_P_VALIDATE` (0.3) `POST /api/discount/validate` (referral) → `POST
  /api/orders` (multipart: `payload` JSON + `slip` = `fixtures/slip.png`; 1–3 lines, qty 1–3, a
  random Thai phone, `pdpaConsent: true`). Orders are spread round-robin over every orderable
  partner (`PERF_PARTNERS` limits them), because the order number is a transaction on one counter
  document per partner-month (spec §3.1.1).
- **TS-03 Admin orders** (`PERF_TARGET_RPS`, default 50 ≈ 12.5 iterations/s): list `limit=10` →
  `status=รอตรวจสอบสลิป&from&to` → next page by cursor → with probabilities a slip (`PERF_P_SLIP`
  0.5, file id from the order row or `PERF_SLIP_FILE_ID`), a note (0.3), a status change (0.2,
  alternating pending ↔ confirmed so the mix stays roughly where it was).
- **TS-04 Dashboard** (`PERF_TARGET_RPS`, default 50 ≈ 22 loads/s): `dashboard-stats` +
  `partners` in parallel (`http.batch`), then with `PERF_P_RANGE` (0.3) a rotating date range (a
  fresh cache key → a real Firestore aggregation).
- `PERF_ADMIN_ROLE=partner` makes the admin journeys and `who: 'admin'` endpoints use the scoped
  PARTNER_ADMIN cookie (`PERF_PARTNER` = the one partner used where a single code is needed).

## TS-All, Check

```sh
scripts/ts-all.sh                                   # TS-01 all (no heavy) → TS-02 → TS-03 → TS-04
TSALL_HOLD=1m TSALL_TS01=0 scripts/ts-all.sh        # rehearsal without TS-01
TSALL_TS01_TPS=20 TSALL_TS01_WRITE_TPS=2 scripts/ts-all.sh
ENDPOINTS=products.list,admin.orders.list,admin.dashboard k6 run scenarios/check.js   # functional, 5 TPS × 1 s each
```

## Run locally

Requires k6 (≥ 1.0; tested on 2.3), Node ≥ 22 (for `rollup.ts`), Python 3 (mock, runner).

```sh
cp .env.example .env                       # accounts, partners, gate overrides (optional on local)
set -a; . ./.env; set +a
npm run local:up                           # emulators 8085/4448 → PERF_ORDERS=2000 seed → next build → :3100
export PERF_TARGET=local PERF_BASE=http://localhost:3100
npm run smoke:all                          # must pass before any load run
npm run ts03
npm run local:down                         # stops the app, drops the emulators and their data
npm run inspect                            # validate every scenario's options
node scripts/rollup.ts results > results.md
```

Every k6 run is one round (`PERF_ROUND` only names the files; pmc-line consumes no per-round data).
`../pmc-line` also ships its own `tests/load/` (ticket 07 "Peak Burst": checkout ~100 orders/min,
admin 5 → 25 TPS, images 20 TPS) with the SLOs the team agreed there: **checkout p95 ≤ 2 s, admin
list p95 ≤ 1 s, image p95 ≤ 0.5 s, 0 errors**. This toolkit's gate is stricter and uniform (see
"Commitment under test"); reconcile the two before a real run.

## Container

```sh
docker build -t <registry>/pmc-line-perf:$(git rev-parse --short HEAD) .
docker run -e PERF_SCENARIO=ts03 -e PERF_RUN_ID=r1 -e PERF_TARGET=stg -e PERF_STG_BASE=https://… \
  -e PERF_CONFIRM=STAGING -e PERF_ADMIN_USER=… -e PERF_ADMIN_PASS=… -v $PWD/results:/results <image>
```

`scripts/entrypoint.sh` writes `PERF_RESULTS_DIR/<run>/<scenario>/round-N/{report.html, results.csv,
summary.json, verdict.json, k6.log}` and splits the arrival rate across tasks when
`CLOUD_RUN_TASK_INDEX` / `_COUNT` are set.

## How this differs from the spec

Checked while porting (2026-10-14). The spec owner should confirm the first three.

| Spec says | Used here | Why |
|---|---|---|
| Order rows carry a slip (`GET /api/admin/slip/{fileId}`), but the row's field name is not in the spec | `lib/catalog.js slipIdOf` tries `slipFileId` / `slipId` / `slipFile` / `slip` / `slipUrl` / `slipPath`, else `PERF_SLIP_FILE_ID` (`perf-slip-seed.png`, the perf seed's shared slip) | confirm the field name on the real app; until then every slip read hits the one seed file |
| `GET /api/admin/orders` rows: `orderId` | `o.orderId \|\| o.id` | tolerance only |
| Promotion / referral validate: HTTP 200 on `valid:false` | counted as success; only the envelope is checked | spec §3.1.2, §4.4 |
| "ห้ามยิง login เป็น throughput" | the roles sign in once per run in `setup()`; Sign-in runs at 2/s | spec §2, §3.2 |
| No per-endpoint target besides the five lines | `rate` per entry in `lib/endpoints.js` (20 reads, 5 writes, 2 bcrypt, 1 heavy) | defaults to argue about, not the spec's |
| No pass/fail figure | pmc-perf's gate (p95 ≤ 300 ms, errors < 1 % incl. > 1 s), env-overridable | to be decided with the team |
| Order rows carry `slipUrl` (`gs://<bucket>/slips/<fileId>`), not a file id | `slipIdOf` takes the basename → the `GET /api/admin/slip/{fileId}` id (confirmed in `src/app/api/admin/slip/[fileId]/route.ts` after the pull of 2026-10-14) | a scoped admin gets **404** for a slip of an order it cannot see — TS-03 only opens slips from rows it just listed |
| `pnpm seed:users` with fixed passwords (`admin / admin123`) | the perf seed's `perfadmin01` / `perfuser02` / `perfuser03`, `perf-pass` | `seed-users.mjs` reads passwords from `SEED_*` env or generates them |
| — | `tests/load/peak-burst.js` in pmc-line: SLO checkout p95 ≤ 2 s, admin ≤ 1 s, images ≤ 0.5 s, 0 errors | the team's own figures; our gate (300 ms / 1 %) is stricter — decide which applies |
| `POST /api/admin/upload/product-image`: multipart `image` only, ≤ 5 MB | the app wants `partnerCode` too (`Missing partnerCode` 400) and caps at **4 MB → 413** | found on the real app; `lib/endpoints.js` sends `partnerCode` |
| `GET /api/admin/slip/{fileId}`: "admin คนไหนก็อ่านสลิปได้ทุกใบ" | a **scoped** admin gets **404** unless an order it can see carries that slip (`findBySlipUrl` … `limit(1)`); with the perf seed's one shared slip the lookup lands on an arbitrary order, so `admin.slip` under `PERF_ADMIN_ROLE=partner` fails ≈ 90 % on seeded data | run it as super (default), or on data whose slips are per order |
| — | `/api/admin/audit-log` exists in the app (2026-10-13), not in the spec | not covered yet |

## Design choices in the scripts

- **Cookie once per run.** `lib/auth.js sessions()` logs the needed roles in during `setup()` and
  every VU reads the cookie value from setup data (`lib/http.js` sends it as a Cookie header). A
  VU without one signs in itself once with back-off and counts the skipped iterations in
  `no_session` (a ⚠ in the report).
- **No seed files.** The catalog (partners, products, prices) and the admin order pool are read
  live in `setup()` (`lib/catalog.js`), so the scripts follow whatever the environment holds.
- **Orders spread over partners** (`partnerAt`) because of the per-partner-month counter
  transaction; `PERF_PARTNERS=P01` turns TS-02 into a contention test on purpose.
- **Binary reads** (slips, images) use `responseType: 'none'` so the bytes stay out of k6's memory.
- **Heavy reads** are separate entries with their own group, 1 TPS by default, excluded from
  TS-All and the mix: on production they read 200k orders per request (spec §3.3.1).
- **Thai statuses** are sent exactly (`lib/data.js STATUS`) and URL-encoded in query strings
  (spec §4.4 gotcha 3).
- **Error classification** (`lib/errors.js`): the app's `{success:false, error}` envelope becomes
  a `backend` error whose code is the message's first clause (`สินค้าหมด`, `Order not found`, …);
  Vercel's own pages / `x-vercel-error` become `vercel`.

## What a run leaves behind

| Scenario / endpoint | Creates | Cleaned up? |
|---|---|---|
| TS-02, `orders.create`, smoke `order`, the mix's `mix.order` (≈ 6 %) | real orders (`รอตรวจสอบสลิป`) + one slip file each in GCS `slips/` | **no** — agree a teardown with the app owners (no delete route) |
| TS-03 `ops.note` / `ops.status`, `admin.orders.note` / `.setStatus` | notes and status changes on existing orders (status alternates pending ↔ confirmed) | n/a |
| `admin.products.update` (and `.create` / `.delete` prep) | one inactive product per VU `PERF-<run><vu>F`; per-request products are deleted again | partly (per-VU fixtures stay, `active:false`) |
| `admin.partners.create` / `.update` / `.active` | partners `PF<run>…` (no delete route; `.active` toggles the per-VU one) | **no** — deactivate by hand |
| `admin.users.create` / `.update` / `.active` | PARTNER_VIEWER users `perf.<run>…` (no delete route) | **no** — deactivate by hand |
| `admin.discount.create` / `.update` / `.active` | inactive promotion codes `PERF<run>…` + audit rows | **no** |
| `admin.upload.productImage` / `.delete` | product images, deleted again in the same iteration | yes |
| `admin.upload.qr` | files in GCS `qr-code-payment/` | **no** |

`PERF_RUN_ID` is part of every id, so a run's fixtures can be found by name.

## Open items before the first real run

1. Decide the gate with the team: the SLOs in pmc-line's `tests/load/README.md` (checkout 2 s,
   admin 1 s, images 0.5 s, 0 errors) vs this toolkit's uniform 300 ms / 1 %; put the agreed numbers
   in `lib/thresholds.js` (per-class gates would need a small change in `thresholdsFor`) and the
   TS-01 default rates in `lib/endpoints.js`.
2. Add `/api/admin/audit-log` (new in the app, not in the spec) to the catalogue once the spec
   covers it.
3. Agree the perf partners, accounts and the clean-up of what a run leaves behind on stg / prod;
   put the hosts in `.env.stg` / `.env.prod` (`PERF_STG_BASE` / `PERF_PROD_BASE`).
4. Decide whether the slow-gate "1 s = failure" and the 300 ms p95 apply to the two binary
   endpoints (`orders.create` uploads ~60 KB, `admin.slip` downloads from GCS on every call).
