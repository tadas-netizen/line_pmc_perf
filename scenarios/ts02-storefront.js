// TS-02 — the LINE OA storefront: a customer opens the shop (GET /api/products?partner=), maybe
// checks a referral code (POST /api/discount/validate), and places an order with a slip
// (POST /api/orders, multipart). Load is expressed as ORDERS per second (the docs' line #1: 10 TPS
// on POST /api/orders); each order is ≈ 2.3 requests. Orders are spread round-robin over every
// orderable partner, because the order number is a Firestore transaction on one counter document
// per partner-month (docs §3.1.1) — one partner alone is a contention test, not a throughput one.
// Gates apply to the whole run (ramp up + hold + ramp down).
//
//   k6 run scenarios/ts02-storefront.js
//   PERF_ORDERS_PER_SEC=20 PERF_HOLD=10m k6 run scenarios/ts02-storefront.js
//
// Env: PERF_ORDERS_PER_SEC (10) · PERF_P_VALIDATE (0.3) · PERF_PARTNERS (all orderable) · PERF_RAMP (30s)
//      · PERF_HOLD (5m) · PERF_RAMP_DOWN (30s) · PERF_MAX_VUS · PERF_REFERRAL_CODE
// Every order CREATES a real order document and uploads a slip to GCS.
import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { loadCatalog } from '../lib/catalog.js';
import { SHOP_REQ_PER_ITER, storefrontJourney } from '../lib/journeys.js';
import { stepPlan, tagWindow, toSeconds } from '../lib/phases.js';
import { makeHandleSummary } from '../lib/summary.js';
import { summaryTrendStats, thresholdsFor, TS02_TAGS } from '../lib/thresholds.js';

const ORDERS = Number(__ENV.PERF_ORDERS_PER_SEC || 10);
const RAMP = toSeconds(cfg.ramp);
const HOLD = toSeconds(cfg.hold);
const PLAN = stepPlan([ORDERS], RAMP, HOLD, toSeconds(cfg.rampDown));
const P_VALIDATE = Number(__ENV.PERF_P_VALIDATE === undefined ? 0.3 : __ENV.PERF_P_VALIDATE);
// an order iteration is 2–3 requests, the upload being the long one: ~3 s covers it
const maxVUs = Number(__ENV.PERF_MAX_VUS || Math.ceil(ORDERS * 4) + 5);

export const options = {
  scenarios: {
    ts02: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      stages: PLAN.stages,
      preAllocatedVUs: Math.min(maxVUs, Math.max(5, ORDERS * 2)),
      maxVUs,
    },
  },
  thresholds: thresholdsFor(TS02_TAGS),
  summaryTrendStats,
};

export function setup() {
  const catalog = loadCatalog();
  const n = ORDERS * (HOLD + RAMP / 2 + toSeconds(cfg.rampDown) / 2);
  console.log(`[ts02] ${ORDERS} orders/s (≈ ${Math.round(ORDERS * SHOP_REQ_PER_ITER)} TPS) · ramp ${RAMP}s · hold ${HOLD}s · P(validate) ${P_VALIDATE} · ${catalog.partners.length} partner(s) · maxVUs ${maxVUs}`);
  console.warn(`[ts02] creates ≈ ${Math.round(n)} real orders (+ one slip file each in GCS)`);
  return { catalog };
}

export default function (data) {
  tagWindow(PLAN.phases);
  storefrontJourney({ catalog: data.catalog, k: exec.scenario.iterationInTest * cfg.taskCount + cfg.taskIndex, pValidate: P_VALIDATE });
}

const extend = (data, verdict) => {
  const v = (k) => (data.metrics[k] && data.metrics[k].values) || {};
  verdict.ordersOffered = ORDERS;
  verdict.ordersPlaced = v('http_reqs{name:shop.order,phase:s1}').count || v('iterations').count || 0;
  verdict.dropped = v('dropped_iterations').count || 0;
  verdict.targetRps = Math.round(ORDERS * SHOP_REQ_PER_ITER);
};

export const handleSummary = makeHandleSummary('ts02', extend);
