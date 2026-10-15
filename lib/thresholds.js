// THE GATE — exactly two conditions decide PASS/FAIL (kept from pmc-perf, 2026-10-05):
//   1. p95 ≤ GATE.p95 ms   (blended, and per endpoint `name` tag)
//   2. error rate < GATE.errRate, where a request slower than GATE.slowMs counts as an error:
//      metric `req_failed` (lib/http.js), not k6's `http_req_failed`
// pmc-line has no TOR figure yet, so the three numbers are env-overridable (PERF_GATE_P95,
// PERF_GATE_ERR, PERF_GATE_SLOW_MS) — change them for a run, or decide them with the team and
// change the defaults here. Everything else — p99, max, checks rate, request counts, achieved vs
// offered, prep failures — is measured and reported (summary, verdict, rollup, runner) but never
// decides PASS/FAIL. Stop rules (abortOnFail in stress / TS-01 ladders) are separate: they end a
// run early, they are not the verdict.
const num = (name, fallback) => {
  const v = Number(__ENV[name]);
  return __ENV[name] !== undefined && __ENV[name] !== '' && !isNaN(v) && v > 0 ? v : fallback;
};
export const GATE = { p95: num('PERF_GATE_P95', 300), errRate: num('PERF_GATE_ERR', 0.01), slowMs: num('PERF_GATE_SLOW_MS', 1000) };
const latency = () => [`p(95)<=${GATE.p95}`];
const errors = () => [`rate<${GATE.errRate}`];

// Gates on the MEASURED window (`phase`, default `s1` — lib/phases.js: ramp up + hold + ramp
// down): blended, plus one sub-metric per `name` tag — per-endpoint p95 is gated too, so the
// report names the call that broke the budget. `extra` keys are taken as-is.
export const thresholdsFor = (tags, extra = {}, phase = 's1') => {
  const t = {
    [`http_req_duration{phase:${phase}}`]: latency(),
    [`req_failed{phase:${phase}}`]: errors(),
    [`checks{phase:${phase}}`]: ['rate>=0'], // reported, not gated
    [`http_reqs{phase:${phase}}`]: ['count>=0'], // declared so the verdict can read the measured count
  };
  for (const name of tags) t[`http_req_duration{name:${name},phase:${phase}}`] = latency();
  reportThresholds([`phase:${phase}`].concat(tags.map((n) => `name:${n},phase:${phase}`)), t);
  return Object.assign(t, extra);
};

// ---- report detail (lib/report.js) --------------------------------------------------------
// k6 only aggregates sub-metrics that a threshold names, so the per-row detail of the HTML
// report (error rate, timings, status counts) is declared here with no-op thresholds
// (`>=0`): reported, never gating. Existing keys (the real gates) are left untouched.
export const REPORT_TIMINGS = ['http_req_blocked', 'http_req_connecting', 'http_req_tls_handshaking', 'http_req_sending', 'http_req_waiting', 'http_req_receiving'];
export const REPORT_STATUSES = ['0', '200', '201', '204', '302', '400', '401', '403', '404', '409', '413', '422', '429', '500', '502', '503', '504'];
export const reportThresholds = (selectors, into = {}) => {
  const put = (k, v) => { if (!into[k]) into[k] = v; };
  selectors.forEach((sel) => {
    put(`http_req_duration{${sel}}`, ['max>=0']);
    put(`http_req_failed{${sel}}`, ['rate>=0']);
    put(`req_failed{${sel}}`, ['rate>=0']);
    put(`req_slow{${sel}}`, ['rate>=0']);
    put(`http_reqs{${sel}}`, ['count>=0']);
    REPORT_TIMINGS.forEach((m) => put(`${m}{${sel}}`, ['p(95)>=0']));
    REPORT_STATUSES.forEach((code) => put(`http_reqs{${sel},status:${code}}`, ['count>=0']));
  });
  return into;
};

export const latencyGate = latency;
export const errorGate = errors;

// Tags of the journeys (lib/journeys.js). Every tag a scenario gates must be listed here.
export const AUTH_TAGS = ['auth.login'];
// TS-02 — storefront (LINE OA customer): catalog → maybe a discount code → place the order
export const TS02_TAGS = ['shop.products', 'shop.validate', 'shop.order'];
// TS-03 — admin order desk: list → filter → next page → slip → note / status
export const TS03_TAGS = ['ops.list', 'ops.filter', 'ops.page', 'ops.slip', 'ops.note', 'ops.status'];
// TS-04 — admin dashboard: stats + partners (parallel), sometimes a date range
export const TS04_TAGS = ['dash.stats', 'dash.partners', 'dash.range'];
// Soak / stress / spike — the priority mix (docs/api-spec-loadtest.md "List Load Test")
export const MIX_TAGS = ['mix.order', 'mix.products', 'mix.orders', 'mix.dashboard', 'mix.catalog'];
export const NEG_TAGS = ['neg.noCookie', 'neg.viewerWrite', 'neg.scope', 'neg.inactive'];

// p(95)/p(99)/max for every tag in the summary (k6 only reports avg..p95 by default).
export const summaryTrendStats = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'];
