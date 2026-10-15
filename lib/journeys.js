// The journeys the load scenarios walk (docs/api-spec-loadtest.md "List Load Test" — the five
// priority lines: POST /api/orders 10 TPS, GET /api/products 50 TPS, GET /api/admin/orders 50 TPS,
// GET /api/admin/dashboard-stats 50 TPS, GET /api/admin/products 10 TPS).
//
//   storefrontJourney   TS-02 — a LINE OA customer: catalog → (maybe) discount code → order with slip
//   adminOrdersJourney  TS-03 — the admin order desk: list → filter → next page → slip → note / status
//   dashboardJourney    TS-04 — the admin dashboard: stats + partners together, sometimes a date range
//   mixRequest          soak / stress / spike — ONE request per iteration, drawn from the priority
//                       lines by weight (PERF_MIX), so iterations/s = TPS exactly
import http from 'k6/http';
import { check } from 'k6';
import { api, cfg } from './config.js';
import { daysAgo, STATUS } from './data.js';
import { cartFor, partnerAt } from './catalog.js';
import { placeOrder } from './endpoints.js';
import { cookieHeader, expectStatus, get, patchJson, postJson, safeJson, track } from './http.js';
import { recordError } from './errors.js';

const enc = encodeURIComponent;
const BINARY = { responseType: 'none' };
const scopeQ = (ctx, first = true) => (ctx.partnerScope ? `${first ? '?' : '&'}partner=${enc(ctx.partnerScope)}` : '');

// ---- TS-02 storefront ------------------------------------------------------------------
// ctx: { catalog, k (iteration), pValidate (0–1), referral (code) }
export const storefrontJourney = (ctx) => {
  const partner = partnerAt(ctx.catalog, ctx.k);
  const list = get(`${api('/api/products')}?partner=${enc(partner)}`, 'shop.products');
  if (!expectStatus(list, 200, 'shop.products')) return false;
  let referral = '';
  if (Math.random() < (ctx.pValidate === undefined ? 0.3 : ctx.pValidate)) {
    const v = postJson(api('/api/discount/validate'), { code: ctx.referral || cfg.referralCode, codeType: 'referral', partner }, 'shop.validate');
    if (expectStatus(v, 200, 'shop.validate') && (safeJson(v) || {}).valid) referral = ctx.referral || cfg.referralCode;
  }
  return !!placeOrder(ctx.catalog, partner, 'shop.order', { referralCode: referral, rnd: Math.random });
};
export const SHOP_REQ_PER_ITER = 2.3; // products + 0.3 × validate + order

// ---- TS-03 admin orders ----------------------------------------------------------------
// ctx: { session, pool, k, partnerScope?, pSlip (0.5), pNote (0.3), pStatus (0.2) }
export const adminOrdersJourney = (ctx) => {
  const base = api('/api/admin/orders');
  const list = get(`${base}?limit=10${scopeQ(ctx, false)}`, 'ops.list', ctx.session);
  if (!expectStatus(list, 200, 'ops.list')) return false;
  const page = safeJson(list) || {};
  expectStatus(get(`${base}?limit=10&status=${enc(STATUS.pending)}&from=${daysAgo(7)}&to=${daysAgo(0)}${scopeQ(ctx, false)}`, 'ops.filter', ctx.session), 200, 'ops.filter');
  if (page.nextCursor) expectStatus(get(`${base}?limit=10&cursor=${enc(page.nextCursor)}${scopeQ(ctx, false)}`, 'ops.page', ctx.session), 200, 'ops.page');
  // the order acted on: one from the page just read (what the admin sees), else the setup pool
  const row = (page.orders || [])[ctx.k % Math.max(1, (page.orders || []).length)];
  const pooled = ctx.pool && ctx.pool.length ? ctx.pool[ctx.k % ctx.pool.length] : undefined;
  const id = (row && (row.orderId || row.id)) || (pooled && pooled.id);
  if (!id) return true; // nothing to act on (empty scope): the reads still count
  const slip = (row && slipOf(row)) || (pooled && pooled.slip) || cfg.slipFileId;
  if (Math.random() < num(ctx.pSlip, 0.5)) expectStatus(get(api(`/api/admin/slip/${enc(slip)}`), 'ops.slip', ctx.session, BINARY), 200, 'ops.slip');
  if (Math.random() < num(ctx.pNote, 0.3)) expectStatus(patchJson(api(`/api/admin/orders/${enc(id)}/note`), { adminNote: `perf ${cfg.runId} #${ctx.k}` }, 'ops.note', ctx.session), 200, 'ops.note');
  if (Math.random() < num(ctx.pStatus, 0.2)) {
    // alternate pending ↔ confirmed, so a run leaves the status mix roughly where it found it
    const status = ctx.k % 2 ? STATUS.pending : STATUS.confirmed;
    expectStatus(patchJson(api(`/api/admin/orders/${enc(id)}/status`), { status, trackingNumber: '' }, 'ops.status', ctx.session), 200, 'ops.status');
  }
  return true;
};
export const OPS_REQ_PER_ITER = 4; // list + filter + page + 0.5 slip + 0.3 note + 0.2 status
const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
const slipOf = (o) => String(o.slipFileId || o.slipId || o.slipFile || (typeof o.slip === 'string' ? o.slip : '') || o.slipUrl || o.slipPath || '').split('/').pop().split('?')[0];

