// Per-run report files for the delivery report. Kept from pmc-perf (lib/report.js; originally
// ported from the TGIA reference), relabelled for pmc-line: its scenarios, tags, targets and
// warnings.
//
// Produced by k6's handleSummary (lib/summary.js) — so every run makes them: runner, command
// line or Cloud Run:
//   <prefix>report.html   self-contained page (no external fonts/scripts): verdict, KPIs,
//                         per-row table with expandable detail, p95 bars, steps, checks,
//                         settings, notes. tools/runner.py later adds "Error detail".
//   <prefix>results.csv   one row per measured row, for building the customer report
//
// Rows = every measured window k6 aggregated: all requests (`phase:sN`) and each endpoint tag
// (`name:x,phase:sN`). The detail sub-metrics they read (timings, status counts) are declared
// by reportThresholds() in lib/thresholds.js.
import { GATE, REPORT_STATUSES, REPORT_TIMINGS } from './thresholds.js';
import { idFor } from './apiIds.js';
import { planPhases } from './phases.js';

const r0 = (v) => (v === undefined || v === null || isNaN(v) ? '' : Math.round(v));
export const r1 = (v) => (v === undefined || v === null || isNaN(v) ? '' : Math.round(v * 10) / 10);
export const r2 = (v) => (v === undefined || v === null || isNaN(v) ? '' : Math.round(v * 100) / 100);
const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const csvCell = (v) => {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fmtInt = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const TIMING_LABEL = {
  http_req_blocked: 'blocked (waiting for a free connection)',
  http_req_connecting: 'connecting (TCP)',
  http_req_tls_handshaking: 'TLS handshake',
  http_req_sending: 'sending',
  http_req_waiting: 'waiting (time to first byte ≈ server time)',
  http_req_receiving: 'receiving',
};

export const SCENARIO_LABEL = {
  smoke: 'Smoke', check: 'Check', ts01: 'TS-01 Endpoint', ts02: 'TS-02 Storefront (LINE OA)', ts03: 'TS-03 Admin orders',
  ts04: 'TS-04 Admin dashboard', soak: 'Soak', stress: 'Stress', spike: 'Spike', auth: 'Sign-in',
};
const scenarioLabel = (scenario) => {
  const m = /^ts01-(.+)$/.exec(scenario);
  return m ? `${SCENARIO_LABEL.ts01} · ${m[1]}` : (SCENARIO_LABEL[scenario] || scenario);
};
// results.csv's Scenario column: the scenario alone (TS-01's endpoint is already in Row and ID), so a
// sheet filter on Scenario gives one value per scenario.
const csvScenario = (scenario) => (/^ts01-/.test(scenario) ? SCENARIO_LABEL.ts01 : SCENARIO_LABEL[scenario] || scenario);
// One spelling per environment in the report and results.csv (cfg.target stays as config has it).
export const TARGET_LABEL = { stg: 'STAGING', prod: 'PRODUCTION', custom: 'CUSTOM', local: 'LOCAL', 'local pmc-line': 'LOCAL', 'local (mock)': 'MOCK' };
export const targetLabel = (t) => TARGET_LABEL[t] || t;
// 150 → "2m 30s", 60 → "1m", 1 → "1s"
export const fmtDur = (sec) => {
  const t = Math.round(sec), m = Math.floor(t / 60), x = t % 60;
  return m ? `${m}m${x ? ` ${x}s` : ''}` : `${x}s`;
};

// ---- rows ---------------------------------------------------------------------------------

const vals = (m, k) => (m[k] && m[k].values) || null;

// Measured windows present in this run: "phase:s1", "name:orders.get,phase:s2", …
const selectors = (m) => {
  const all = [];
  const tags = [];
  Object.keys(m).forEach((k) => {
    let x = /^http_req_duration\{(phase:[^,}]+)\}$/.exec(k);
    if (x) all.push(x[1]);
    x = /^http_req_duration\{(name:[^,}]+,phase:[^,}]+)\}$/.exec(k);
    if (x) tags.push(x[1]);
  });
  all.sort();
  tags.sort();
  return all.concat(tags);
};

