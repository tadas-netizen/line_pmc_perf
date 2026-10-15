// CHECK — does each ticked endpoint work at all? A functional pass, not a load measurement: every
// endpoint for a moment at a low rate (default 5 TPS for 1 s, no ramp), one after another, all in
// ONE k6 run.
//
//   ENDPOINTS=products.list,admin.orders.list,admin.dashboard k6 run scenarios/check.js
//   … PERF_RPS=5 PERF_HOLD=1s CHECK_GAP=1 TS01_RATES=admin.slip:2
//
// One k6 run, so the roles sign in ONCE in setup() (bcrypt cost 12 per login — a Group Run at a low
// rate would sign in again for every endpoint). The auth endpoint logs in on every request, as
// that is the thing it checks; it runs last.
//
// Verdict per endpoint (one verdict.json each, like Group Run): PASS = at least one request of the
// endpoint ran and none failed (unexpected status). Latency is shown, never gated — 1 s at 5 TPS
// says nothing about performance. Requests slower than the slow gate are counted, not failed.
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { Counter, Gauge } from 'k6/metrics';
import { cfg } from '../lib/config.js';
import { adminRole, sessionFor, sessions } from '../lib/auth.js';
import { loadCatalog, mainPartner, orderPool } from '../lib/catalog.js';
import { ENDPOINTS, needsOf } from '../lib/endpoints.js';
import { expectShape } from '../lib/http.js';
import { toSeconds } from '../lib/phases.js';
import { idFor } from '../lib/apiIds.js';
import { CSV_HEAD, csvCell, fmtDur, ictDate, OK_STATUS, r1, r2, targetLabel } from '../lib/report.js';
import { GATE, REPORT_STATUSES, reportThresholds, summaryTrendStats } from '../lib/thresholds.js';

const TICKED = String(__ENV.ENDPOINTS || '').split(',').map((x) => x.trim()).filter(Boolean);
if (!TICKED.length) throw new Error('ENDPOINTS: tick at least one endpoint (comma-separated ids from lib/endpoints.js)');
TICKED.forEach((id) => { if (!ENDPOINTS[id]) throw new Error(`ENDPOINTS: "${id}" unknown — one of: ${Object.keys(ENDPOINTS).join(', ')}`); });
// auth last (each request is a bcrypt login); everything else keeps its ticked order
const IDS = TICKED.filter((id) => ENDPOINTS[id].kind !== 'auth').concat(TICKED.filter((id) => ENDPOINTS[id].kind === 'auth'));

const RATE = Number(__ENV.PERF_RPS || 5);
const OWN = {};
String(__ENV.TS01_RATES || '').split(',').forEach((x) => { const a = x.split(':'); if (a.length === 2 && +a[1] > 0) OWN[a[0]] = Math.round(+a[1]); });
const rateOf = (id) => OWN[id] || RATE;
const HOLD = __ENV.PERF_HOLD ? toSeconds(__ENV.PERF_HOLD) : 1; // this scenario's own default: 1 s
const GAP = Number(__ENV.CHECK_GAP || 1);
if (!(HOLD > 0) || IDS.some((id) => !Number.isInteger(rateOf(id)))) throw new Error('PERF_HOLD > 0 and whole TPS, e.g. PERF_RPS=5');

const VUS = Math.max(2, Math.ceil(Math.max.apply(null, IDS.map(rateOf)) * 1.5) + 1);
// A request still running when its window ends gets GRACE s to answer before k6 cuts it (a cut
// request is never recorded — a cold Vercel function can take seconds on the first hit).
const GRACE = Math.max(10, GAP);
const scenarios = {}, plan = [];
let at = 0;
IDS.forEach((id, k) => {
  const name = `e${String(k + 1).padStart(2, '0')}`;
  scenarios[name] = {
    executor: 'constant-arrival-rate', rate: rateOf(id), timeUnit: '1s', duration: `${HOLD}s`,
    preAllocatedVUs: VUS, maxVUs: VUS, startTime: `${at}s`, gracefulStop: `${GRACE}s`,
    tags: { endpoint: id }, env: { CHECK_ID: id },
  };
  plan.push({ id, name, start: at, rate: rateOf(id) });
  at += HOLD + GAP;
});

const thresholds = reportThresholds(IDS.map((id) => `name:${id}`), {});
IDS.forEach((id) => { thresholds[`check_started{name:${id}}`] = ['count>=0']; });
const started = new Counter('check_started');

export const options = { scenarios, thresholds, summaryTrendStats, setupTimeout: '120s' };

export function setup() {
  console.log(`[check] ${IDS.length} endpoint(s) · ${HOLD}s each at ${RATE} TPS (own: ${Object.keys(OWN).length}) · gap ${GAP}s · ≈ ${Math.round(at)} s · ${VUS} VUs`);
  const need = needsOf(IDS);
  const s = sessions(Array.from(need.roles), false);
  const catalog = loadCatalog();
  const adminSession = s[adminRole()] || s.super;
  const pool = need.pool && adminSession ? orderPool(adminSession, 100, adminRole() === 'partner' ? cfg.partner : '') : [];
  return { sessions: s, catalog, pool };
}

