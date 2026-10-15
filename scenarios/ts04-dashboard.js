// TS-04 — the admin dashboard (docs line #10: GET /api/admin/dashboard-stats at 50 TPS). Each
// iteration is one dashboard load: the stats (Firestore aggregation, 30 s cache per key) and the
// partner dropdown (read live, no cache) together, and with probability P a date range (a new cache
// key → a real aggregation). ≈ 2.3 requests per iteration, so 50 TPS ≈ 22 iterations/s.
// Gate: p95 ≤ gate and errors < gate over the whole run (ramps included).
//
//   k6 run scenarios/ts04-dashboard.js
//   PERF_TARGET_RPS=100 PERF_P_RANGE=0.5 k6 run scenarios/ts04-dashboard.js
//
// Env: PERF_TARGET_RPS (50) · PERF_MAX_VUS (60) · PERF_VUS (legacy) · PERF_P_RANGE (0.3) · PERF_ADMIN_ROLE · the shape
import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { adminRole, sessionFor, sessions } from '../lib/auth.js';
import { dashboardJourney, DASH_REQ_PER_ITER } from '../lib/journeys.js';
import { expectShape } from '../lib/http.js';
import { standardPlan, tagWindow, toSeconds } from '../lib/phases.js';
import { makeHandleSummary } from '../lib/summary.js';
import { summaryTrendStats, thresholdsFor, TS04_TAGS } from '../lib/thresholds.js';

const LEGACY = !!cfg.vus;
const TARGET_RPS = Number(__ENV.PERF_TARGET_RPS || 50);
const VUS = LEGACY ? cfg.vus : Number(__ENV.PERF_MAX_VUS || 60);
const PLAN = standardPlan(LEGACY ? VUS : Math.ceil(TARGET_RPS / DASH_REQ_PER_ITER));
const P_RANGE = __ENV.PERF_P_RANGE;

export const options = {
  scenarios: {
    ts04: LEGACY
      ? { executor: 'ramping-vus', startVUs: 0, stages: PLAN.stages, gracefulRampDown: '10s' }
      : { executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', stages: PLAN.stages, preAllocatedVUs: Math.min(VUS, 20), maxVUs: VUS },
  },
  thresholds: thresholdsFor(TS04_TAGS),
  summaryTrendStats,
};

export function setup() {
  const role = adminRole();
  const s = sessions([role]);
  console.log(`[ts04] ${LEGACY ? `${VUS} VUs back to back` : `${TARGET_RPS} TPS ≈ ${Math.ceil(TARGET_RPS / DASH_REQ_PER_ITER)} dashboard loads/s`} · role ${role} · P(range) ${P_RANGE === undefined ? 0.3 : P_RANGE}`);
  return { sessions: s, partnerScope: role === 'partner' ? cfg.partner : '' };
}

export default function (data) {
  tagWindow(PLAN.phases);
  const session = sessionFor(data, 'admin');
  if (!expectShape({ status: 0 }, 'dash.stats', 'has a session', () => !!session)) return;
  dashboardJourney({ session, partnerScope: data.partnerScope, k: exec.scenario.iterationInTest * cfg.taskCount + cfg.taskIndex, pRange: P_RANGE });
}

export const handleSummary = makeHandleSummary('ts04', (data, verdict) => {
  if (!LEGACY) {
    verdict.targetRps = TARGET_RPS;
    verdict.targetFloor = Math.round(TARGET_RPS * (toSeconds(cfg.hold) + (toSeconds(cfg.ramp) + toSeconds(cfg.rampDown)) / 2) * 0.95);
    verdict.targetMet = (verdict.requests || 0) >= verdict.targetFloor;
  }
});