const rowOf = (m, sel, ctx) => {
  const d = vals(m, `http_req_duration{${sel}}`);
  const c = vals(m, `http_reqs{${sel}}`);
  const f = vals(m, `req_failed{${sel}}`);
  const hf = vals(m, `http_req_failed{${sel}}`);
  const sl = vals(m, `req_slow{${sel}}`);
  const count = c ? c.count : d ? d.count : 0;
  const nameM = /name:([^,}]+)/.exec(sel);
  const phase = (/phase:([^,}]+)/.exec(sel) || [])[1];
  const step = (ctx.steps || []).filter((s) => s.phase === phase)[0];
  const id = nameM ? nameM[1] : 'ALL requests';
  // Window: "<length> @ <offered rate>" — "2m 30s @ 300 TPS"; a multi-step run (ladder, stress) says
  // which step; the blended row of a journey carries the journey's offered rate.
  const phases = planPhases(), ph = phases.filter((p) => p.name === phase)[0];
  const offered = step ? step.offered : !nameM && ctx.targetRps ? ctx.targetRps : null;
  const rate = offered ? ` @ ${offered} TPS` : !nameM && ctx.opens ? ` @ ${ctx.opens} orders/s` : '';
  const label = ph ? `${phases.length > 1 ? `step ${phases.indexOf(ph) + 1} · ` : ''}${fmtDur(ph.seconds)}${rate}` : `${phase}${rate}`;
  if (!d || !count) return { id, label, sel, offered, step, empty: true };
  const errRate = f ? f.rate : 0;
  const statuses = [];
  REPORT_STATUSES.forEach((code) => {
    const s = vals(m, `http_reqs{${sel},status:${code}}`);
    if (s && s.count) statuses.push({ code, n: s.count });
  });
  const known = statuses.reduce((a, s) => a + s.n, 0);
  if (count - known > 0) statuses.push({ code: 'other', n: count - known });
  const timings = REPORT_TIMINGS.map((t) => ({ label: TIMING_LABEL[t], v: vals(m, `${t}{${sel}}`) }));
  const windowSec = step && ctx.stepSeconds ? ctx.stepSeconds[phase] : ctx.windowSec;
  const why = [];
  if (!(d['p(95)'] <= GATE.p95)) why.push(`p95 ${r0(d['p(95)'])} > ${GATE.p95} ms`);
  if (!(errRate < GATE.errRate)) why.push(`errors ${r2(errRate * 100)} % ≥ ${GATE.errRate * 100} %`);
  return {
    id, label, sel, count, v: d, errRate, failed: f ? f.passes : 0, httpFailed: hf ? hf.passes : 0, slow: sl ? sl.passes : 0, statuses, timings,
    rps: windowSec ? count / windowSec : null, offered, step,
    verdict: why.length ? 'FAIL' : 'PASS', why,
  };
};

// ---- CSV ------------------------------------------------------------------------------------

// Exported for scenarios/check.js, which writes its own rows in these columns.
export const CSV_HEAD = ['Run ID', 'Date', 'Target', 'Scenario', 'Row', 'Window', 'Requests', 'RT Avg (ms)', 'RT Min (ms)',
  'RT Med (ms)', 'RT P90 (ms)', 'RT P95 (ms)', 'RT P99 (ms)', 'RT Max (ms)', 'Error Rate (%)', 'Throughput (TPS)',
  'Offered (TPS)', 'PASS/FAIL', 'Notes',
  // New columns only ever go at the end, so pastes into the results sheet keep lining up.
  'ID', 'Start time', 'End time'];

// Clock time of a row's measured window in Thai time (UTC+7, no DST), from the scenario's start
// (run_start_ms, lib/phases.js) and the window's offsets in the plan. A run cut short (stress
// stop rule, Ctrl-C) ends at the summary time, not the planned end.
const ICT_MS = 7 * 3600 * 1000;
const two = (n) => (n < 10 ? '0' : '') + n;
export const ictDate = (ms) => new Date(ms + ICT_MS).toISOString().slice(0, 10);
const ictTime = (ms) => {
  const d = new Date(ms + ICT_MS);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
};
const windowClock = (meta, sel) => {
  const phase = (/phase:([^,}]+)/.exec(sel || '') || [])[1];
  const ph = planPhases().filter((p) => p.name === phase)[0];
  if (!meta.runStartMs || !ph) return { start: '', end: '' };
  const end = Math.min(meta.runStartMs + ph.end * 1000, meta.summaryAtMs || Date.now());
  return { start: ictTime(meta.runStartMs + ph.start * 1000), end: ictTime(end) };
};

