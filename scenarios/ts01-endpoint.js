// TS-01 — individual endpoint test. One endpoint per run, at a fixed arrival rate, measured over
// the whole window, ramps included (lib/phases.js). Complements the journeys (TS-02/03/04): it says
// what each endpoint can take ON ITS OWN, and which one breaks first.
//
//   PERF_ENDPOINT=admin.orders.list k6 run scenarios/ts01-endpoint.js                  # target mode
//   PERF_ENDPOINT=products.list PERF_STEPS=25,50,100,200 k6 run scenarios/ts01-endpoint.js  # ladder
//   scripts/ts01-queue.sh reads                                                        # every read, one by one
//
// Modes
//   target (one rate, PERF_RPS)   GATED: p95 ≤ gate · errors < gate  (achieved vs offered, p99,
//                               max, prep failures: reported, not gated)
//   ladder (PERF_STEPS=a,b,c…)    CAPACITY: per-step results, reports the highest step within the
//                               gate; aborts when a step clearly breaks (p95 > 2× or errors > 5 %)
//
// Env: PERF_ENDPOINT (required, see lib/endpoints.js) · PERF_RPS (default per endpoint: lib/endpoints.js
//      `rate` — 50 for the admin orders / products / dashboard lines, 10 orders, 20 other reads, 5
//      writes, 2 bcrypt calls, 1 heavy reads) · PERF_STEPS · PERF_RAMP (30s) · PERF_HOLD (5m, per step)
//      · PERF_RAMP_DOWN (30s) · PERF_MAX_VUS · PERF_ADMIN_ROLE (super | partner)
import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { adminRole, sessionFor, sessions } from '../lib/auth.js';
import { loadCatalog, mainPartner, orderPool } from '../lib/catalog.js';
import { defaultRate, ENDPOINTS, needsOf } from '../lib/endpoints.js';
import { expectShape } from '../lib/http.js';
import { expectedCount, stepPlan, tagWindow, toSeconds } from '../lib/phases.js';
import { makeHandleSummary } from '../lib/summary.js';
import { errorGate, GATE, latencyGate, reportThresholds, summaryTrendStats } from '../lib/thresholds.js';

const ID = __ENV.PERF_ENDPOINT || '';
const EP = ENDPOINTS[ID];
if (!EP) throw new Error(`PERF_ENDPOINT="${ID}" unknown — one of: ${Object.keys(ENDPOINTS).join(', ')}`);
const WRITE = EP.kind === 'write';

const RATES = __ENV.PERF_STEPS
  ? __ENV.PERF_STEPS.split(',').map(Number).filter((r) => r > 0)
  : [Number(__ENV.PERF_RPS || defaultRate(EP))];
if (!RATES.length || RATES.some((r) => !Number.isInteger(r))) throw new Error('rates must be whole TPS, e.g. PERF_STEPS=10,20,40');
const LADDER = RATES.length > 1;
const RAMP = toSeconds(cfg.ramp);
const HOLD = toSeconds(cfg.hold);
const PLAN = stepPlan(RATES, RAMP, HOLD, toSeconds(cfg.rampDown));

// VUs ≈ rate × iteration time: a read is one request (1 s covers it with headroom over the gate);
// a login hashes a password (2 s); a write iteration may run a prep call first (3 s); the heavy
// unbounded reads can take many seconds each (10 s).
const MAX_RPS = Math.max.apply(null, RATES);
const ITER_SEC = EP.heavy ? 10 : WRITE ? 3 : EP.kind === 'auth' ? 2 : 1;
const maxVUs = Number(__ENV.PERF_MAX_VUS || Math.ceil(MAX_RPS * ITER_SEC) + 5);

// Per-step thresholds on each step's measured window (its ramp + hold; the last also takes the ramp-down).
const thresholds = {};
PLAN.phases.forEach((ph) => {
  const sel = `name:${ID},phase:${ph.name}`;
  thresholds[`http_req_duration{${sel}}`] = LADDER ? ['max>=0'] : latencyGate();
  thresholds[`req_failed{${sel}}`] = LADDER ? ['rate>=0'] : errorGate();
  thresholds[`http_reqs{${sel}}`] = ['count>=0'];
  if (LADDER) {
    // Stop a ladder once a step clearly breaks — judged 30 s into that step's hold.
    const delay = `${Math.round(ph.holdStart + Math.min(30, HOLD))}s`;
    thresholds[`http_req_duration{${sel}}`].push({ threshold: `p(95)<${GATE.p95 * 2}`, abortOnFail: true, delayAbortEval: delay });
    thresholds[`req_failed{${sel}}`].push({ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: delay });
  }
});
thresholds.prep_failed = ['count>=0']; // reported, not gated
thresholds.no_session = ['count>=0'];
reportThresholds(PLAN.phases.map((ph) => `name:${ID},phase:${ph.name}`), thresholds); // report detail

