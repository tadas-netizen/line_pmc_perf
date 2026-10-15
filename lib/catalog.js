// Live test data, found in setup() so no seed FILE is needed (the app's own reads are the source):
//   catalog   — GET /api/products: active, in-stock products per partner (docs §3.1.3: 30 s cache)
//   orderPool — GET /api/admin/orders?limit=100 (+cursor): order ids the admin writes act on
// Everything is returned as setup data, so every VU sees the same lists.
import { api, cfg } from './config.js';
import { expectShape, expectStatus, get, safeJson } from './http.js';

// { partners: ['P01', …], products: { P01: [{ id, name, price }, …] } } — only partners with at
// least one orderable product; restricted to PERF_PARTNERS when set.
export const loadCatalog = (tag = 'prep.catalog') => {
  const res = get(api('/api/products'), tag);
  const body = safeJson(res) || {};
  const list = Array.isArray(body.products) ? body.products : [];
  if (!expectStatus(res, 200, tag)) throw new Error(`GET /api/products failed (${res.status}) — is the app up at ${cfg.base}?`);
  const products = {};
  list.forEach((p) => {
    if (!p || !p.id || !p.partnerCode || p.active === false || p.outOfStock) return;
    if (cfg.partners.length && cfg.partners.indexOf(p.partnerCode) < 0) return;
    (products[p.partnerCode] = products[p.partnerCode] || []).push({ id: p.id, name: p.name, price: Number(p.price) || 0 });
  });
  const partners = Object.keys(products).sort();
  expectShape(res, tag, 'has an orderable product', () => partners.length > 0);
  if (!partners.length) {
    throw new Error(`GET /api/products returned no active, in-stock product${cfg.partners.length ? ` for PERF_PARTNERS=${cfg.partners.join(',')}` : ''} — seed the catalog first (pnpm seed:perf)`);
  }
  console.log(`[catalog] ${list.length} products · ${partners.length} partner(s) orderable: ${partners.slice(0, 8).join(', ')}${partners.length > 8 ? ', …' : ''}`);
  return { partners, products };
};

// The single partner code used where one is needed (PERF_PARTNER, else the first orderable).
export const mainPartner = (catalog) => cfg.partner || (catalog && catalog.partners[0]) || '';

// Partner for iteration k: round-robin over the orderable partners (spreads the per-partner
// order counter hotspot, docs §3.1.1).
export const partnerAt = (catalog, k) => catalog.partners[Math.abs(k) % catalog.partners.length];

// 1–3 cart lines from one partner's products, qty 1–3 each (MAX_CART_LINES 100, MAX_ITEM_QTY 999).
export const cartFor = (catalog, partner, rnd = Math.random) => {
  const list = catalog.products[partner] || [];
  const n = Math.min(list.length, 1 + Math.floor(rnd() * 3));
  const picked = [];
  const start = Math.floor(rnd() * list.length);
  for (let i = 0; i < n; i++) picked.push(list[(start + i) % list.length]);
  return picked.map((p) => ({ id: p.id, qty: 1 + Math.floor(rnd() * 3), price: p.price }));
};

// The slip file id an order row carries, if the API exposes one (the field name is not in the spec:
// several spellings are tried); else '' — callers fall back to PERF_SLIP_FILE_ID.
export const slipIdOf = (o) => {
  if (!o) return '';
  const v = o.slipFileId || o.slipId || o.slipFile || (typeof o.slip === 'string' ? o.slip : '') || o.slipUrl || o.slipPath || '';
  return String(v).split('/').pop().split('?')[0];
};

// Order ids (+ slip ids) from the admin list: `want` rows, paged by cursor (limit ≤ 100). Scoped to
// `partner` when given (a PARTNER_ADMIN session sees only its own partners anyway).
export const orderPool = (session, want, partner = '', tag = 'prep.orders') => {
  const out = [];
  let cursor = '';
  for (let page = 0; out.length < want && page < 50; page++) {
    const q = [`limit=${Math.min(100, want - out.length)}`];
    if (partner) q.push(`partner=${encodeURIComponent(partner)}`);
    if (cursor) q.push(`cursor=${encodeURIComponent(cursor)}`);
    const res = get(`${api('/api/admin/orders')}?${q.join('&')}`, tag, session);
    if (!expectStatus(res, 200, tag)) break;
    const body = safeJson(res) || {};
    (body.orders || []).forEach((o) => { if (o && (o.orderId || o.id)) out.push({ id: o.orderId || o.id, slip: slipIdOf(o), status: o.status || '' }); });
    cursor = body.nextCursor || '';
    if (!cursor || !(body.orders || []).length) break;
  }
  console.log(`[orders] pool: ${out.length} order(s)${partner ? ` of ${partner}` : ''}${out.length < want ? ` (wanted ${want})` : ''}`);
  return out;
};

// Pool entry for iteration k across all VUs / tasks (interleaved per task so two never share one).
export const poolAt = (pool, k) => (pool.length ? pool[(k * cfg.taskCount + cfg.taskIndex) % pool.length] : undefined);