// The Notes column: what the other columns don't say. FAIL reasons; for a step,
// how much of the offered load was delivered; failed responses by HTTP status and responses over
// 1 s; on the run's main row, data warnings. tools/runner.py appends error codes, where they
// failed and when (k6's summary has no timestamps).
export const OK_STATUS = /^[23]/;
const noteFor = (x, warnings) => {
  const parts = [];
  if (x.verdict === 'FAIL') parts.push(`FAIL: ${x.why.join('; ')}`);
  if (x.step && x.step.expected) {
    const pct = Math.round((x.count / x.step.expected) * 100);
    // a step that sent < 95 % of its load says little about that load, whatever PASS/FAIL says
    parts.push(x.step.delivered === false ? `⚠ only ${pct} % of the offered load was sent (${fmtInt(x.count)} of ${fmtInt(x.step.expected)})` : `delivered ${pct} %`);
  }
  const bad = (x.statuses || []).filter((s) => !OK_STATUS.test(s.code));
  if (bad.length) parts.push(`status: ${bad.map((s) => `${s.code === '0' ? '0 (no response)' : s.code}×${s.n}`).join(', ')}`);
  if (x.slow) parts.push(`> ${GATE.slowMs / 1000} s ×${x.slow}`);
  return parts.concat(warnings).join(' · ');
};

// Run-level warnings that make a result untrustworthy: data ran out, or k6 could not keep the rate.
const walkChecks = (group, out) => {
  if (!group) return out;
  const checks = Array.isArray(group.checks) ? group.checks : Object.values(group.checks || {});
  checks.forEach((c) => out.push(c));
  const groups = Array.isArray(group.groups) ? group.groups : Object.values(group.groups || {});
  groups.forEach((g) => walkChecks(g, out));
  return out;
};
const DATA_CHECKS = [
  [/has an order to act on/, 'no admin order to act on (empty order pool)'],
  [/has an orderable product/, 'no orderable product (empty catalog)'],
  [/has a next page/, 'no next page (fewer orders than one page)'],
  [/has a session/, 'no admin session (login failed / not configured)'],
];
export const runWarnings = (data, verdict) => {
  const out = [];
  if (verdict.prepFailed) out.push(`⚠ prep failures ${fmtInt(verdict.prepFailed)} (a setup step before the measured call failed)`);
  const checks = walkChecks(data.root_group, []);
  DATA_CHECKS.forEach(([re, label]) => {
    const fails = checks.filter((c) => re.test(c.name)).reduce((n, c) => n + (c.fails || 0), 0);
    if (fails) out.push(`⚠ ${label} ×${fmtInt(fails)}`);
  });
  // admin sessions that were missing (lib/auth.js sessionFor): those iterations sent nothing
  const noSession = data.metrics.no_session && data.metrics.no_session.values.count;
  if (noSession) out.push(`⚠ ${fmtInt(noSession)} iterations sent nothing: no admin session (login failed or the account is not configured; lib/auth.js retries with back-off)`);
  // the whole run, not just the measured rows: logins and prep calls failing en masse (e.g. 429 on auth)
  const all = data.metrics.req_failed && data.metrics.req_failed.values;
  const reqs = data.metrics.http_reqs && data.metrics.http_reqs.values.count;
  if (all && reqs && all.rate >= GATE.errRate) out.push(`⚠ whole run: ${r1(all.rate * 100)} % of ${fmtInt(reqs)} requests failed, logins and prep included`);
  const dropped = data.metrics.dropped_iterations && data.metrics.dropped_iterations.values.count;
  if (dropped) out.push(`⚠ dropped iterations ${fmtInt(dropped)} (k6 could not keep the rate: too few VUs — raise PERF_MAX_VUS)`);
  return out;
};

const buildCsv = (rows, meta) => {
  const lines = [CSV_HEAD.join(',')];
  // A row with no request is left out — except the endpoint a TS-01 run measures: its 0 must reach
  // the sheet as a FAIL.
  const shown = rows.filter((x) => !x.empty || (meta.endpoint && x.id === meta.endpoint));
  // Run-level warnings go on the blended row, or on every row when there is none (TS-01 steps).
  const hasAll = shown.some((x) => x.id === 'ALL requests');
  shown.forEach((x) => {
    const w = windowClock(meta, x.sel);
    if (x.empty) {
      lines.push([meta.runId, meta.date, targetLabel(meta.target), csvScenario(meta.scenario), x.id, x.label, 0, '', '', '', '', '', '', '', '', 0,
        x.offered === null ? '' : x.offered, 'FAIL', [`FAIL: no ${x.id} request was sent (every iteration stopped before it: login or prep failed)`].concat(meta.warnings).join(' · '),
        idFor(x.id, 'ts01'), w.start, w.end].map(csvCell).join(','));
      return;
    }
    lines.push([meta.runId, meta.date, targetLabel(meta.target), csvScenario(meta.scenario), x.id, x.label, x.count, r1(x.v.avg), r1(x.v.min),
      r1(x.v.med), r1(x.v['p(90)']), r1(x.v['p(95)']), r1(x.v['p(99)']), r1(x.v.max), r2(x.errRate * 100), r2(x.rps),
      x.offered === null ? '' : x.offered, x.verdict, noteFor(x, !hasAll || x.id === 'ALL requests' ? meta.warnings : []),
      idFor(x.id, meta.scenario.indexOf('ts01-') === 0 ? 'ts01' : meta.scenario), w.start, w.end].map(csvCell).join(','));
  });
  return lines.join('\n') + '\n';
};

