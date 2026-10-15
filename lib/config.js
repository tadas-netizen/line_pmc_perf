// Run-time configuration. Everything comes from env so one script set serves every run.
//
// Where requests go — the pmc-line app (Next.js: storefront `/api/*` + admin `/api/admin/*`,
// docs/api-spec-loadtest.md). There is deliberately NO default base: a forgotten variable must
// never send load anywhere real. Either
//   PERF_TARGET=local        → http://localhost:3000 (`pnpm dev` + Firestore / GCS emulators)
//   PERF_TARGET=stg | prod   → the host in PERF_STG_BASE / PERF_PROD_BASE (.env.stg / .env.prod:
//                              the team's real domains are not written in this repo)
//   PERF_BASE explicitly     → anything else (scripts/dry-run.sh and tools/runner.py point it at the
//                              local mock); an explicit base also overrides the preset.
//
// HUMAN-ERROR GUARD: any run that reaches stg or prod — by PERF_TARGET, or by a PERF_BASE on their
// host — must also carry the confirmation word typed for THAT run:
//   PERF_CONFIRM=STAGING      (stg)
//   PERF_CONFIRM=PRODUCTION   (prod)
// A base that is neither local nor a known preset ("custom") needs PERF_CONFIRM=CUSTOM.
// Never store PERF_CONFIRM in .env or a job definition: it exists so a person types it per run
// (tools/runner.py asks for it in a modal). Without it the script refuses to start.

const env = (name, fallback) => {
  const v = __ENV[name];
  return v === undefined || v === '' ? fallback : v;
};

export const CONFIRM_WORD = { stg: 'STAGING', prod: 'PRODUCTION', custom: 'CUSTOM' };
const PRESETS = {
  local: 'http://localhost:3000',
  stg: env('PERF_STG_BASE', ''),
  prod: env('PERF_PROD_BASE', ''),
};

const target = env('PERF_TARGET', '');
if (target && !(target in PRESETS)) throw new Error(`PERF_TARGET="${target}" unknown — use local, stg or prod (or set PERF_BASE)`);
if ((target === 'stg' || target === 'prod') && !PRESETS[target]) {
  throw new Error(`PERF_TARGET=${target} needs PERF_${target.toUpperCase()}_BASE (the app's URL) in .env.${target} — the real domains are not stored in this repo`);
}
const BASE = (env('PERF_BASE', PRESETS[target] || '') || '').replace(/\/+$/, '');
if (!BASE) {
  throw new Error('PERF_BASE is not set. Pick a target: PERF_TARGET=local, stg or prod, or run against the mock with ' +
    'scripts/dry-run.sh / tools/runner.py (they set PERF_BASE).');
}

const hostOf = (u) => String(u).replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0].toLowerCase();
const isLocalHost = (h) => /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])$/.test(h);
const host = hostOf(BASE);
// Which real environment does this base reach? By target, or by host (so a hand-set PERF_BASE on
// the stg / prod host is guarded too).
let reached = '';
if (target === 'stg' || target === 'prod') reached = target;
else if (PRESETS.stg && hostOf(PRESETS.stg) === host) reached = 'stg';
else if (PRESETS.prod && hostOf(PRESETS.prod) === host) reached = 'prod';
else if (!isLocalHost(host)) reached = 'custom';
if (reached && env('PERF_CONFIRM', '') !== CONFIRM_WORD[reached]) {
  throw new Error(`This run reaches ${reached === 'prod' ? 'PRODUCTION' : reached === 'stg' ? 'STAGING' : 'a remote host'} (${BASE}). ` +
    `Set PERF_CONFIRM=${CONFIRM_WORD[reached]} for this run only, after the test is scheduled and the team is informed. Never store it in .env.`);
}

