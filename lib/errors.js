// Where did a failed request fail? Kept from pmc-perf (lib/errors.js), adjusted for pmc-line's
// path: Vercel edge (CDN / WAF / function limits) → the Next.js route handler → Firestore / GCS.
//
// Every failed check on a response records one point of the `err_detail` counter, tagged
//   name   the request tag            status  HTTP status ('0' = no response)
//   code   app error text (slug) / k6 error code / html-<status> / vercel-<status>
//   src    vercel | backend | network | other
//   msg    first 90 chars of the message
// tools/runner.py reads these from k6's raw output and adds an "Error detail" section to the
// run's HTML report (command-line runs without the runner keep the per-tag/status counts only).
import { Counter } from 'k6/metrics';

const errDetail = new Counter('err_detail');

const header = (res, name) => {
  const h = (res && res.headers) || {};
  return h[name] || h[name.toLowerCase()] || '';
};
const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90);
// A stable code for an app error message: "สินค้าหมด: น้ำดื่ม 1L" → "สินค้าหมด", "Order not found: X" → "Order not found"
const slug = (msg) => short(String(msg || '').split(/[:(]/)[0]).slice(0, 40) || '-';

export const classify = (res) => {
  if (!res || !res.status) {
    return { status: '0', code: res && res.error_code ? `k6-${res.error_code}` : 'k6', src: 'network', msg: short((res && res.error) || 'no response') };
  }
  const status = String(res.status);
  const body = String(res.body || '');
  const ctype = header(res, 'Content-Type');
  let j = null;
  try { j = JSON.parse(body); } catch (_) { j = null; }
  // Vercel answers for the platform itself (function timeout 504, payload 413, WAF / deployment
  // protection 401/403, 502 FUNCTION_INVOCATION_FAILED): an `x-vercel-error` header, or its own
  // plain-text / HTML page that is not the app's JSON envelope.
  const vercelErr = header(res, 'x-vercel-error');
  if (vercelErr) return { status, code: `vercel-${short(vercelErr).toLowerCase()}`, src: 'vercel', msg: short(body || vercelErr) };
  if (/html/i.test(ctype) && !j) {
    const t = body.match(/<title>([^<]*)<\/title>/i);
    const vercel = /vercel/i.test(body) || !!header(res, 'x-vercel-id');
    return { status, code: `${vercel ? 'vercel' : 'html'}-${status}`, src: vercel ? 'vercel' : 'other', msg: short(t ? t[1] : body) };
  }
  // pmc-line envelope: { success: false, error: "<text>", fieldErrors? } — or the discount
  // validator's own { valid: false, error }
  if (j && typeof j.error === 'string') {
    const fields = j.fieldErrors && typeof j.fieldErrors === 'object' ? ' · ' + Object.keys(j.fieldErrors).join(',') : '';
    return { status, code: slug(j.error), src: 'backend', msg: short(j.error + fields) };
  }
  if (j && j.error && typeof j.error === 'object') return { status, code: slug(j.error.code || j.error.message), src: 'backend', msg: short(j.error.message || body) };
  return { status, code: '-', src: header(res, 'x-vercel-id') || header(res, 'x-powered-by') ? 'backend' : 'other', msg: short(body) };
};

// reason: extra text when the status was right but the content wasn't (shape checks).
export const recordError = (name, res, reason) => {
  const c = classify(res);
  if (reason) c.msg = short(`${reason}${c.msg ? ' · ' + c.msg : ''}`);
  errDetail.add(1, { name, status: c.status, code: c.code, src: c.src, msg: c.msg });
};