// ---- HTML -----------------------------------------------------------------------------------

const CSS = `
:root,:root[data-theme="light"]{color-scheme:light;--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--pass:#1f7a4d;--pass-bg:#e3f3ea;
--fail:#b3261e;--fail-bg:#fbe7e5;--warn:#8a5a00;--warn-bg:#fdf1d8;--bar:#3a6fb0;--bar-over:#b3261e;--target:#1d1d1b;--hover:#f3f2ee}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#161615;--card:#1f1f1d;--fg:#ececea;--muted:#a3a39d;
--line:#33332f;--pass:#6fd19f;--pass-bg:#18321f;--fail:#ff8a80;--fail-bg:#3a1a18;--warn:#f3c26b;--warn-bg:#352a12;
--bar:#7fa8e0;--bar-over:#ff8a80;--target:#ececea;--hover:#262624}}
@media print{:root{--bg:#fff;--card:#fff;--fg:#000;--muted:#555;--line:#ccc}tr.detail[hidden]{display:table-row!important}.tools{display:none}}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",Tahoma,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.meta{color:var(--muted);font-size:13px}.meta code{font-size:12px}
.banner{display:flex;align-items:center;gap:12px;margin:18px 0;padding:14px 16px;border-radius:10px;font-weight:600;flex-wrap:wrap}
.banner.pass{background:var(--pass-bg);color:var(--pass)}.banner.fail{background:var(--fail-bg);color:var(--fail)}
.banner .big{font-size:22px;letter-spacing:.5px}.banner .why{font-weight:400;color:inherit;font-size:14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile .k{color:var(--muted);font-size:12px}.tile .v{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums}
.tile.bad .v{color:var(--fail)}.tile.good .v{color:var(--pass)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{font-size:12px;color:var(--muted);font-weight:600;background:var(--card);position:sticky;top:0}
td.l,th.l{text-align:left}tr:last-child td{border-bottom:0}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.chip.pass{background:var(--pass-bg);color:var(--pass)}.chip.fail{background:var(--fail-bg);color:var(--fail)}.chip.none{background:var(--warn-bg);color:var(--warn)}
.why{color:var(--fail);font-size:12px;white-space:normal}
.p95{display:grid;grid-template-columns:minmax(120px,220px) 1fr 110px;gap:8px 12px;align-items:center;padding:14px 16px}
.p95 .name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.p95 .num{text-align:right;font-size:13px;font-variant-numeric:tabular-nums}
.track{position:relative;height:14px;background:var(--line);border-radius:3px}
.fill{position:absolute;left:0;top:0;bottom:0;background:var(--bar);border-radius:3px}.fill.over{background:var(--bar-over)}
.tgt{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--target)}
tr.row{cursor:pointer}tr.row:hover td{background:var(--hover)}
.caret{display:inline-block;width:14px;color:var(--muted);transition:transform .15s}tr.row[aria-expanded="true"] .caret{transform:rotate(90deg)}
tr.detail>td{background:var(--hover);padding:4px 14px 16px;white-space:normal}
.dgrid{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px 24px}.dgrid section{flex:0 1 auto;max-width:100%}
.dgrid h3{font-size:12px;color:var(--muted);margin:8px 0 6px;font-weight:600}
table.mini{background:var(--card);border:1px solid var(--line);border-radius:8px;border-collapse:separate;border-spacing:0;overflow:hidden}
table.mini th,table.mini td{padding:5px 8px;font-size:12px}table.mini th{position:static}
.sc{display:inline-block;min-width:44px;text-align:center;padding:0 6px;border-radius:4px;font-weight:600;font-size:12px}
.sc.ok{background:var(--pass-bg);color:var(--pass)}.sc.warn{background:var(--warn-bg);color:var(--warn)}.sc.bad{background:var(--fail-bg);color:var(--fail)}
.track.sm{height:8px;width:120px}.hrow{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.tools button{font:inherit;font-size:12px;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:3px 10px;margin-left:6px;cursor:pointer}
pre{margin:0;padding:12px 14px;font-size:12px;white-space:pre-wrap}
.foot{margin-top:28px;color:var(--muted);font-size:12px}
@media (max-width:600px){.p95{grid-template-columns:90px 1fr 80px}h1{font-size:19px}}
`;

