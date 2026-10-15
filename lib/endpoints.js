// TS-01 endpoint catalogue: one entry per operation of docs/api-spec-loadtest.md that can be tested
// on its own (30 operations → 36 entries: the heavy read modes of GET /api/admin/orders and the
// cache-busting dashboard range are separate entries).
//
//   kind  read  — repeatable, consumes nothing (includes POST /api/discount/validate and logout)
//         auth  — POST /api/admin/login (bcrypt cost 12: CPU-bound, never a throughput target)
//         write — creates or changes data on every request (see `db`)
//   who   none | admin | super — whose cookie the call carries: none = public; admin = the role
//         PERF_ADMIN_ROLE picks (super by default, or partner = a scoped PARTNER_ADMIN); super =
//         SUPER_ADMIN only (users, partners, QR upload)
//   api   the measured request: method + path, shown by tools/runner.py
//   db    what one call leaves behind: none (plain read / cached read) · cache (fills an in-memory
//         cache, no document) · write (creates or changes a Firestore document and/or a GCS file)
//   rate  the default TPS of a TS-01 run (docs "List Load Test": orders 10, products 50, admin
//         orders 50, dashboard 50, admin products 10; other reads 20; heavy unbounded reads 1;
//         writes 5; bcrypt-bound calls 2)
//   heavy true for the unbounded modes (every order read into memory) — a separate scenario, never
//         in a mix
//   run(ctx, tag) — one iteration. `tag` is the endpoint id; everything else this iteration fires
//                   is tagged `prep.<step>` so it never counts in the endpoint's numbers.
//                   ctx: { data (setup: sessions, catalog, pool), session, vu, iter, partner }
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { api, cfg } from './config.js';
import { accountOf, adminRole, login } from './auth.js';
import { daysAgo, imageFile, randomPhone, slipFile, STATUS, uid } from './data.js';
import { cartFor, mainPartner, partnerAt, poolAt } from './catalog.js';
import { del, expectShape, expectStatus, get, patchJson, postEmpty, postJson, postMultipart, putJson, safeJson } from './http.js';

const prepFailed = new Counter('prep_failed');
const prep = (step) => `prep.${step}`;
const enc = encodeURIComponent;
const code20 = (s) => String(s).replace(/[^A-Z0-9_-]/g, '').slice(-20); // partner / promotion code charset, ≤ 20
const BINARY = { responseType: 'none' }; // slips / images: status only, keep the bytes out of memory

// ---- storefront order ---------------------------------------------------------------------
// POST /api/orders (multipart: `payload` JSON + `slip` file, docs §3.1.1). Prices and totals are
// recomputed server-side from the catalog; the body's totals only have to be numbers ≥ 0.
// Returns the orderId, or undefined.
export const placeOrder = (catalog, partner, tag, opts = {}) => {
  const items = cartFor(catalog, partner, opts.rnd);
  const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
  const payload = {
    items: items.map((i) => ({ id: i.id, qty: i.qty })),
    name: 'ลูกค้า Perf', phone: randomPhone(), address: '99 ถนนทดสอบ', subdistrict: 'ทดสอบ', district: 'เมืองทดสอบ',
    province: 'กรุงเทพมหานคร', postalCode: '10000', pdpaConsent: true,
    referralCode: opts.referralCode || '', promotionCode: opts.promotionCode || '', note: opts.note || '',
    newsConsent: false, liffUserId: '', subtotal, discount: 0, shipping: 0, total: subtotal,
  };
  const res = postMultipart(api('/api/orders'), { payload: JSON.stringify(payload), slip: slipFile() }, tag);
  if (!expectStatus(res, 200, tag)) return undefined;
  const body = safeJson(res) || {};
  if (!expectShape(res, tag, 'returns orderId', () => body.success === true && typeof body.orderId === 'string')) return undefined;
  return body.orderId;
};

