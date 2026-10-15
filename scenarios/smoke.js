// SMOKE — does the test script itself work against this environment? 1 VU, one pass through every
// section, strict checks, latency reported but not gated. Run it after any script/data/env change
// and before every load round; a load round on a broken script only measures the breakage.
//
//   PERF_DEBUG=1 k6 run scenarios/smoke.js                          # read-only (default)
//   PERF_SMOKE_SECTIONS=all PERF_DEBUG=1 k6 run scenarios/smoke.js  # + the writes
//
// Sections (PERF_SMOKE_SECTIONS, comma-separated, or `all`):
//   public  GET /api/products, POST /api/discount/validate (both answers), GET /api/product-image
//           (only with PERF_IMAGE_FILE_ID)                                          (no data left)
//   auth    login as every configured role (super / partner / viewer), logout      (no data left)
//   neg     no cookie → 401 · viewer write → 403 · partner admin out of scope → 403 ·
//           an inactive account → 401 (PERF_INACTIVE_USER / _PASS)                 (no data left)
//   ts01    every TS-01 READ endpoint once, through TS-01's own code (lib/endpoints.js)
//   order   ONE real order through POST /api/orders (creates an order + a slip in GCS)
//   writes  every TS-01 WRITE endpoint once (creates perf products / codes / a partner / a user /
//           images; the per-VU fixtures stay, inactive — see README "What a run leaves behind")
import { group } from 'k6';
import { api, cfg } from '../lib/config.js';
import { accountOf, login, roleConfigured, sessions } from '../lib/auth.js';
import { loadCatalog, mainPartner, orderPool } from '../lib/catalog.js';
import { slipInfo } from '../lib/data.js';
import { ENDPOINTS, GROUPS } from '../lib/endpoints.js';
import { expectShape, expectStatus, expectStatuses, get, patchJson, postEmpty, postJson, safeJson } from '../lib/http.js';
import { makeHandleSummary } from '../lib/summary.js';
import { AUTH_TAGS, NEG_TAGS, summaryTrendStats } from '../lib/thresholds.js';

const ALL = ['public', 'auth', 'neg', 'ts01', 'order', 'writes'];
const raw = __ENV.PERF_SMOKE_SECTIONS || 'public,auth,neg,ts01';
const SECTIONS = raw === 'all' ? ALL : raw.split(',').map((s) => s.trim()).filter(Boolean);
SECTIONS.forEach((s) => { if (ALL.indexOf(s) < 0) throw new Error(`unknown smoke section "${s}" — one of ${ALL.join(', ')} or all`); });
const on = (s) => SECTIONS.indexOf(s) >= 0;

// Latency sub-metrics are declared only so the summary reports them per tag (no gate).
const thresholds = { checks: ['rate==1'], http_req_failed: ['rate==0'] };
[].concat(AUTH_TAGS, NEG_TAGS, Object.keys(ENDPOINTS)).forEach((t) => { thresholds[`http_req_duration{name:${t}}`] = ['max>=0']; });

export const options = {
  scenarios: { smoke: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '3m' } },
  thresholds,
  summaryTrendStats,
};

export function setup() {
  const slip = slipInfo();
  console.log(`[smoke] sections=${SECTIONS.join(',')} · base=${cfg.base} · slip ${slip.name} (${slip.bytes} bytes, ${slip.mime})`);
  if (on('order') || on('writes')) console.warn('[smoke] write sections enabled — this creates data (an order, perf products / codes / a partner / a user)');
  const catalog = loadCatalog();
  // every configured role, once; missing ones are skipped (their sections say so)
  const s = sessions(['super', 'partner', 'viewer'], false);
  const adminSession = s.super || s.partner;
  const pool = adminSession ? orderPool(adminSession, 20) : [];
  return { sessions: s, catalog, pool };
}

// 401 / 403 are the expected answers here, so they must not count as failed requests.
const expect401 = expectStatuses([401]);
const expect403 = expectStatuses([403]);