const scClass = (code) => (code[0] === '2' || code[0] === '3' ? 'ok' : code[0] === '4' ? 'warn' : 'bad');

const detailHtml = (x, checks) => {
  const v = x.v;
  const crit = [
    ['p95', `${r0(v['p(95)'])} ms`, `≤ ${GATE.p95} ms`, v['p(95)'] <= GATE.p95],
    ['Error rate', `${r2(x.errRate * 100)} % (${fmtInt(x.failed)} of ${fmtInt(x.count)}: ${fmtInt(x.httpFailed)} HTTP errors, ${fmtInt(x.slow)} slower than ${GATE.slowMs / 1000} s)`, `< ${GATE.errRate * 100} %, a response > ${GATE.slowMs / 1000} s counts as an error`, x.errRate < GATE.errRate],
  ].map(([k, val, lim, ok]) => `<tr><td class="l">${k}</td><td>${esc(val)}</td><td class="l">${esc(lim)}</td><td class="l"><span class="chip ${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></td></tr>`).join('');
  const timingRows = x.timings.filter((t) => t.v).map((t) => `<tr><td class="l">${esc(t.label)}</td><td>${r2(t.v.avg)}</td><td>${r2(t.v['p(95)'])}</td><td>${r2(t.v.max)}</td></tr>`).join('');
  const statusRows = x.statuses.map((st) => {
    const pct = x.count ? (st.n / x.count) * 100 : 0;
    return `<tr><td class="l"><span class="sc ${scClass(st.code)}">${esc(st.code === '0' ? '0 (no response)' : st.code)}</span></td><td>${fmtInt(st.n)}</td><td>${r2(pct)} %</td><td class="l"><div class="track sm"><div class="fill" style="width:${pct}%"></div></div></td></tr>`;
  }).join('');
  const own = x.id === 'ALL requests' ? [] : checks.filter((c) => c.name.indexOf(`${x.id} `) === 0);
  const checkRows = own.map((c) => `<tr><td class="l">${esc(c.name)}</td><td>${fmtInt(c.passes)}</td><td>${fmtInt(c.fails)}</td><td class="l"><span class="chip ${c.fails ? 'fail' : 'pass'}">${c.fails ? 'FAIL' : 'PASS'}</span></td></tr>`).join('');
  return `<div class="dgrid">
<section><h3>Gate (PASS/FAIL)</h3><table class="mini"><thead><tr><th class="l">metric</th><th>actual</th><th class="l">gate</th><th class="l"></th></tr></thead><tbody>${crit}</tbody></table></section>
<section><h3>Latency (ms) — reported</h3><table class="mini"><thead><tr><th>min</th><th>avg</th><th>med</th><th>p90</th><th>p95</th><th>p99</th><th>max</th></tr></thead>
<tbody><tr><td>${r0(v.min)}</td><td>${r0(v.avg)}</td><td>${r0(v.med)}</td><td>${r0(v['p(90)'])}</td><td>${r0(v['p(95)'])}</td><td>${r0(v['p(99)'])}</td><td>${r0(v.max)}</td></tr></tbody></table>
<div class="meta">n=${fmtInt(x.count)} · window <code>${esc(x.sel)}</code></div></section>
${statusRows ? `<section><h3>Status codes</h3><table class="mini"><thead><tr><th class="l">code</th><th>count</th><th>%</th><th class="l"></th></tr></thead><tbody>${statusRows}</tbody></table>
<div class="meta">"other" = a status not in REPORT_STATUSES (lib/thresholds.js)</div></section>` : ''}
${timingRows ? `<section><h3>Where the time went (ms)</h3><table class="mini"><thead><tr><th class="l">part</th><th>avg</th><th>p95</th><th>max</th></tr></thead><tbody>${timingRows}</tbody></table>
<div class="meta">high waiting = slow server · high connecting/TLS = network or no connection reuse</div></section>` : ''}
${checkRows ? `<section><h3>Checks for this tag</h3><table class="mini"><thead><tr><th class="l">check</th><th>passed</th><th>failed</th><th class="l"></th></tr></thead><tbody>${checkRows}</tbody></table></section>` : ''}
</div>`;
};

