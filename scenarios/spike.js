// SPIKE — the priority mix, 0 → peak in 10 s (Vercel functions must scale out cold), hold 5 min,
// ramp down 30 s. Gate: p95 ≤ gate and errors < gate over the WHOLE run (jump + hold + ramp down,
// `s1`). The first 30 s at peak are also reported on their own as `stage:coldstart` — included in
// the gate like everything else, shown separately to explain it. Default peak = 2 × the mix's
// 170 TPS (PERF_SPIKE_RPS); the jump is PERF_SPIKE_RAMP; hold and ramp-down follow the standard shape.
import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { adminRole, sessionFor, sessions } from '../lib/auth.js';
import { loadCatalog, mainPartner } from '../lib/catalog.js';
import { mixRequest, MIX_TOTAL, parseMix } from '../lib/journeys.js';
import { registerPhases, tagWindow, toSeconds } from '../lib/phases.js';
import { makeHandleSummary } from '../lib/summary.js';
import { MIX_TAGS, summaryTrendStats, thresholdsFor } from '../lib/thresholds.js';

const MIX = parseMix(__ENV.PERF_MIX);
const PEAK = Number(__ENV.PERF_SPIKE_RPS || MIX_TOTAL(MIX) * 2);
const JUMP = toSeconds(__ENV.PERF_SPIKE_RAMP || '10s');
const HOLD = toSeconds(cfg.hold);
const DOWN = toSeconds(cfg.rampDown);
const COLD = Math.min(30, HOLD / 4);
const maxVUs = Number(__ENV.PERF_MAX_VUS || Math.ceil(PEAK * 3) + 10);
const PHASES = registerPhases([{ name: 's1', start: 0, holdStart: JUMP, holdEnd: JUMP + HOLD, end: JUMP + HOLD + DOWN }]);

const thresholds = thresholdsFor(MIX_TAGS);
thresholds['http_req_duration{stage:coldstart}'] = ['max>=0']; // reported only

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s',
      stages: [{ target: PEAK, duration: `${JUMP}s` }, { target: PEAK, duration: `${HOLD}s` }, { target: 0, duration: cfg.rampDown }],
      preAllocatedVUs: Math.min(maxVUs, PEAK), maxVUs,
    },
  },
  thresholds,
  summaryTrendStats,
};

export function setup() {
  const role = adminRole();
  const s = sessions([role]);
  const catalog = loadCatalog();
  console.log(`[spike] 0 → ${PEAK} TPS in ${JUMP}s · hold ${HOLD}s · cold-start window ${COLD}s`);
  return { sessions: s, catalog, partnerScope: role === 'partner' ? cfg.partner : '', partnerMain: mainPartner(catalog) };
}

export default function (data) {
  tagWindow(PHASES);
  const t = (Date.now() - exec.scenario.startTime) / 1000;
  if (t >= JUMP && t < JUMP + COLD) exec.vu.metrics.tags.stage = 'coldstart';
  const session = sessionFor(data, 'admin');
  mixRequest({ mix: MIX, catalog: data.catalog, session, partnerScope: data.partnerScope, partnerMain: data.partnerMain, k: exec.scenario.iterationInTest * cfg.taskCount + cfg.taskIndex });
}

export const handleSummary = makeHandleSummary('spike', (data, verdict) => { verdict.targetRps = PEAK; }, JUMP + HOLD + DOWN);
