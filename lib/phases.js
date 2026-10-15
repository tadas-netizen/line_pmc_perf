import exec from 'k6/execution';
import { Gauge } from 'k6/metrics';
import { cfg } from './config.js';

// Measurement windows. Kept from pmc-perf (lib/phases.js); the phase idea came from the TGIA
// reference toolkit.
//
// Since 2026-10-05 the MEASURED window is the WHOLE run, ramps included:
//   phase = s1, s2, …  — the window each request counts toward. Step N's window is its own
//                        ramp-up + hold; the last step also takes the final ramp-down. So
//                        `phase:s1` of a single-step run = ramp up + hold + ramp down.
//   stage = ramp-up | hold | ramp-down — WHERE in the shape the request ran; display only
//                        (runner shading), never used for PASS/FAIL.
// Thresholds and the report select `phase:sN`.

// rates: [target, …] (VUs for ramping-vus, iterations/s for arrival-rate) · rampSec/holdSec per
// step · returns k6 stages + windows (seconds from scenario start). Each window has
// start/end (whole measured window), holdStart/holdEnd, and the seconds it lasts.
export const stepPlan = (rates, rampSec, holdSec, rampDownSec = 10) => {
  const stages = [];
  const phases = [];
  let t = 0;
  rates.forEach((rps, i) => {
    stages.push({ target: rps, duration: `${rampSec}s` });
    stages.push({ target: rps, duration: `${holdSec}s` });
    phases.push({ name: `s${i + 1}`, rps, start: t, holdStart: t + rampSec, holdEnd: t + rampSec + holdSec, end: t + rampSec + holdSec, rampSec, holdSec, rampDownSec: 0 });
    t += rampSec + holdSec;
  });
  stages.push({ target: 0, duration: `${rampDownSec}s` });
  const last = phases[phases.length - 1];
  last.end += rampDownSec; // the final ramp-down counts toward the last step
  last.rampDownSec = rampDownSec;
  phases.forEach((ph) => { ph.seconds = ph.end - ph.start; });
  currentPhases = phases;
  return { stages, phases, totalSec: t + rampDownSec };
};

// The windows of this script's plan, for handleSummary (which re-runs the init code, so the plan
// built there is the same one). Empty for scripts without a plan (smoke).
let currentPhases = [];
export const planPhases = () => currentPhases;
// For a script that builds its windows by hand (spike).
export const registerPhases = (phases) => {
  currentPhases = phases;
  return phases;
};

const elapsed = () => (Date.now() - exec.scenario.startTime) / 1000;

// Measured window for "now": the step whose window contains it (the last one after the end).
export const phaseAt = (phases) => {
  const t = elapsed();
  for (let i = 0; i < phases.length; i++) if (t < phases[i].end) return phases[i].name;
  return phases[phases.length - 1].name;
};

// Where in the shape "now" is — display only.
export const stageAt = (phases) => {
  const t = elapsed();
  for (let i = 0; i < phases.length; i++) {
    if (t < phases[i].holdStart) return 'ramp-up';
    if (t < phases[i].holdEnd) return 'hold';
  }
  return 'ramp-down';
};

// When the scenario started (epoch ms), so the report can turn window offsets into clock times:
// handleSummary has no access to it otherwise. Recorded once per VU; every VU sees the same value.
const runStart = new Gauge('run_start_ms');
let runStartSent = false;

// Tag the current VU's requests with both (call at the top of every iteration).
export const tagWindow = (phases) => {
  exec.vu.metrics.tags.phase = phaseAt(phases);
  exec.vu.metrics.tags.stage = stageAt(phases);
  if (!runStartSent) {
    runStart.add(exec.scenario.startTime);
    runStartSent = true;
  }
};

// Seconds of the whole measured run (all windows).
export const measuredSeconds = (phases) => phases.reduce((a, ph) => a + ph.seconds, 0);

// Expected request count of a window at full delivery. A ramp averages the rates at its two ends:
// from the previous step's rate (`prevRps`, 0 for the first step) up to this one, and down to 0.
export const expectedCount = (ph, rps, prevRps = 0) =>
  rps * ph.holdSec + ((prevRps + rps) / 2) * ph.rampSec + (rps / 2) * ph.rampDownSec;

// '30s' / '5m' / '1m30s' → seconds.
export const toSeconds = (d) => {
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(String(d))) !== null) {
    matched = true;
    const v = parseFloat(m[1]);
    total += m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : m[2] === 'ms' ? v / 1000 : v;
  }
  if (!matched) throw new Error(`bad duration: ${d}`);
  return total;
};

// The standard load shape (cfg: PERF_RAMP 30s → PERF_HOLD 5m → PERF_RAMP_DOWN 30s) for one
// target — VUs for ramping-vus, iterations/s for ramping-arrival-rate. Measured window: `s1`
// = the whole run (ramp up + hold + ramp down).
// `holdOverride` lets a scenario whose point is duration (soak) keep its own hold.
export const standardPlan = (target, holdOverride) =>
  stepPlan([target], toSeconds(cfg.ramp), toSeconds(holdOverride || cfg.hold), toSeconds(cfg.rampDown));

// The same shape repeated per step (stress, TS-01 ladders): each step ramps then holds, and
// is measured on its own window `sN` (its ramp + hold; the last also takes the ramp-down).
export const ladderPlan = (targets, holdOverride) =>
  stepPlan(targets, toSeconds(cfg.ramp), toSeconds(holdOverride || cfg.hold), toSeconds(cfg.rampDown));