const buildHtml = (rows, meta, verdict, data) => {
  const ran = rows.filter((x) => !x.empty);
  const failedRows = ran.filter((x) => x.verdict === 'FAIL');
  const checks = (data.root_group && collectChecks(data.root_group)) || [];
  const failedChecks = checks.filter((c) => c.fails > 0);
  const crossed = verdict.failedThresholds || [];
  const dropped = vals(data.metrics, 'dropped_iterations');
  const droppedN = dropped ? dropped.count : 0;
  const checksV = vals(data.metrics, 'checks');
  const overallFail = !verdict.pass;
  const reasons = [];
  if (failedRows.length) reasons.push(`${failedRows.length} row(s) over the gate`);
  if (crossed.length) reasons.push(`${crossed.length} threshold(s) crossed`);
  if (failedChecks.length) reasons.push(`${failedChecks.length} check(s) with failures (reported)`);
  if (droppedN > 0) reasons.push(`dropped iterations ${fmtInt(droppedN)} (load not fully delivered)`);

  const tableRows = rows.map((x, i) => {
    if (x.empty) return `<tr><td class="l"><b>${esc(x.id)}</b></td><td class="l">${esc(x.label)}</td><td colspan="10" class="l"><span class="chip none">no requests</span></td></tr>`;
    const v = x.v;
    return `<tr class="row" tabindex="0" role="button" aria-expanded="false" data-d="d${i}"><td class="l"><span class="caret" aria-hidden="true">▸</span><b>${esc(x.id)}</b></td><td class="l">${esc(x.label)}</td>
<td>${x.offered === null ? '–' : x.offered}</td><td>${r2(x.rps)}</td><td>${fmtInt(x.count)}</td><td>${r0(v.avg)}</td><td>${r0(v['p(90)'])}</td><td><b>${r0(v['p(95)'])}</b></td><td>${r0(v['p(99)'])}</td><td>${r0(v.max)}</td>
<td>${r2(x.errRate * 100)}</td><td class="l"><span class="chip ${x.verdict === 'PASS' ? 'pass' : 'fail'}">${x.verdict}</span>${x.why.length ? ` <span class="why">${esc(x.why.join(', '))}</span>` : ''}</td></tr>
<tr class="detail" id="d${i}" hidden><td colspan="12" class="l">${detailHtml(x, checks)}</td></tr>`;
  }).join('\n');

  const scale = Math.max.apply(null, [GATE.p95].concat(ran.map((x) => x.v['p(95)'] || 0))) * 1.1;
  const bars = ran.map((x) => {
    const p = x.v['p(95)'];
    return `<div class="name" title="${esc(x.sel)}"><b>${esc(x.id)}</b> <span class="meta">${esc(x.label)}</span></div>
<div class="track" title="p95 ${r0(p)} ms · gate ${GATE.p95} ms"><div class="fill${p > GATE.p95 ? ' over' : ''}" style="width:${(p / scale) * 100}%"></div><div class="tgt" style="left:${(GATE.p95 / scale) * 100}%"></div></div>
<div class="num">${r0(p)} / ${GATE.p95} ms</div>`;
  }).join('\n');

  const steps = verdict.steps && verdict.steps.length ? `<h2>Steps${verdict.mode === 'ladder' && verdict.capacityRps !== undefined ? ` · capacity within the gate: ${esc(verdict.capacityRps)} TPS` : ''}</h2>
<div class="card"><table><thead><tr><th class="l">step</th><th>offered TPS</th><th>achieved TPS (window avg)</th><th>delivered</th><th>n</th><th>p95</th><th>p99</th><th>max</th><th>errors %</th><th>&gt; ${GATE.slowMs / 1000} s</th><th class="l">gate</th></tr></thead><tbody>
${verdict.steps.map((s) => `<tr><td class="l">${esc(s.phase)}</td><td>${esc(s.offered)}</td><td>${r2(s.achieved)}</td><td>${s.delivered === undefined ? '–' : s.delivered ? '≥ 95 %' : '&lt; 95 %'}</td><td>${fmtInt(s.count)}</td><td>${r0(s.p95)}</td><td>${r0(s.p99)}</td><td>${r0(s.max)}</td><td>${r2((s.errRate || 0) * 100)}</td><td>${s.slowCount === undefined ? '–' : `${fmtInt(s.slowCount)} (${r2((s.slowRate || 0) * 100)} %)`}</td><td class="l"><span class="chip ${s.pass ? 'pass' : 'fail'}">${s.pass ? 'PASS' : 'FAIL'}</span></td></tr>`).join('')}
</tbody></table></div>` : '';

  const notes = [];
  if (verdict.targetFloor) notes.push(`Target throughput (reported, not gated): ${fmtInt(verdict.requests)} requests vs ≥ ${fmtInt(verdict.targetFloor)} at the target rate over the measured window — ${verdict.targetMet ? 'met' : 'NOT met'}`);
  if (verdict.scenario === 'stress') notes.push(`Whole-run average ${r2(verdict.rps)} TPS, ${fmtInt(verdict.slowCount || 0)} responses over ${GATE.slowMs / 1000} s · this run's one-second peak: scripts/rollup.ts (needs the raw output)`);
  if (verdict.crosses300At !== undefined) notes.push(`p95 crossed 300 ms at: ${verdict.crosses300At === null ? 'not reached' : `${verdict.crosses300At} TPS`} · 500 ms at: ${verdict.crosses500At === null ? 'not reached' : `${verdict.crosses500At} TPS`}`);
  if (verdict.ordersOffered !== undefined) notes.push(`Orders/s offered: ${verdict.ordersOffered} · orders placed: ${fmtInt(verdict.ordersPlaced)} · dropped: ${fmtInt(verdict.dropped)}`);
  if (verdict.prepFailed) notes.push(`Prep failures (setup steps, not measured): ${fmtInt(verdict.prepFailed)}`);
  const cold = vals(data.metrics, 'http_req_duration{stage:coldstart}');
  if (cold && cold.count) notes.push(`Cold start (first 30 s at peak, included in the gate; Vercel functions scaling out): p95 ${r0(cold['p(95)'])} ms · max ${r0(cold.max)} ms · n=${fmtInt(cold.count)}`);

  const settingsRows = Object.keys(meta.settings).sort().map((k) => `<tr><td class="l"><code>${esc(k)}</code></td><td class="l">${esc(meta.settings[k])}</td></tr>`).join('');
  const checkRows = checks.map((c) => {
    const n = c.passes + c.fails;
    return `<tr><td class="l">${esc(c.name)}</td><td>${fmtInt(c.passes)}</td><td>${fmtInt(c.fails)}</td><td>${n ? r2((c.passes / n) * 100) : '–'} %</td><td class="l"><span class="chip ${c.fails ? 'fail' : 'pass'}">${c.fails ? 'FAIL' : 'PASS'}</span></td></tr>`;
  }).join('\n');
  const tile = (k, v, cls) => `<div class="tile ${cls || ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  // headline p95 / errors: the all-requests row, or the worst row when there isn't one (TS-01)
  const allRow = ran.filter((x) => x.id === 'ALL requests')[0];
  const worst = (f) => ran.slice().sort((a, b) => f(b) - f(a))[0];
  const p95Row = allRow || worst((x) => x.v['p(95)'] || 0);
  const errRow = allRow || worst((x) => x.errRate || 0);
  const which = allRow ? 'all' : 'worst row';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pmc-line perf · ${esc(meta.scenarioLabel)} · ${esc(meta.runId)}</title><style>${CSS}</style></head>
<body><main>
<h1>pmc-line performance test · ${esc(meta.scenarioLabel)}</h1>
<div class="meta">run <code>${esc(meta.runId)}</code> · round ${esc(meta.round)} · ${esc(meta.date)} · target <b>${esc(targetLabel(meta.target))}</b> <code>${esc(meta.base)}</code> · measured window: ${esc(verdict.window || '')}</div>

<div class="banner ${overallFail ? 'fail' : 'pass'}"><span class="big">${overallFail ? 'FAIL' : 'PASS'}</span>
<span class="why">${reasons.length ? esc(reasons.join(' · ')) : 'every row within the gate (p95 ≤ ' + GATE.p95 + ' ms, errors incl. > ' + GATE.slowMs / 1000 + ' s < ' + GATE.errRate * 100 + ' %)'}</span></div>

<div class="tiles">
${tile('duration (k6)', `${r0(data.state.testRunDurationMs / 1000)} s`)}
${tile('requests measured', fmtInt(verdict.requests))}
${tile('TPS (window avg)', r1(verdict.rps))}
${tile(`p95 (${which})`, p95Row ? `${r0(p95Row.v['p(95)'])} ms` : '–', p95Row ? (p95Row.v['p(95)'] <= GATE.p95 ? 'good' : 'bad') : '')}
${tile(`error rate (${which})`, errRow ? `${r2(errRow.errRate * 100)} %` : '–', errRow ? (errRow.errRate < GATE.errRate ? 'good' : 'bad') : '')}
${tile('rows within gate', `${ran.length - failedRows.length} / ${ran.length}`, failedRows.length ? 'bad' : 'good')}
${tile('checks passed', checksV ? `${r2(checksV.rate * 100)} %` : '–', checksV && checksV.rate < 1 ? 'bad' : '')}
${tile('dropped iterations', fmtInt(droppedN), droppedN > 0 ? 'bad' : '')}
</div>

<h2 class="hrow">Results <span class="tools"><button type="button" id="openAll">expand all</button><button type="button" id="closeAll">collapse all</button></span></h2>
<div class="meta" style="margin:-4px 0 8px">Click a row for details. Times in ms. PASS/FAIL per row = p95 ≤ ${GATE.p95} ms and errors &lt; ${GATE.errRate * 100} % (a response slower than ${GATE.slowMs / 1000} s counts as an error); p99 / max / checks are reported only.</div>
<div class="card"><table>
<thead><tr><th class="l">row</th><th class="l">window</th><th>offered TPS</th><th>TPS</th><th>n</th><th>avg</th><th>p90</th><th>p95</th><th>p99</th><th>max</th><th>err %</th><th class="l">gate</th></tr></thead>
<tbody>${tableRows}</tbody></table></div>

${ran.length ? `<h2>p95 against the gate</h2><div class="card p95">${bars}</div><div class="meta" style="margin-top:6px">vertical line = ${GATE.p95} ms gate · red bar = over the gate</div>` : ''}
${steps}
${notes.length ? `<h2>Notes</h2><div class="card"><pre>${esc(notes.join('\n'))}</pre></div>` : ''}
${checks.length ? `<h2>Checks (reported)</h2><div class="card"><table><thead><tr><th class="l">check</th><th>passed</th><th>failed</th><th>% passed</th><th class="l"></th></tr></thead><tbody>${checkRows}</tbody></table></div>` : ''}
${crossed.length ? `<h2>Thresholds crossed</h2><div class="card"><pre>${esc(crossed.join('\n'))}</pre></div>` : ''}
<h2>Settings of this run</h2><div class="card"><table><tbody>${settingsRows}</tbody></table></div>
<div class="meta" style="margin-top:6px">PERF_* variables as k6 saw them; passwords and secrets are hidden.</div>

<div class="foot">Generated by k6 handleSummary (lib/report.js) · files of this run: ${esc(meta.prefix)}report.html, ${esc(meta.prefix)}results.csv, ${esc(meta.prefix)}summary.json, ${esc(meta.prefix)}verdict.json</div>
</main>
<script>
(function(){
  if (location.hash === '#light' || location.hash === '#dark') document.documentElement.setAttribute('data-theme', location.hash.slice(1)); // screenshots use #light
  var rows=[].slice.call(document.querySelectorAll('tr.row'));
  function set(tr,open){var d=document.getElementById(tr.getAttribute('data-d'));d.hidden=!open;tr.setAttribute('aria-expanded',open);}
  rows.forEach(function(tr){
    tr.addEventListener('click',function(){set(tr,tr.getAttribute('aria-expanded')!=='true');});
    tr.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();tr.click();}});
  });
  document.getElementById('openAll').onclick=function(){rows.forEach(function(tr){set(tr,true);});};
  document.getElementById('closeAll').onclick=function(){rows.forEach(function(tr){set(tr,false);});};
})();
</script>
</body></html>
`;
};

