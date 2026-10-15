import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { cfg } from './config.js';
import { recordError } from './errors.js';
import { GATE } from './thresholds.js';

// Thin wrappers that always set the `name` tag. Thresholds and the rollup key on it, and it
// collapses `/api/admin/orders/{orderId}/status` URLs into one series instead of one per id.
//
// Auth is the admin cookie `pmc_admin_session` (docs §2): `session` is its value (lib/auth.js);
// the wrappers send it as a Cookie header. Public calls pass undefined.

// THE ERROR GATE'S METRIC: a response slower than GATE.slowMs is a failure.
// `req_failed` = HTTP error (k6's own rule: status outside 200–399, or outside `expected`)
// OR slower than GATE.slowMs. `req_slow` = the slow part alone, reported, never gated.
// Every request must pass through track(): the wrappers below do it, and the few direct
// k6/http calls (lib/journeys.js batch) call it themselves.
const reqFailed = new Rate('req_failed');
const reqSlow = new Rate('req_slow');
export const track = (res, name, expected) => {
  const status = res ? res.status : 0;
  const httpFailed = expected ? expected.indexOf(status) < 0 : !(status >= 200 && status < 400);
  const slow = !!res && res.timings.duration > GATE.slowMs;
  reqFailed.add(httpFailed || slow, { name });
  reqSlow.add(slow, { name });
  return res;
};

// Statuses that are not failures for one call: k6 needs the callback, track() the list.
export const expectStatuses = (codes) => ({ responseCallback: http.expectedStatuses.apply(http, codes), expected: codes });

export const COOKIE = 'pmc_admin_session';
export const cookieHeader = (session) => (session ? { cookie: `${COOKIE}=${session}` } : {});

const withName = (name, session, extra = {}) => {
  const params = Object.assign({}, extra, {
    headers: Object.assign(cookieHeader(session), extra.headers),
    tags: Object.assign({}, extra.tags, { name }),
  });
  delete params.expected; // ours, not a k6 param
  return params;
};
const expectedOf = (extra) => (extra ? extra.expected : undefined);

const JSON_HEADERS = { 'content-type': 'application/json' };
const jsonExtra = (extra = {}) => Object.assign({}, extra, { headers: Object.assign({}, JSON_HEADERS, extra.headers) });

export const get = (url, name, session, extra) => track(http.get(url, withName(name, session, extra)), name, expectedOf(extra));

export const postJson = (url, body, name, session, extra) =>
  track(http.post(url, JSON.stringify(body), withName(name, session, jsonExtra(extra))), name, expectedOf(extra));

export const putJson = (url, body, name, session, extra) =>
  track(http.put(url, JSON.stringify(body), withName(name, session, jsonExtra(extra))), name, expectedOf(extra));

export const patchJson = (url, body, name, session, extra) =>
  track(http.patch(url, JSON.stringify(body), withName(name, session, jsonExtra(extra))), name, expectedOf(extra));

export const del = (url, name, session, extra) => track(http.del(url, null, withName(name, session, extra)), name, expectedOf(extra));

// Empty-body POST (logout).
export const postEmpty = (url, name, session, extra) => track(http.post(url, null, withName(name, session, extra)), name, expectedOf(extra));

// multipart/form-data: `form` is a plain object whose file fields are http.file(...) values — k6
// builds the multipart body and its boundary itself (POST /api/orders, the image uploads).
export const postMultipart = (url, form, name, session, extra) =>
  track(http.post(url, form, withName(name, session, extra)), name, expectedOf(extra));

// With PERF_DEBUG=1, a failed check prints what actually came back — the point of a smoke run.
const debugFail = (name, label, res) => {
  if (!cfg.debug) return;
  const body = res && res.body ? String(res.body).slice(0, 500) : '';
  console.warn(`[FAIL] ${name} ${label}: status=${res && res.status} ${res && res.error ? 'error=' + res.error + ' ' : ''}body=${body}`);
};

// One check per call, named after the tag, so the summary lists failures per endpoint.
export const expectStatus = (res, status, name) => {
  const ok = check(res, { [`${name} ${status}`]: (r) => r.status === status });
  if (!ok) {
    debugFail(name, `expected ${status}`, res);
    recordError(name, res);
  }
  return ok;
};

// A check on the response content, for when a 200 alone would hide a broken script
// (e.g. an empty list, a catalog with no product to order).
export const expectShape = (res, name, label, predicate) => {
  let ok = false;
  try {
    ok = check(res, { [`${name} ${label}`]: () => predicate() === true });
  } catch (_) {
    ok = check(res, { [`${name} ${label}`]: () => false });
  }
  if (!ok) {
    debugFail(name, label, res);
    // only real responses (some checks pass a placeholder object, e.g. "pool not exhausted")
    if (res && res.headers) recordError(name, res, label);
  }
  return ok;
};

export const safeJson = (res) => {
  try {
    return res.json();
  } catch (_) {
    return undefined;
  }
};
