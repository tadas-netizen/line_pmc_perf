// TS-03 — the admin order desk (docs line #7: GET /api/admin/orders at 50 TPS). Each iteration is
// one admin working the list: first page → status filter → next page (cursor) → maybe open a slip
// (binary from GCS) → maybe a note → maybe a status change. ≈ 4 requests per iteration, so the
// default 50 TPS ≈ 12.5 iterations/s. The admin cookie is obtained ONCE in setup() (bcrypt) and
// shared by every VU (docs §2: reuse the cookie for 12 h).
// Gate: p95 ≤ gate and errors < gate over the whole run (ramps included).
//
//   k6 run scenarios/ts03-admin-orders.js
//   PERF_TARGET_RPS=100 PERF_ADMIN_ROLE=partner PERF_PARTNER=6TY k6 run scenarios/ts03-admin-orders.js
//
// Env: PERF_TARGET_RPS (50) · PERF_MAX_VUS (60) · PERF_VUS (legacy: n VUs back to back) · PERF_ADMIN_ROLE
//      (super | partner) · PERF_P_SLIP (0.5) · PERF_P_NOTE (0.3) · PERF_P_STATUS (0.2) · the shape
// The note / status writes change real order documents (status alternates pending ↔ confirmed).
import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { adminRole, sessionFor, sessions } from '../lib/auth.js';
import { orderPool } from '../lib/catalog.js';
import { adminOrdersJourney, OPS_REQ_PER_ITER } from '../lib/journeys.js';
import { expectShape } from '../lib/http.js';
import { standardPlan, tagWindow, toSeconds } from '../lib/phases.js';
import { makeHandleSummary } from '../lib/summary.js';
import { summaryTrendStats, thresholdsFor, TS03_TAGS } from '../lib/thresholds.js';

const LEGACY = !!cfg.vus;
const TARGET_RPS = Number(__ENV.PERF_TARGET_RPS || 50);
const VUS = LEGACY ? cfg.vus : Number(__ENV.PERF_MAX_VUS || 60);
const PLAN = standardPlan(LEGACY ? VUS : Math.ceil(TARGET_RPS / OPS_REQ_PER_ITER));
const P = { pSlip: __ENV.PERF_P_SLIP, pNote: __ENV.PERF_P_NOTE, pStatus: __ENV.PERF_P_STATUS };
const WINDOW_SEC = toSeconds(cfg.ramp) + toSeconds(cfg.hold) + toSeconds(cfg.rampDown);

export const options = {
  scenarios: {
    ts03: LEGACY
      ? { executor: 'ramping-vus', startVUs: 0, stages: PLAN.stages, gracefulRampDown: '10s' }
      : { executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', stages: PLAN.stages, preAllocatedVUs: Math.min(VUS, 20), maxVUs: VUS },
  },
  thresholds: thresholdsFor(TS03_TAGS),
  summaryTrendStats,
};

export function setup() {
  const role = adminRole();
  const s = sessions([role]);
  const pool = orderPool(s[role], 200, role === 'partner' ? cfg.partner : '');
  console.log(`[ts03] ${LEGACY ? `${VUS} VUs back to back` : `${TARGET_RPS} TPS ≈ ${Math.ceil(TARGET_RPS / OPS_REQ_PER_ITER)} iterations/s`} · role ${role} · window ${WINDOW_SEC}s`);
  return { sessions: s, pool, partnerScope: role === 'partner' ? cfg.partner : '' };
}

export default function (data) {
  tagWindow(PLAN.phases);
  const session = sessionFor(data, 'admin');
  if (!expectShape({ status: 0 }, 'ops.list', 'has a session', () => !!session)) return;
  adminOrdersJourney(Object.assign({ session, pool: data.pool, partnerScope: data.partnerScope, k: exec.scenario.iterationInTest * cfg.taskCount + cfg.taskIndex }, P));
}

export const handleSummary = makeHandleSummary('ts03', (data, verdict) => {
  if (!LEGACY) {
    verdict.targetRps = TARGET_RPS;
    // target throughput, reported not gated: the offered rate over full-load-equivalent seconds
    verdict.targetFloor = Math.round(TARGET_RPS * (toSeconds(cfg.hold) + (toSeconds(cfg.ramp) + toSeconds(cfg.rampDown)) / 2) * 0.95);
    verdict.targetMet = (verdict.requests || 0) >= verdict.targetFloor;
  }
});