// ---- per-VU fixtures the write endpoints act on (created once per VU as prep.*) ------------
const vuState = {}; // per VU (module scope is per VU in k6)
// the per-VU fixture's id: distinct from the per-iteration ids (`uid(vu, iter)`), so a fixture never
// collides with what the create endpoints make in the same run
const fixtureId = (vu) => `${uid(vu, 0)}F`;
const once = (key, make) => {
  if (vuState[key] === undefined) vuState[key] = make() || null;
  return vuState[key];
};

const partnerOf = (ctx) => ctx.partner || mainPartner(ctx.data && ctx.data.catalog) || 'P01';
const orderFor = (ctx, tag) => {
  const pool = (ctx.data && ctx.data.pool) || [];
  const o = poolAt(pool, exec.scenario.iterationInTest);
  expectShape({ status: 0 }, tag, 'has an order to act on', () => !!o);
  return o;
};
const okOrNote = (ok, tag) => { if (!ok) prepFailed.add(1, { endpoint: tag }); return ok; };

const productBody = (id, partner) => ({ id, partnerCode: partner, partnerName: `พาร์ทเนอร์ ${partner}`, name: `น้ำทดสอบ perf ${id}`, price: 59.5, unit: 'ต่อแพ็ค', active: false, sortOrder: 9999 });
const createProduct = (ctx, id, tag) => {
  const res = postJson(api('/api/admin/products'), productBody(id, partnerOf(ctx)), tag, ctx.session);
  return expectStatus(res, 201, tag) ? id : undefined;
};
const deleteProduct = (ctx, id, tag) => expectStatus(del(api(`/api/admin/products/${enc(id)}`), tag, ctx.session), 200, tag);
// `active: false` on everything a run creates, so perf fixtures never reach the storefront.
const vuProduct = (ctx) => once('product', () => createProduct(ctx, `PERF-${fixtureId(ctx.vu)}`, prep('admin.products.create')));

const createPartner = (ctx, code, tag) => {
  const res = postJson(api('/api/admin/partners'), { partnerCode: code, name: `Perf partner ${code}`, qrImageUrl: null }, tag, ctx.session);
  if (!expectStatus(res, 201, tag)) return undefined;
  const body = safeJson(res) || {};
  return body.id || code;
};
const vuPartner = (ctx) => once('partner', () => createPartner(ctx, code20(`PF${fixtureId(ctx.vu)}`), prep('admin.partners.create')));

const createUser = (ctx, username, tag) => {
  const res = postJson(api('/api/admin/users'), {
    username, name: `Perf user ${username}`, password: 'perf-pass-123', role: 'PARTNER_VIEWER', partnerRoles: { [partnerOf(ctx)]: 'PARTNER_VIEWER' },
  }, tag, ctx.session);
  if (!expectStatus(res, 201, tag)) return undefined;
  const body = safeJson(res) || {};
  return body.id;
};
const vuUser = (ctx) => once('user', () => createUser(ctx, `perf.${fixtureId(ctx.vu).toLowerCase()}`, prep('admin.users.create')));

const createPromotion = (ctx, code, tag) => {
  const res = postJson(api('/api/admin/discount-codes'), {
    codeType: 'promotion', code, discountType: 'AMOUNT', discountValue: 5, validFrom: daysAgo(0), validTo: '', isActive: false,
    conditions: 'perf', partnerCodes: [partnerOf(ctx)],
  }, tag, ctx.session);
  if (!expectStatus(res, 201, tag)) return undefined;
  return code;
};
const vuPromotion = (ctx) => once('promotion', () => createPromotion(ctx, code20(`PERF${fixtureId(ctx.vu)}`), prep('admin.discount.create')));
const promoQuery = (ctx) => `?type=promotion&partner=${enc(partnerOf(ctx))}`;

// the app (2026-10-13) wants the partner the image belongs to — `partnerCode` is not in the spec yet
const uploadImage = (ctx, tag) => {
  const res = postMultipart(api('/api/admin/upload/product-image'), { image: imageFile(), partnerCode: partnerOf(ctx) }, tag, ctx.session);
  if (!expectStatus(res, 200, tag)) return undefined;
  const body = safeJson(res) || {};
  if (!expectShape(res, tag, 'returns fileId', () => body.success === true && !!body.fileId)) return undefined;
  return body.fileId;
};
const deleteImage = (ctx, fileId, tag) => expectStatus(del(`${api('/api/admin/upload/product-image')}?fileId=${enc(fileId)}`, tag, ctx.session), 200, tag);