// ---- TS-04 admin dashboard -------------------------------------------------------------
// The dashboard page loads the stats and the partner dropdown together (http.batch); with
// probability pRange the admin also picks a date range (a fresh cache key → Firestore aggregation).
export const dashboardJourney = (ctx) => {
  const reqs = [
    ['dash.stats', `${api('/api/admin/dashboard-stats')}${scopeQ(ctx)}`],
    ['dash.partners', api('/api/admin/partners')],
  ];
  const res = http.batch(reqs.map(([tag, url]) => ({ method: 'GET', url, params: { headers: cookieHeader(ctx.session), tags: { name: tag } } })));
  let ok = true;
  reqs.forEach(([tag], i) => {
    track(res[i], tag);
    const good = check(res[i], { [`${tag} 200`]: (r) => r.status === 200 });
    if (!good) { ok = false; if (cfg.debug) console.warn(`[FAIL] ${tag} expected 200: status=${res[i].status} body=${String(res[i].body).slice(0, 300)}`); recordError(tag, res[i]); }
  });
  if (Math.random() < num(ctx.pRange, 0.3)) {
    const q = `from=${daysAgo(1 + (ctx.k % 30))}&to=${daysAgo(0)}`;
    expectStatus(get(`${api('/api/admin/dashboard-stats')}?${q}${scopeQ(ctx, false)}`, 'dash.range', ctx.session), 200, 'dash.range');
  }
  return ok;
};
export const DASH_REQ_PER_ITER = 2.3; // stats + partners + 0.3 × range

// ---- the priority mix (soak / stress / spike) --------------------------------------------
// PERF_MIX="order:10,products:50,orders:50,dashboard:50,catalog:10" — weights = the docs' TPS
// per line, so at 170 TPS the mix reproduces the table exactly. One request per iteration.
export const parseMix = (s) => {
  const w = { order: 10, products: 50, orders: 50, dashboard: 50, catalog: 10 };
  String(s || '').split(',').forEach((x) => { const a = x.split(':'); if (a.length === 2 && w[a[0].trim()] !== undefined && +a[1] >= 0) w[a[0].trim()] = +a[1]; });
  return w;
};
export const MIX_TOTAL = (w) => Object.keys(w).reduce((a, k) => a + w[k], 0);
export const mixRequest = (ctx) => {
  const w = ctx.mix, total = MIX_TOTAL(w);
  let r = Math.random() * total, pick = 'products';
  for (const k of Object.keys(w)) { r -= w[k]; if (r < 0) { pick = k; break; } }
  switch (pick) {
    case 'order': return !!placeOrder(ctx.catalog, partnerAt(ctx.catalog, ctx.k), 'mix.order');
    case 'orders': return expectStatus(get(`${api('/api/admin/orders')}?limit=10${scopeQ(ctx, false)}`, 'mix.orders', ctx.session), 200, 'mix.orders');
    case 'dashboard': return expectStatus(get(`${api('/api/admin/dashboard-stats')}${scopeQ(ctx)}`, 'mix.dashboard', ctx.session), 200, 'mix.dashboard');
    case 'catalog': return expectStatus(get(`${api('/api/admin/products')}?partner=${enc(ctx.partnerMain)}`, 'mix.catalog', ctx.session), 200, 'mix.catalog');
    default: return expectStatus(get(`${api('/api/products')}?partner=${enc(partnerAt(ctx.catalog, ctx.k))}`, 'mix.products'), 200, 'mix.products');
  }
};
// Kept for scripts that want a cart without placing an order (smoke's budget line).
export const sampleCart = cartFor;