const startGauge = new Gauge('check_start_ms');
const startSent = {};
export default function (data) {
  const id = __ENV.CHECK_ID, ep = ENDPOINTS[id];
  if (!startSent[id]) { startGauge.add(exec.scenario.startTime - plan.filter((p) => p.id === id)[0].start * 1000); startSent[id] = true; }
  const ctx = { data, vu: exec.vu.idInTest, iter: exec.scenario.iterationInTest, partner: mainPartner(data.catalog) };
  if (ep.who !== 'none') {
    ctx.session = sessionFor(data, ep.who);
    if (!expectShape({ status: 0 }, id, 'has a session', () => !!ctx.session)) return;
  }
  started.add(1, { name: id });
  ep.run(ctx, id);
}

const v = (m, k) => (m[k] && m[k].values) || {};
const failedChecks = (g, out) => {
  ((g && g.checks) || []).forEach((c) => { if (c.fails) out.push(c); });
  ((g && g.groups) || []).forEach((x) => failedChecks(x, out));
  return out;
};
export function handleSummary(data) {
  const m = data.metrics, out = { stdout: textSummary(data, { indent: ' ', enableColors: true }) };
  const base = cfg.summaryDir ? `${cfg.summaryDir}/` : `results/${cfg.runId}_`;
  out[`${base}check_round-${cfg.round}_summary.json`] = JSON.stringify(data, null, 2);
  const lines = [], csv = [CSV_HEAD.join(',')];
  const failedCk = failedChecks(data.root_group, []);
  const loginFails = failedCk.filter((c) => /^prep\.login\b/.test(c.name)).reduce((a, c) => a + c.fails, 0);
  const sg = m.check_start_ms && m.check_start_ms.values;
  const t0 = (sg && (sg.min || sg.value)) || Date.now() - ((data.state && data.state.testRunDurationMs) || 0);
  const ict = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(11, 19);
  plan.forEach((p) => {
    const d = v(m, `http_req_duration{name:${p.id}}`), count = v(m, `http_reqs{name:${p.id}}`).count || 0;
    const f = v(m, `req_failed{name:${p.id}}`), slow = v(m, `req_slow{name:${p.id}}`);
    const failed = Math.max(0, (f.passes || 0) - (slow.passes || 0)); // a slow-but-correct answer is not a failure here
    const why = [];
    const began = v(m, `check_started{name:${p.id}}`).count || 0;
    if (!count) {
      const own = failedCk.filter((c) => (c.name.indexOf(`${p.id} `) === 0 || /^prep\./.test(c.name)) && !/ \d{3}$/.test(c.name));
      why.push(own.length ? `no ${p.id} request ran — a precondition failed: ${own.map((c) => `"${c.name.indexOf(`${p.id} `) === 0 ? c.name.slice(p.id.length + 1) : c.name}" ✗${c.fails}`).join(', ')}`
        : began ? `no ${p.id} request finished: ${began} started but none answered before k6 cut them ${GRACE} s after the window — a very slow answer, e.g. a cold start`
        : ENDPOINTS[p.id].who === 'none' ? `no ${p.id} request ran (see the Error detail)`
        : `no ${p.id} request ran — no ${ENDPOINTS[p.id].who} session${loginFails ? ` (login checks ✗${loginFails})` : ''} — see the Error detail`);
    }
    if (failed) why.push(`${failed} of ${count} answered an unexpected status`);
    const verdict = {
      scenario: 'check', endpoint: p.id, mode: 'check', runId: cfg.runId, round: cfg.round,
      window: `${fmtDur(HOLD)} @ ${p.rate} TPS`, offered: p.rate, requests: count, measured: count, rps: count / HOLD,
      p95: d['p(95)'], p99: d['p(99)'], max: d.max, errRate: count ? failed / count : null, slowCount: slow.passes || 0,
      pass: why.length === 0, failedThresholds: why,
    };
    out[`${base}check-${p.id}_round-${cfg.round}_verdict.json`] = JSON.stringify(verdict, null, 2);
    const bad = REPORT_STATUSES.filter((c) => !OK_STATUS.test(c)).map((c) => [c, v(m, `http_reqs{name:${p.id},status:${c}}`).count || 0]).filter((x) => x[1]);
    const notes = why.map((w) => `FAIL: ${w}`)
      .concat(bad.length ? [`status: ${bad.map((x) => `${x[0] === '0' ? '0 (no response)' : x[0]}×${x[1]}`).join(', ')}`] : [])
      .concat(slow.passes ? [`> ${GATE.slowMs / 1000} s ×${slow.passes} (not failed here)`] : [])
      .concat(['check: functional, latency not gated']);
    csv.push([cfg.runId, ictDate(t0), targetLabel(cfg.target), 'Check', p.id, verdict.window, count, r1(d.avg), r1(d.min), r1(d.med), r1(d['p(90)']),
      r1(d['p(95)']), r1(d['p(99)']), r1(d.max), count ? r2((failed / count) * 100) : '', r2(count / HOLD), p.rate,
      verdict.pass ? 'PASS' : 'FAIL', notes.join(' · '), idFor(p.id, 'ts01'), ict(t0 + p.start * 1000), ict(t0 + (p.start + HOLD) * 1000)].map(csvCell).join(','));
    lines.push(`${verdict.pass ? 'PASS' : 'FAIL'}  ${p.id.padEnd(28)} ${String(count).padStart(4)} req · p95 ${d['p(95)'] == null ? '–' : Math.round(d['p(95)'])} ms${why.length ? ` · ${why.join(' · ')}` : ''}`);
  });
  out[`${base}check_round-${cfg.round}_results.csv`] = csv.join('\n') + '\n';
  out.stdout += `\n[check] per endpoint:\n${lines.map((l) => `  ${l}`).join('\n')}\n`;
  return out;
}