// The admin list's next-page cursor, found once per VU (prep), for the cursor-page read.
const vuCursor = (ctx) => once('cursor', () => {
  const res = get(`${api('/api/admin/orders')}?limit=10${scope(ctx)}`, prep('admin.orders.list'), ctx.session);
  if (!expectStatus(res, 200, prep('admin.orders.list'))) return undefined;
  const c = (safeJson(res) || {}).nextCursor;
  expectShape(res, prep('admin.orders.list'), 'has a next page', () => typeof c === 'string' && c.length > 0);
  return c;
});
// `?partner=` for a scoped read: the main partner when the admin role is partner (a PARTNER_ADMIN
// may also omit it and get every partner it is bound to); super admins omit it.
const scope = (ctx) => (adminRole() === 'partner' && cfg.partner ? `&partner=${enc(cfg.partner)}` : '');

const read200 = (url, extra) => (ctx, tag) => expectStatus(get(url(ctx), tag, ctx.session, extra), 200, tag);

// ---- Catalogue ------------------------------------------------------------------------
export const ENDPOINTS = {
  // ---- public (no cookie) --------------------------------------------------------------
  'products.list': { // FOCUS line
    kind: 'read', who: 'none', api: 'GET /api/products?partner={P}', db: 'cache', rate: 50,
    run: (ctx, tag) => {
      const res = get(`${api('/api/products')}?partner=${enc(partnerAt(ctx.data.catalog, ctx.iter))}`, tag);
      return expectStatus(res, 200, tag) && expectShape(res, tag, 'has products[]', () => Array.isArray((safeJson(res) || {}).products));
    },
  },
  'products.image': {
    kind: 'read', who: 'none', api: 'GET /api/product-image/{PERF_IMAGE_FILE_ID}?folder=qr-code-payment', db: 'none', rate: 20,
    run: (ctx, tag) => {
      if (!expectShape({ status: 0 }, tag, 'has PERF_IMAGE_FILE_ID (a QR / product file id)', () => !!cfg.imageFileId)) return false;
      return expectStatus(get(`${api('/api/product-image/' + enc(cfg.imageFileId))}?folder=qr-code-payment`, tag, undefined, BINARY), 200, tag);
    },
  },
  'discount.validate': {
    kind: 'read', who: 'none', api: 'POST /api/discount/validate {code, codeType: referral, partner}', db: 'none', rate: 20,
    run: (ctx, tag) => {
      // valid:false is still HTTP 200 (docs §3.1.2) — the shape check only asks for the envelope
      const res = postJson(api('/api/discount/validate'), { code: cfg.referralCode, codeType: 'referral', partner: partnerAt(ctx.data.catalog, ctx.iter) }, tag);
      return expectStatus(res, 200, tag) && expectShape(res, tag, 'has valid', () => typeof (safeJson(res) || {}).valid === 'boolean');
    },
  },
  'orders.create': { // FOCUS line
    kind: 'write', who: 'none', api: 'POST /api/orders (multipart: payload + slip) — counters/{PARTNER-YYMM} transaction + GCS upload', db: 'write', rate: 10,
    run: (ctx, tag) => !!placeOrder(ctx.data.catalog, partnerAt(ctx.data.catalog, ctx.iter), tag),
  },

  // ---- auth ---------------------------------------------------------------------------
  'auth.login': {
    kind: 'auth', who: 'none', api: 'POST /api/admin/login {username, password} — bcrypt cost 12', db: 'none', rate: 2,
    run: (ctx, tag) => { const a = accountOf(adminRole()); return !!login(a.username, a.password, tag); },
  },
  'auth.logout': {
    kind: 'read', who: 'none', api: 'POST /api/admin/logout (no auth check: clears the cookie)', db: 'none', rate: 20,
    run: (ctx, tag) => expectStatus(postEmpty(api('/api/admin/logout'), tag), 200, tag),
  },

  // ---- admin — orders -----------------------------------------------------------------
  'admin.orders.list': { // FOCUS line
    kind: 'read', who: 'admin', api: 'GET /api/admin/orders?limit=10 (first page)', db: 'none', rate: 50,
    run: (ctx, tag) => {
      const res = get(`${api('/api/admin/orders')}?limit=10${scope(ctx)}`, tag, ctx.session);
      return expectStatus(res, 200, tag) && expectShape(res, tag, 'has orders[]', () => Array.isArray((safeJson(res) || {}).orders));
    },
  },
  'admin.orders.filter': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/orders?limit=10&status=รอตรวจสอบสลิป&from={-7d}&to={today}', db: 'none', rate: 50,
    run: read200((ctx) => `${api('/api/admin/orders')}?limit=10&status=${enc(STATUS.pending)}&from=${daysAgo(7)}&to=${daysAgo(0)}${scope(ctx)}`),
  },
  'admin.orders.page': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/orders?limit=10&cursor={nextCursor} (second page)', db: 'none', rate: 50,
    run: (ctx, tag) => {
      const c = vuCursor(ctx);
      if (!c) { prepFailed.add(1, { endpoint: tag }); return false; }
      return expectStatus(get(`${api('/api/admin/orders')}?limit=10&cursor=${enc(c)}${scope(ctx)}`, tag, ctx.session), 200, tag);
    },
  },
  'admin.orders.all': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/orders (no limit: UNBOUNDED — every order in scope)', db: 'none', rate: 1, heavy: true,
    run: read200((ctx) => `${api('/api/admin/orders')}${scope(ctx) ? '?' + scope(ctx).slice(1) : ''}`),
  },
  'admin.orders.search': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/orders?limit=100&q=08 (full scan, filtered in memory)', db: 'none', rate: 1, heavy: true,
    run: read200((ctx) => `${api('/api/admin/orders')}?limit=100&q=08${scope(ctx)}`),
  },
  'admin.orders.setStatus': {
    kind: 'write', who: 'admin', api: 'PATCH /api/admin/orders/{orderId}/status {status, trackingNumber} — alternates ยืนยันแล้ว / รอตรวจสอบสลิป', db: 'write', rate: 10,
    run: (ctx, tag) => {
      const o = orderFor(ctx, tag);
      if (!o) return false;
      const status = ctx.iter % 2 ? STATUS.pending : STATUS.confirmed;
      return expectStatus(patchJson(api(`/api/admin/orders/${enc(o.id)}/status`), { status, trackingNumber: '' }, tag, ctx.session), 200, tag);
    },
  },
  'admin.orders.note': {
    kind: 'write', who: 'admin', api: 'PATCH /api/admin/orders/{orderId}/note {adminNote}', db: 'write', rate: 10,
    run: (ctx, tag) => {
      const o = orderFor(ctx, tag);
      if (!o) return false;
      return expectStatus(patchJson(api(`/api/admin/orders/${enc(o.id)}/note`), { adminNote: `perf ${cfg.runId} #${ctx.iter}` }, tag, ctx.session), 200, tag);
    },
  },

  // ---- admin — dashboard --------------------------------------------------------------
  'admin.dashboard': { // FOCUS line
    kind: 'read', who: 'admin', api: 'GET /api/admin/dashboard-stats (Firestore aggregation, 30 s cache per key)', db: 'cache', rate: 50,
    run: (ctx, tag) => {
      const res = get(`${api('/api/admin/dashboard-stats')}${scope(ctx) ? '?' + scope(ctx).slice(1) : ''}`, tag, ctx.session);
      return expectStatus(res, 200, tag) && expectShape(res, tag, 'has orderCount', () => typeof (safeJson(res) || {}).orderCount === 'number');
    },
  },
  'admin.dashboard.range': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/dashboard-stats?from={-N d}&to={today} — a rotating range, so the 30 s cache rarely hits', db: 'cache', rate: 10,
    run: read200((ctx) => `${api('/api/admin/dashboard-stats')}?from=${daysAgo(1 + (ctx.iter % 30))}&to=${daysAgo(0)}${scope(ctx)}`),
  },

  // ---- admin — products ---------------------------------------------------------------
  'admin.products.list': { // FOCUS line
    kind: 'read', who: 'admin', api: 'GET /api/admin/products?partner={P} (10 rows, cursor)', db: 'none', rate: 10,
    run: read200((ctx) => `${api('/api/admin/products')}?partner=${enc(partnerOf(ctx))}`),
  },
  'admin.products.search': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/products?q=P0 (in-memory search)', db: 'none', rate: 5,
    run: read200((ctx) => `${api('/api/admin/products')}?q=${enc(partnerOf(ctx).slice(0, 2))}${scope(ctx)}`),
  },
  'admin.products.create': {
    kind: 'write', who: 'admin', api: 'POST /api/admin/products (unique id per request, active:false; deleted again as prep)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const id = createProduct(ctx, `PERF-${uid(ctx.vu, ctx.iter)}`, tag);
      if (!id) return false;
      okOrNote(deleteProduct(ctx, id, prep('admin.products.delete')), tag);
      return true;
    },
  },
  'admin.products.update': {
    kind: 'write', who: 'admin', api: 'PUT /api/admin/products/{productCode} {price} on this VU\'s perf product (created once as prep)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const id = vuProduct(ctx);
      if (!id) { prepFailed.add(1, { endpoint: tag }); return false; }
      return expectStatus(putJson(api(`/api/admin/products/${enc(id)}`), { price: 50 + (ctx.iter % 50), name: `น้ำทดสอบ perf ${id} #${ctx.iter}` }, tag, ctx.session), 200, tag);
    },
  },
  'admin.products.delete': {
    kind: 'write', who: 'admin', api: 'DELETE /api/admin/products/{productCode} (created just before as prep)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const id = createProduct(ctx, `PERF-${uid(ctx.vu, ctx.iter)}`, prep('admin.products.create'));
      if (!id) { prepFailed.add(1, { endpoint: tag }); return false; }
      return deleteProduct(ctx, id, tag);
    },
  },

  // ---- admin — partners ---------------------------------------------------------------
  'admin.partners.list': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/partners (every partner, read live — the dropdown)', db: 'none', rate: 20,
    run: (ctx, tag) => {
      const res = get(api('/api/admin/partners'), tag, ctx.session);
      return expectStatus(res, 200, tag) && expectShape(res, tag, 'has partners[]', () => Array.isArray((safeJson(res) || {}).partners));
    },
  },
  'admin.partners.create': {
    kind: 'write', who: 'super', api: 'POST /api/admin/partners {partnerCode, name} (unique code per request — LEAVES a partner, no delete route)', db: 'write', rate: 2,
    run: (ctx, tag) => !!createPartner(ctx, code20(`PF${uid(ctx.vu, ctx.iter)}`), tag),
  },
  'admin.partners.update': {
    kind: 'write', who: 'super', api: 'PUT /api/admin/partners/{id} {name} on this VU\'s perf partner (created once as prep)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const id = vuPartner(ctx);
      if (!id) { prepFailed.add(1, { endpoint: tag }); return false; }
      return expectStatus(putJson(api(`/api/admin/partners/${enc(id)}`), { name: `Perf partner ${id} #${ctx.iter}` }, tag, ctx.session), 200, tag);
    },
  },
  'admin.partners.active': {
    kind: 'write', who: 'super', api: 'PATCH /api/admin/partners/{id}/active {isActive} on this VU\'s perf partner (toggles; never a real partner)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const id = vuPartner(ctx);
      if (!id) { prepFailed.add(1, { endpoint: tag }); return false; }
      return expectStatus(patchJson(api(`/api/admin/partners/${enc(id)}/active`), { isActive: ctx.iter % 2 === 0 }, tag, ctx.session), 200, tag);
    },
  },

  // ---- admin — users (SUPER_ADMIN only) -----------------------------------------------
  'admin.users.list': {
    kind: 'read', who: 'super', api: 'GET /api/admin/users (whole collection)', db: 'none', rate: 10,
    run: (ctx, tag) => {
      const res = get(api('/api/admin/users'), tag, ctx.session);
      return expectStatus(res, 200, tag) && expectShape(res, tag, 'has users[]', () => Array.isArray((safeJson(res) || {}).users));
    },
  },
  'admin.users.create': {
    kind: 'write', who: 'super', api: 'POST /api/admin/users (PARTNER_VIEWER, bcrypt hash — LEAVES a user; unique username per request)', db: 'write', rate: 2,
    run: (ctx, tag) => !!createUser(ctx, `perf.${uid(ctx.vu, ctx.iter).toLowerCase()}`, tag),
  },
  'admin.users.update': {
    kind: 'write', who: 'super', api: 'PUT /api/admin/users/{id} {name} on this VU\'s perf user (no password → no bcrypt)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const id = vuUser(ctx);
      if (!id) { prepFailed.add(1, { endpoint: tag }); return false; }
      return expectStatus(putJson(api(`/api/admin/users/${enc(id)}`), { name: `Perf user #${ctx.iter}` }, tag, ctx.session), 200, tag);
    },
  },
  'admin.users.active': {
    kind: 'write', who: 'super', api: 'PATCH /api/admin/users/{id}/active {isActive} on this VU\'s perf user (toggles)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const id = vuUser(ctx);
      if (!id) { prepFailed.add(1, { endpoint: tag }); return false; }
      return expectStatus(patchJson(api(`/api/admin/users/${enc(id)}/active`), { isActive: ctx.iter % 2 === 0 }, tag, ctx.session), 200, tag);
    },
  },

  // ---- admin — discount codes ---------------------------------------------------------
  'admin.discount.list': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/discount-codes?type=promotion', db: 'none', rate: 10,
    run: (ctx, tag) => {
      const res = get(`${api('/api/admin/discount-codes')}?type=promotion`, tag, ctx.session);
      return expectStatus(res, 200, tag) && expectShape(res, tag, 'has codes[]', () => Array.isArray((safeJson(res) || {}).codes));
    },
  },
  'admin.discount.create': {
    kind: 'write', who: 'admin', api: 'POST /api/admin/discount-codes (promotion, 1 partner, isActive:false — LEAVES a code + audit row)', db: 'write', rate: 5,
    run: (ctx, tag) => !!createPromotion(ctx, code20(`PERF${uid(ctx.vu, ctx.iter)}`), tag),
  },
  'admin.discount.update': {
    kind: 'write', who: 'admin', api: 'PUT /api/admin/discount-codes/{code}?type=promotion&partner={P} {discountValue} on this VU\'s perf code', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const code = vuPromotion(ctx);
      if (!code) { prepFailed.add(1, { endpoint: tag }); return false; }
      return expectStatus(putJson(`${api('/api/admin/discount-codes/' + enc(code))}${promoQuery(ctx)}`, { discountValue: 5 + (ctx.iter % 10) }, tag, ctx.session), 200, tag);
    },
  },
  'admin.discount.active': {
    kind: 'write', who: 'admin', api: 'PATCH /api/admin/discount-codes/{code}/active?type=promotion&partner={P} {isActive} on this VU\'s perf code (+ audit row)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const code = vuPromotion(ctx);
      if (!code) { prepFailed.add(1, { endpoint: tag }); return false; }
      return expectStatus(patchJson(`${api('/api/admin/discount-codes/' + enc(code) + '/active')}${promoQuery(ctx)}`, { isActive: ctx.iter % 2 === 0 }, tag, ctx.session), 200, tag);
    },
  },

  // ---- admin — images / slips ---------------------------------------------------------
  // A scoped (partner) admin only gets a slip whose order it can see; the app looks the owner up by
  // slipUrl with limit(1), so with the perf seed's ONE shared slip file every lookup lands on an
  // arbitrary order → mostly 404 under PERF_ADMIN_ROLE=partner. Run it as super, or on real data.
  'admin.slip': {
    kind: 'read', who: 'admin', api: 'GET /api/admin/slip/{fileId} (binary from GCS on every call; partner role: 404 unless the slip\'s order is in scope)', db: 'none', rate: 20,
    run: (ctx, tag) => {
      const o = poolAt((ctx.data && ctx.data.pool) || [], ctx.iter);
      const fileId = (o && o.slip) || cfg.slipFileId;
      return expectStatus(get(api(`/api/admin/slip/${enc(fileId)}`), tag, ctx.session, BINARY), 200, tag);
    },
  },
  'admin.upload.productImage': {
    kind: 'write', who: 'admin', api: 'POST /api/admin/upload/product-image (multipart `image` + `partnerCode`, PNG ≤ 4 MB) — deleted again as prep', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const fileId = uploadImage(ctx, tag);
      if (!fileId) return false;
      okOrNote(deleteImage(ctx, fileId, prep('admin.upload.delete')), tag);
      return true;
    },
  },
  'admin.upload.delete': {
    kind: 'write', who: 'admin', api: 'DELETE /api/admin/upload/product-image?fileId={id} (uploaded just before as prep)', db: 'write', rate: 5,
    run: (ctx, tag) => {
      const fileId = uploadImage(ctx, prep('admin.upload.productImage'));
      if (!fileId) { prepFailed.add(1, { endpoint: tag }); return false; }
      return deleteImage(ctx, fileId, tag);
    },
  },
  'admin.upload.qr': {
    kind: 'write', who: 'super', api: 'POST /api/admin/upload/qr-image (multipart `image`, PNG) — LEAVES a file in qr-code-payment/', db: 'write', rate: 2,
    run: (ctx, tag) => {
      const res = postMultipart(api('/api/admin/upload/qr-image'), { image: imageFile('perf-qr.png') }, tag, ctx.session);
      return expectStatus(res, 200, tag) && expectShape(res, tag, 'returns fileId', () => !!(safeJson(res) || {}).fileId);
    },
  },
};