const isLocal = !reached; // local dev server or the mock: test accounts may default to the seed's
// Test accounts. The defaults (local targets only) are the perf seed's (`pnpm seed:perf`, docs §1.3):
// perfadmin01 SUPER_ADMIN, perfuser02 PARTNER_ADMIN, perfuser03 PARTNER_VIEWER, all `perf-pass` —
// `pnpm seed:users` no longer has fixed passwords (they come from SEED_* env or are generated).
// stg / prod must set their own in .env.<target>.
const account = (role, user, pass) => ({
  username: env(`PERF_${role}_USER`, isLocal ? user : ''),
  password: env(`PERF_${role}_PASS`, isLocal ? pass : ''),
});

export const cfg = {
  // 'stg' / 'prod' / 'custom' by target or host; the runner names local targets (PERF_TARGET_LABEL:
  // "local (mock)" / "local pmc-line"); else 'local'.
  target: reached || env('PERF_TARGET_LABEL', '') || (target || 'local'),
  base: BASE,

  // Accounts — three roles (docs §2): SUPER_ADMIN (users / partners / referral codes), PARTNER_ADMIN
  // (scoped writes), PARTNER_VIEWER (403 on every write — used by smoke's negative checks).
  superAdmin: account('ADMIN', 'perfadmin01', 'perf-pass'),
  partnerAdmin: account('PARTNER', 'perfuser02', 'perf-pass'),
  viewer: account('VIEWER', 'perfuser03', 'perf-pass'),
  // Which session the `who: 'admin'` endpoints and the admin journeys use: super (sees every
  // partner, no `?partner=`) or partner (scoped, `in` query). Super-only endpoints always use super.
  adminRole: env('PERF_ADMIN_ROLE', 'super'),

  // Partner codes: the storefront journey and the scoped reads spread over these (orders.create
  // serialises on counters/{PARTNER-YYMM}, so one partner = one hotspot). Empty = every partner
  // that has an active product in GET /api/products (lib/catalog.js, found in setup()).
  partners: env('PERF_PARTNERS', '').split(',').map((s) => s.trim()).filter(Boolean),
  // The one partner used where a single code is needed (admin products list, discount codes,
  // scoped `?partner=`). Empty = the first of `partners`.
  partner: env('PERF_PARTNER', ''),

  // The slip file POST /api/orders uploads (relative to lib/, where open() resolves) and the GCS
  // file id GET /api/admin/slip/{fileId} reads (the perf seed's shared slip, docs §1.3).
  slipFile: env('PERF_SLIP_FILE', '../fixtures/slip.png'),
  slipFileId: env('PERF_SLIP_FILE_ID', 'perf-slip-seed.png'),
  // Optional: a file id for GET /api/product-image/{fileId}?folder=qr-code-payment (legacy proxy);
  // products.image is skipped when unset.
  imageFileId: env('PERF_IMAGE_FILE_ID', ''),
  // Discount codes the storefront validates: a referral (digits) and a promotion (A-Z0-9_-).
  referralCode: env('PERF_REFERRAL_CODE', '1234'),
  promotionCode: env('PERF_PROMOTION_CODE', 'WELCOME10'),

  // Set by scripts/entrypoint.sh; locally handleSummary falls back to ./results/….
  summaryDir: env('PERF_SUMMARY_DIR', ''),
  runId: env('PERF_RUN_ID', 'local'),
  round: Number(env('PERF_ROUND', '1')),
  // Container task slot (entrypoint.sh) — keeps per-VU identifiers disjoint across tasks.
  taskIndex: Number(env('CLOUD_RUN_TASK_INDEX', '0')),
  taskCount: Number(env('CLOUD_RUN_TASK_COUNT', '1')),

  // Load shape: every load scenario ramps up, HOLDS at its target, ramps down — and the whole run
  // (phase `s1`, or `sN` per step) is measured and gated (lib/phases.js).
  ramp: env('PERF_RAMP', '30s'),
  hold: env('PERF_HOLD', '5m'),
  rampDown: env('PERF_RAMP_DOWN', '30s'),
  vus: Number(env('PERF_VUS', '0')) || undefined,

  // Print status + body of every failed check (smoke / script debugging).
  debug: env('PERF_DEBUG', '') === '1',
};

export const api = (path) => `${cfg.base}${path}`;
