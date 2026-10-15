// AUTH — POST /api/admin/login on its own: bcrypt cost 12 (~100 ms of CPU per call, docs §3.2):
// the one endpoint that must NOT be driven as a throughput target. Default 2 logins/s, standard
// shape, the whole run measured. Use it to see what a login costs the serverless side, not to find
// a ceiling — a ceiling here is just CPU on the function.
import exec from 'k6/execution';
import { accountOf, login } from '../lib/auth.js';
import { cfg } from '../lib/config.js';
import { standardPlan, tagWindow } from '../lib/phases.js';
import { makeHandleSummary } from '../lib/summary.js';
import { AUTH_TAGS, summaryTrendStats, thresholdsFor } from '../lib/thresholds.js';

const RATE = Number(__ENV.PERF_LOGINS_PER_SEC || 2);
const PLAN = standardPlan(RATE);
// alternate the configured accounts (super / partner / viewer) so no single user is hammered
const ACCOUNTS = ['super', 'partner', 'viewer'].map(accountOf).filter((a) => a.username && a.password);
if (!ACCOUNTS.length) throw new Error('no account configured (PERF_ADMIN_USER / _PASS …)');

export const options = {
  scenarios: {
    auth: { executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', stages: PLAN.stages, preAllocatedVUs: Math.max(5, RATE * 3), maxVUs: Math.max(10, RATE * 6) },
  },
  thresholds: thresholdsFor(AUTH_TAGS),
  summaryTrendStats,
};

export function setup() {
  console.log(`[auth] ${RATE} logins/s over ${ACCOUNTS.length} account(s) · ${cfg.base}`);
  if (RATE > 5) console.warn('[auth] more than 5 logins/s: each login is a bcrypt hash — this measures CPU, expect the serverless function to saturate');
}

export default function () {
  tagWindow(PLAN.phases);
  const a = ACCOUNTS[exec.scenario.iterationInTest % ACCOUNTS.length];
  login(a.username, a.password, 'auth.login');
}

export const handleSummary = makeHandleSummary('auth', (data, verdict) => { verdict.targetRps = RATE; });
