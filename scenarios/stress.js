// STRESS — the priority mix, 50 → 1,000 TPS in +50 steps. Each step: ramp 30 s → hold (5 min) and
// is measured on ITS OWN window (`s1`, `s2`, …: its ramp + hold; the last also takes the
// ramp-down), so a step is judged by what happened during it. Stops at the first step that breaks
// the gate (p95 > gate or errors ≥ gate, a response > slow gate counting as an error), judged 30 s
// into its hold. Informational: the TPS where p95 crosses the gate and 500 ms.
// Run LAST — it may leave the environment degraded (and it places ≈ 6 % of its requests as real
// orders). 20 steps × 5.5 min ≈ 1 h 50 min at most; PERF_STRESS_HOLD shortens the steps,
// PERF_STRESS_MAX caps the top, PERF_STRESS_STEP sets the increment.
import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { adminRole, sessionFor, sessions } from '../lib/auth.js';
import { loadCatalog, mainPartner } from '../lib/catalog.js';
import { mixRequest, parseMix } from '../lib/journeys.js';
import { expectedCount, ladderPlan, measuredSeconds, tagWindow } from '../lib/phases.js';
import { makeHandleSummary } from '../lib/summary.js';
import { GATE, reportThresholds, summaryTrendStats } from '../lib/thresholds.js';

const MIX = parseMix(__ENV.PERF_MIX);
const STEP_HOLD = __ENV.PERF_STRESS_HOLD || cfg.hold;
const MAX = Number(__ENV.PERF_STRESS_MAX || 1000);
const STEP = Number(__ENV.PERF_STRESS_STEP || 50);
const STEPS_RPS = [];
for (let rps = STEP; rps <= MAX; rps += STEP) STEPS_RPS.push(rps);
const PLAN = ladderPlan(STEPS_RPS, STEP_HOLD);
const maxVUs = Number(__ENV.PERF_MAX_VUS || Math.ceil(MAX * 2) + 10);

const thresholds = {};
PLAN.phases.forEach((ph) => {
  const delay = `${Math.round(ph.holdStart + 30)}s`;
  thresholds[`http_req_duration{phase:${ph.name}}`] = [{ threshold: `p(95)<=${GATE.p95}`, abortOnFail: true, delayAbortEval: delay }];
  thresholds[`req_failed{phase:${ph.name}}`] = [{ threshold: `rate<${GATE.errRate}`, abortOnFail: true, delayAbortEval: delay }];
  thresholds[`http_reqs{phase:${ph.name}}`] = ['count>=0'];
});
reportThresholds(PLAN.phases.map((ph) => `phase:${ph.name}`), thresholds);

export const options = {
  scenarios: {
    stress: { executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', stages: PLAN.stages, preAllocatedVUs: Math.min(maxVUs, 100), maxVUs },
  },
  thresholds,
  summaryTrendStats,
};

export function setup() {
  const role = adminRole();
  const s = sessions([role]);
  const catalog = loadCatalog();
  console.log(`[stress] ${STEPS_RPS[0]} → ${MAX} TPS in +${STEP} steps · hold ${STEP_HOLD} per step · stops at the first step over the gate`);
  return { sessions: s, catalog, partnerScope: role === 'partner' ? cfg.partner : '', partnerMain: mainPartner(catalog) };
}

export default function (data) {
  tagWindow(PLAN.phases);
  const session = sessionFor(data, 'admin');
  mixRequest({ mix: MIX, catalog: data.catalog, session, partnerScope: data.partnerScope, partnerMain: data.partnerMain, k: exec.scenario.iterationInTest * cfg.taskCount + cfg.taskIndex });
}

const extend = (data, verdict) => {
  const v = (k) => (data.metrics[k] && data.metrics[k].values) || {};
  verdict.steps = PLAN.phases.map((ph, i) => {
    const d = v(`http_req_duration{phase:${ph.name}}`);
    const count = v(`http_reqs{phase:${ph.name}}`).count || 0;
    const slow = v(`req_slow{phase:${ph.name}}`);
    const prev = i > 0 ? PLAN.phases[i - 1].rps : 0;
    const expected = expectedCount(ph, ph.rps, prev);
    return { phase: ph.name, offered: STEPS_RPS[i], achieved: count / ph.seconds, delivered: count >= 0.95 * expected, expected: Math.round(expected), count, p95: d['p(95)'], p99: d['p(99)'], max: d.max, errRate: v(`req_failed{phase:${ph.name}}`).rate || 0, slowCount: slow.passes || 0, slowRate: slow.rate || 0 };
  }).filter((s) => s.count > 0).map((s) => Object.assign(s, { pass: s.p95 <= GATE.p95 && s.errRate < GATE.errRate }));
  const firstOver = (ms) => verdict.steps.find((s) => s.p95 >= ms);
  verdict.crosses300At = firstOver(GATE.p95) ? firstOver(GATE.p95).offered : null;
  verdict.crosses500At = firstOver(500) ? firstOver(500).offered : null;
  let best = null;
  for (let i = 0; i < verdict.steps.length && verdict.steps[i].pass; i++) best = verdict.steps[i];
  verdict.capacityRps = best ? best.offered : 0;
  const all = v('http_req_duration'), failedAll = v('req_failed'), httpAll = v('http_req_failed'), slowAll = v('req_slow');
  verdict.requests = verdict.steps.reduce((n, st) => n + st.count, 0);
  verdict.rps = verdict.requests / measuredSeconds(PLAN.phases);
  verdict.p95 = all['p(95)']; verdict.p99 = all['p(99)']; verdict.max = all.max; verdict.errRate = failedAll.rate;
  verdict.httpErrRate = httpAll.rate; verdict.slowRate = slowAll.rate; verdict.slowCount = slowAll.passes || 0;
  verdict.window = `all steps, ramps included (${Math.round(measuredSeconds(PLAN.phases))}s max)`;
  verdict.mode = 'ladder';
  verdict.endpoint = 'priority mix';
  verdict.pass = verdict.steps.length > 0; // informational: it "passes" if it measured at least one step
};

export const handleSummary = makeHandleSummary('stress', extend, measuredSeconds(PLAN.phases));