export const options = {
  scenarios: {
    ts01: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      stages: PLAN.stages,
      preAllocatedVUs: Math.min(maxVUs, Math.max(5, RATES[0] * 2)),
      maxVUs,
    },
  },
  thresholds,
  summaryTrendStats,
};

export function setup() {
  const iters = PLAN.phases.reduce((a, ph) => a + ph.rps * (HOLD + RAMP / 2), 0);
  console.log(`[ts01] ${ID} (${EP.kind}, ${EP.who}) · ${LADDER ? 'ladder' : 'target'} ${RATES.join(' → ')} TPS · ramp ${RAMP}s · hold ${HOLD}s · maxVUs ${maxVUs}`);
  if (WRITE) console.warn(`[ts01] WRITE endpoint — ≈ ${Math.ceil(iters)} requests, each ${EP.db === 'write' ? 'creates or changes a document' : 'writes'}: ${EP.api}`);
  if (EP.heavy) console.warn(`[ts01] HEAVY read — every request reads every order in scope into memory (${EP.api})`);
  const need = needsOf([ID]);
  const s = sessions(Array.from(need.roles));
  const catalog = need.catalog || EP.who !== 'none' ? loadCatalog() : null;
  const adminSession = s[adminRole()] || s.super;
  const pool = need.pool && adminSession ? orderPool(adminSession, Math.min(1000, Math.max(100, Math.ceil(iters))), adminRole() === 'partner' ? cfg.partner : '') : [];
  if (need.pool && !pool.length) console.warn('[ts01] the order pool is empty — the writes will fail their "has an order to act on" check');
  return { sessions: s, catalog, pool };
}

export default function (data) {
  tagWindow(PLAN.phases);
  const ctx = { data, vu: exec.vu.idInTest, iter: exec.scenario.iterationInTest, partner: mainPartner(data.catalog) };
  if (EP.who !== 'none') {
    ctx.session = sessionFor(data, EP.who);
    if (!expectShape({ status: 0 }, ID, 'has a session', () => !!ctx.session)) return;
  }
  EP.run(ctx, ID);
}

// Per-step results: offered vs achieved, latency, errors, and the step's own verdict.
const extend = (data, verdict) => {
  const m = data.metrics;
  const val = (k) => (m[k] && m[k].values) || {};
  const steps = PLAN.phases.map((ph, i) => {
    const sel = `name:${ID},phase:${ph.name}`;
    const d = val(`http_req_duration{${sel}}`);
    const count = val(`http_reqs{${sel}}`).count || 0;
    const errRate = val(`req_failed{${sel}}`).rate || 0;
    const slow = val(`req_slow{${sel}}`);
    const achieved = count / ph.seconds;
    const pass = count > 0 && d['p(95)'] <= GATE.p95 && errRate < GATE.errRate;
    const expected = expectedCount(ph, ph.rps, i > 0 ? PLAN.phases[i - 1].rps : 0);
    const delivered = count >= 0.95 * expected;
    return { phase: ph.name, offered: ph.rps, achieved, delivered, expected: Math.round(expected), count, p95: d['p(95)'], p99: d['p(99)'], max: d.max, errRate, slowCount: slow.passes || 0, slowRate: slow.rate || 0, pass };
  });
  verdict.endpoint = ID;
  verdict.mode = LADDER ? 'ladder' : 'target';
  verdict.steps = steps;
  verdict.prepFailed = val('prep_failed').count || 0;
  verdict.dropped = val('dropped_iterations').count || 0;
  // No request of the endpoint itself = nothing was measured (every iteration stopped before it: no
  // session, an empty pool, a prep step failed). Its thresholds see no data and pass, so say FAIL.
  verdict.measured = steps.reduce((a, st) => a + st.count, 0);
  if (!verdict.measured) {
    verdict.pass = false;
    verdict.failedThresholds = (verdict.failedThresholds || []).concat([
      `no ${ID} request measured: every iteration stopped before it (session / prep / data check failed — see the prep.* checks and the Error detail)`]);
  }
  if (LADDER) {
    let best = null;
    for (let i = 0; i < steps.length && steps[i].pass; i++) best = steps[i];
    verdict.capacityRps = best ? best.offered : 0;
    verdict.pass = verdict.capacityRps > 0; // a ladder is a measurement: it "passes" if any step held
  }
};

export const handleSummary = makeHandleSummary(`ts01-${ID}`, extend);
