// SOAK — the priority mix at a constant rate for a long hold: ramp 30 s → hold 15 min → ramp
// down 30 s. The mix (lib/journeys.js mixRequest, PERF_MIX) is the docs' "List Load Test" table:
// POST /api/orders 10 · GET /api/products 50 · GET /api/admin/orders 50 · dashboard-stats 50 ·
// GET /api/admin/products 10 → 170 TPS, ONE request per iteration, so iterations/s = TPS.
// Its point is duration, so the hold is its own (PERF_SOAK_HOLD, default 15m), not PERF_HOLD.
// Measured: the whole run (ramp up + hold + ramp down). Places ≈ 6 % of the requests as real orders.
import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { adminRole, sessionFor, sessions } from '../lib/auth.js';
import { loadCatalog, mainPartner } from '../lib/catalog.js';
import { mixRequest, MIX_TOTAL, parseMix } from '../lib/journeys.js';
import { standardPlan, tagWindow, toSeconds } from '../lib/phases.js';
import { makeHandleSummary } from '../lib/summary.js';
import { MIX_TAGS, summaryTrendStats, thresholdsFor } from '../lib/thresholds.js';

const MIX = parseMix(__ENV.PERF_MIX);
const TARGET_RPS = Number(__ENV.PERF_TARGET_RPS || MIX_TOTAL(MIX));
const SOAK_HOLD = __ENV.PERF_SOAK_HOLD || '15m';
const PLAN = standardPlan(TARGET_RPS, SOAK_HOLD);
const maxVUs = Number(__ENV.PERF_MAX_VUS || Math.ceil(TARGET_RPS * 2) + 10);

export const options = {
  scenarios: {
    soak: { executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', stages: PLAN.stages, preAllocatedVUs: Math.min(maxVUs, Math.max(10, TARGET_RPS)), maxVUs },
  },
  thresholds: thresholdsFor(MIX_TAGS),
  summaryTrendStats,
};

export function setup() {
  const role = adminRole();
  const s = sessions([role]);
  const catalog = loadCatalog();
  const total = MIX_TOTAL(MIX);
  console.log(`[soak] ${TARGET_RPS} TPS · hold ${SOAK_HOLD} · mix ${Object.keys(MIX).map((k) => `${k} ${Math.round((MIX[k] / total) * 100)} %`).join(' · ')}`);
  console.warn(`[soak] places ≈ ${Math.round(TARGET_RPS * (MIX.order / total) * (toSeconds(SOAK_HOLD) + toSeconds(cfg.ramp)))} real orders`);
  return { sessions: s, catalog, partnerScope: role === 'partner' ? cfg.partner : '', partnerMain: mainPartner(catalog) };
}

export default function (data) {
  tagWindow(PLAN.phases);
  const session = sessionFor(data, 'admin');
  mixRequest({ mix: MIX, catalog: data.catalog, session, partnerScope: data.partnerScope, partnerMain: data.partnerMain, k: exec.scenario.iterationInTest * cfg.taskCount + cfg.taskIndex });
}

export const handleSummary = makeHandleSummary('soak', (data, verdict) => { verdict.targetRps = TARGET_RPS; }, toSeconds(cfg.ramp) + toSeconds(SOAK_HOLD) + toSeconds(cfg.rampDown));
