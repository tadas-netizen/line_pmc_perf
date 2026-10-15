import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { cfg } from './config.js';
import { toSeconds } from './phases.js';
import { buildReport, ictDate } from './report.js';

// handleSummary for every scenario: console text, full summary.json, and the compact
// verdict.json the rollup reads (kept from pmc-perf).
// `extend(data, verdict)` lets a scenario add fields (TS-01 adds per-step results) or veto
// the pass before the files are written.
// `windowSecOverride`: length of the measured run when it isn't ramp + PERF_HOLD + ramp down
// (soak's own hold, spike's jump).
export const makeHandleSummary = (scenario, extend, windowSecOverride) => (data) => {
  const m = data.metrics;
  // The measured window (`{phase:s1}`, declared by thresholdsFor) = ramp up + hold + ramp down.
  // Scenarios without one (smoke) report the whole run as k6 saw it.
  const steady = !!m['http_req_duration{phase:s1}']; // has a measured window (all load scenarios)
  const pick = (name) => {
    const k = steady && m[`${name}{phase:s1}`] ? `${name}{phase:s1}` : name;
    return (m[k] && m[k].values) || {};
  };
  const dur = pick('http_req_duration');
  // Error rate = HTTP errors + requests slower than 1 s (req_failed, lib/http.js). The two
  // parts are kept apart in the verdict too.
  const failed = pick('req_failed');
  const httpFailed = pick('http_req_failed');
  const slow = pick('req_slow');
  const reqs = pick('http_reqs');
  const windowSec = windowSecOverride || toSeconds(cfg.ramp) + toSeconds(cfg.hold) + toSeconds(cfg.rampDown);

  const perTag = {};
  for (const [key, metric] of Object.entries(m)) {
    // `{name:x}` or `{name:x,phase:s1}` (measured-window gates) — both report under `x`.
    const match = /^http_req_duration\{name:([^,}]+)(?:,phase:[^}]+)?\}$/.exec(key);
    if (match) perTag[match[1]] = { p95: metric.values['p(95)'], p99: metric.values['p(99)'], max: metric.values.max, count: metric.values.count };
  }

  const failedThresholds = Object.entries(m)
    .filter(([, metric]) => metric.thresholds && Object.values(metric.thresholds).some((t) => !t.ok))
    .map(([k]) => k);

  const verdict = {
    scenario,
    runId: cfg.runId,
    round: cfg.round,
    window: steady ? `ramp + hold + ramp down (${Math.round(windowSec)}s)` : 'whole run',
    requests: reqs.count,
    // Average rate over the measured run (k6's own rate also counts the graceful-stop tail).
    rps: steady ? reqs.count / windowSec : reqs.rate,
    p95: dur['p(95)'],
    p99: dur['p(99)'],
    max: dur.max,
    errRate: failed.rate,
    httpErrRate: httpFailed.rate,
    slowRate: slow.rate,
    pass: failedThresholds.length === 0,
    failedThresholds,
    perTag,
  };

  if (extend) extend(data, verdict);

  const out = { stdout: textSummary(data, { indent: ' ', enableColors: true }) };
  // k6 does not create directories. In the Cloud Run Job entrypoint.sh makes the per-round
  // folder; locally everything goes flat into results/ (kept in git via .gitkeep).
  const prefix = cfg.summaryDir
    ? `${cfg.summaryDir}/`
    : `results/${cfg.runId}_${scenario}_round-${cfg.round}_`;
  out[`${prefix}summary.json`] = JSON.stringify(data, null, 2);
  out[`${prefix}verdict.json`] = JSON.stringify(verdict, null, 2);
  // Report files for the delivery report (lib/report.js). A report error must never cost the
  // JSON results above: handleSummary writes nothing at all if it throws.
  try {
    const stepSeconds = {};
    (verdict.steps || []).forEach((s) => { if (s.achieved) stepSeconds[s.phase] = s.count / s.achieved; });
    // Scenario start (lib/phases.js run_start_ms); the Date column and window times are Thai time.
    const startGauge = m.run_start_ms && m.run_start_ms.values;
    const runStartMs = startGauge ? startGauge.min || startGauge.value : null;
    const summaryAtMs = Date.now();
    const r = buildReport(data, verdict, {
      runId: cfg.runId, round: cfg.round, date: ictDate(runStartMs || summaryAtMs), target: cfg.target, runStartMs, summaryAtMs,
      base: cfg.base, scenario, prefix: prefix.split('/').pop(), windowSec: steady ? windowSec : null, stepSeconds,
    });
    out[`${prefix}report.html`] = r.html;
    out[`${prefix}results.csv`] = r.csv;
  } catch (e) {
    console.warn(`[report] could not build report.html / results.csv: ${e}`);
  }
  return out;
};