export default function (data) {
  const S = data.sessions || {};
  const catalog = data.catalog;
  const partner = mainPartner(catalog);
  const ctx = (role) => ({ data, session: S[role], vu: 1, iter: 0, partner });

  if (on('public')) {
    group('public', () => {
      ENDPOINTS['products.list'].run(ctx(), 'products.list');
      ENDPOINTS['discount.validate'].run(ctx(), 'discount.validate');
      // the promotion door too: both answers are HTTP 200 with the validator's own shape
      const v = postJson(api('/api/discount/validate'), { code: cfg.promotionCode, codeType: 'promotion', partner }, 'discount.validate');
      expectStatus(v, 200, 'discount.validate');
      expectShape(v, 'discount.validate', 'promotion answer has valid + (error|discountType)', () => { const j = safeJson(v) || {}; return typeof j.valid === 'boolean' && (j.valid ? !!j.discountType : typeof j.error === 'string'); });
      if (cfg.imageFileId) ENDPOINTS['products.image'].run(ctx(), 'products.image');
      else console.warn('[smoke] products.image skipped: PERF_IMAGE_FILE_ID not set');
    });
  }

  if (on('auth')) {
    group('auth', () => {
      ['super', 'partner', 'viewer'].forEach((role) => {
        if (!roleConfigured(role)) { console.warn(`[smoke] auth: ${role} account not configured (PERF_*_USER / _PASS) — skipped`); return; }
        const a = accountOf(role);
        expectShape({ status: 0 }, 'auth.login', `${role} (${a.username}) signed in`, () => !!login(a.username, a.password, 'auth.login'));
      });
      expectStatus(postEmpty(api('/api/admin/logout'), 'auth.logout'), 200, 'auth.logout');
    });
  }

  if (on('neg')) {
    group('neg', () => {
      const orders = `${api('/api/admin/orders')}?limit=1`;
      expectStatus(get(orders, 'neg.noCookie', undefined, expect401), 401, 'neg.noCookie');
      expectStatus(get(orders, 'neg.noCookie', 'not-a-session', expect401), 401, 'neg.noCookie');
      const o = (data.pool || [])[0];
      if (S.viewer && o) expectStatus(patchJson(api(`/api/admin/orders/${encodeURIComponent(o.id)}/note`), { adminNote: 'perf viewer' }, 'neg.viewerWrite', S.viewer, expect403), 403, 'neg.viewerWrite');
      else console.warn(`[smoke] neg.viewerWrite skipped: ${S.viewer ? 'no order in the pool' : 'viewer account not configured'}`);
      // a scoped admin asking for a partner outside its binding → 403: a code it is not bound to, read
      // from GET /api/admin/users (super) when possible, else PERF_SCOPE_OTHER, else a made-up code
      if (S.partner) {
        let bound = [];
        if (S.super) {
          const users = safeJson(get(api('/api/admin/users'), 'prep.users', S.super)) || {};
          const me = (users.users || []).find((u) => u.username === accountOf('partner').username);
          bound = Object.keys((me && me.partnerRoles) || {});
        }
        const other = __ENV.PERF_SCOPE_OTHER || (catalog.partners || []).filter((p) => bound.indexOf(p) < 0)[0] || 'ZZZ-NOT-MINE';
        expectStatus(get(`${api('/api/admin/orders')}?limit=1&partner=${encodeURIComponent(other)}`, 'neg.scope', S.partner, expect403), 403, 'neg.scope');
      } else console.warn('[smoke] neg.scope skipped: partner admin account not configured');
      if (__ENV.PERF_INACTIVE_USER && __ENV.PERF_INACTIVE_PASS) {
        const r = postJson(api('/api/admin/login'), { username: __ENV.PERF_INACTIVE_USER, password: __ENV.PERF_INACTIVE_PASS }, 'neg.inactive', undefined, expect401);
        expectStatus(r, 401, 'neg.inactive');
      }
    });
  }

  if (on('ts01')) {
    group('ts01', () => {
      GROUPS.reads.forEach((id) => {
        const ep = ENDPOINTS[id];
        if (id === 'products.image' && !cfg.imageFileId) return; // said above
        if (ep.who !== 'none' && !S[ep.who === 'super' ? 'super' : (cfg.adminRole === 'partner' ? 'partner' : 'super')]) {
          console.warn(`[smoke] skipping ${id}: ${ep.who} session not available`);
          return;
        }
        ep.run(ctx(ep.who === 'super' ? 'super' : cfg.adminRole === 'partner' ? 'partner' : 'super'), id);
      });
    });
  }

  if (on('order')) {
    group('order', () => {
      const ok = ENDPOINTS['orders.create'].run(ctx(), 'orders.create');
      expectShape({ status: ok ? 200 : 0 }, 'smoke.order', 'order placed', () => ok === true);
    });
  }

  if (on('writes')) {
    group('writes', () => {
      GROUPS.writes.filter((id) => id !== 'orders.create').forEach((id) => {
        const ep = ENDPOINTS[id];
        const role = ep.who === 'super' ? 'super' : cfg.adminRole === 'partner' ? 'partner' : 'super';
        if (!S[role]) { console.warn(`[smoke] skipping ${id}: ${role} session not available`); return; }
        ep.run(ctx(role), id);
      });
    });
  }
}

export const handleSummary = makeHandleSummary('smoke');
