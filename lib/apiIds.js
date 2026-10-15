// IDs the results sheet keys on, written into the ID column of …_results.csv so a row can be judged
// without a lookup. API IDs follow the operation numbers of docs/api-spec-loadtest.md's table
// (LN-01 … LN-30, one per method + path); several tags can share one API (every admin-orders read
// is LN-07). Scenario IDs name the blended "ALL requests" row of a scenario.
// Every request tag in lib/thresholds.js and lib/endpoints.js must be listed here; a new tag
// without an entry gets an empty ID.

export const TAG_API = {
  // LN-01 POST /api/orders
  'orders.create': 'LN-01', 'shop.order': 'LN-01', 'mix.order': 'LN-01',
  // LN-02 POST /api/discount/validate
  'discount.validate': 'LN-02', 'shop.validate': 'LN-02',
  // LN-03 GET /api/products
  'products.list': 'LN-03', 'shop.products': 'LN-03', 'mix.products': 'LN-03', 'prep.catalog': 'LN-03',
  // LN-04 GET /api/product-image/{fileId}
  'products.image': 'LN-04',
  // LN-05 POST /api/admin/login · LN-06 POST /api/admin/logout
  'auth.login': 'LN-05', 'prep.login': 'LN-05', 'auth.logout': 'LN-06',
  // LN-07 GET /api/admin/orders
  'admin.orders.list': 'LN-07', 'admin.orders.filter': 'LN-07', 'admin.orders.page': 'LN-07', 'admin.orders.all': 'LN-07',
  'admin.orders.search': 'LN-07', 'ops.list': 'LN-07', 'ops.filter': 'LN-07', 'ops.page': 'LN-07', 'mix.orders': 'LN-07',
  'prep.orders': 'LN-07', 'neg.noCookie': 'LN-07', 'neg.scope': 'LN-07',
  // LN-08 PATCH …/status · LN-09 PATCH …/note
  'admin.orders.setStatus': 'LN-08', 'ops.status': 'LN-08',
  'admin.orders.note': 'LN-09', 'ops.note': 'LN-09', 'neg.viewerWrite': 'LN-09',
  // LN-10 GET /api/admin/dashboard-stats
  'admin.dashboard': 'LN-10', 'admin.dashboard.range': 'LN-10', 'dash.stats': 'LN-10', 'dash.range': 'LN-10', 'mix.dashboard': 'LN-10',
  // LN-11 … LN-14 admin products
  'admin.products.list': 'LN-11', 'admin.products.search': 'LN-11', 'mix.catalog': 'LN-11',
  'admin.products.create': 'LN-12', 'admin.products.update': 'LN-13', 'admin.products.delete': 'LN-14',
  // LN-15 … LN-18 partners
  'admin.partners.list': 'LN-15', 'dash.partners': 'LN-15', 'admin.partners.create': 'LN-16', 'admin.partners.update': 'LN-17', 'admin.partners.active': 'LN-18',
  // LN-19 … LN-22 users
  'admin.users.list': 'LN-19', 'prep.users': 'LN-19', 'admin.users.create': 'LN-20', 'admin.users.update': 'LN-21', 'admin.users.active': 'LN-22',
  'neg.inactive': 'LN-05',
  // LN-23 … LN-26 discount codes
  'admin.discount.list': 'LN-23', 'admin.discount.create': 'LN-24', 'admin.discount.update': 'LN-25', 'admin.discount.active': 'LN-26',
  // LN-27 slip · LN-28 / LN-29 product image upload / delete · LN-30 QR upload
  'admin.slip': 'LN-27', 'ops.slip': 'LN-27',
  'admin.upload.productImage': 'LN-28', 'admin.upload.delete': 'LN-29', 'admin.upload.qr': 'LN-30',
};

export const SCENARIO_ID = {
  ts02: 'TS-02', ts03: 'TS-03', ts04: 'TS-04', stress: 'STRESS', soak: 'SOAK', spike: 'SPIKE', auth: 'AUTH', smoke: 'SMOKE', check: 'CHECK',
};

// rowId: the report row's id — a tag, or 'ALL requests' for the blended row. `prep.<x>` steps of a
// TS-01 write chain take the ID of the operation they call.
export const idFor = (rowId, scenario) => {
  if (rowId === 'ALL requests') return SCENARIO_ID[scenario] || '';
  if (TAG_API[rowId]) return TAG_API[rowId];
  const m = /^prep\.(.+)$/.exec(rowId);
  return (m && TAG_API[m[1]]) || '';
};