// k6 nests checks in groups; flatten them.
const collectChecks = (g) => {
  let out = (g.checks || []).map((c) => ({ name: c.name, passes: c.passes, fails: c.fails }));
  (g.groups || []).forEach((sub) => { out = out.concat(collectChecks(sub)); });
  return out;
};

// ---- entry --------------------------------------------------------------------------------

const SECRET = /(PASS|PASSWORD|TOKEN|SECRET|COOKIE)/;

// meta: { runId, round, date, target, base, scenario, prefix, windowSec, stepSeconds? }
export const buildReport = (data, verdict, meta) => {
  const m = data.metrics;
  const ctx = { steps: verdict.steps, windowSec: meta.windowSec, stepSeconds: meta.stepSeconds, targetRps: verdict.targetRps, opens: verdict.ordersOffered };
  const rows = selectors(m).map((sel) => rowOf(m, sel, ctx));
  const settings = {};
  Object.keys(__ENV).filter((k) => k.indexOf('PERF_') === 0).forEach((k) => {
    settings[k] = SECRET.test(k) ? '(hidden)' : __ENV[k];
  });
  const full = Object.assign({ scenarioLabel: scenarioLabel(meta.scenario), settings, warnings: runWarnings(data, verdict), endpoint: verdict.endpoint }, meta);
  return { html: buildHtml(rows, full, verdict, data), csv: buildCsv(rows, full) };
};