// TS-01 default rate per endpoint (docs "List Load Test" for the five priority lines; see the header).
export const defaultRate = (ep) => ep.rate || (ep.kind === 'write' ? 5 : ep.kind === 'auth' ? 2 : 20);

// Which setup data an endpoint needs: sessions (and which role), the catalog, the order pool.
export const needsOf = (ids) => {
  const out = { roles: new Set(), catalog: false, pool: false };
  ids.forEach((id) => {
    const ep = ENDPOINTS[id];
    if (!ep) return;
    if (ep.who === 'admin') out.roles.add(adminRole());
    if (ep.who === 'super') out.roles.add('super');
    if (/^(products\.list|discount\.validate|orders\.create)$/.test(id)) out.catalog = true;
    if (/^admin\.(orders\.(setStatus|note)|slip)$/.test(id)) out.pool = true;
    if (/^admin\.(products|discount)\./.test(id) && !cfg.partner) out.catalog = true; // the main partner comes from the catalog
  });
  return out;
};

// Groups for TS-01 Endpoint (Group Run), scripts/ts01-queue.sh: `reads` is the safe default
// (`heavy` reads excluded — they are a scenario of their own).
// The spec's five "List Load Test" lines (#1 orders 10 TPS, #3 products 50, #7 admin orders 50,
// #10 dashboard 50, #11 admin products 10) — the focus set: `scripts/ts01-queue.sh focus`, the
// runner's "focus" quick pick, and the weights of the soak / stress / spike mix (lib/journeys.js).
export const FOCUS = ['orders.create', 'products.list', 'admin.orders.list', 'admin.dashboard', 'admin.products.list'];
export const GROUPS = {
  focus: FOCUS,
  reads: Object.keys(ENDPOINTS).filter((k) => ENDPOINTS[k].kind === 'read' && !ENDPOINTS[k].heavy),
  heavy: Object.keys(ENDPOINTS).filter((k) => ENDPOINTS[k].heavy),
  auth: Object.keys(ENDPOINTS).filter((k) => ENDPOINTS[k].kind === 'auth'),
  writes: Object.keys(ENDPOINTS).filter((k) => ENDPOINTS[k].kind === 'write'),
};
