// Admin sign-in: POST /api/admin/login → cookie `pmc_admin_session` (httpOnly, 12 h; docs §2, §3.2).
// bcrypt cost 12 makes every login ~100 ms of CPU on the serverless side, so the scenarios sign
// each role in ONCE per run in setup() (lib/auth.js sessions) and hand the cookie value to every VU
// through setup data — never once per VU, never per iteration (except the `auth` scenario and
// TS-01's auth.login, whose point is the login itself).
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { api, cfg } from './config.js';
import { COOKIE, expectShape, expectStatus, safeJson, track } from './http.js';

// One login. Returns the cookie value, or undefined (the checks say why). `tag` names the request
// (`auth.login` when the login is the thing measured, `prep.login` otherwise).
export const login = (username, password, tag = 'auth.login') => {
  // a fresh jar per call: the VU's own jar never holds a session, every admin call sends the cookie
  // it was given (lib/http.js cookieHeader), so roles never leak between calls
  const res = http.post(api('/api/admin/login'), JSON.stringify({ username, password }), {
    headers: { 'content-type': 'application/json' }, jar: new http.CookieJar(), tags: { name: tag },
  });
  track(res, tag);
  if (!expectStatus(res, 200, tag)) return undefined;
  const body = safeJson(res) || {};
  const c = res.cookies && res.cookies[COOKIE];
  const value = c && c[0] && c[0].value;
  if (!expectShape(res, tag, `sets ${COOKIE}`, () => body.success === true && typeof value === 'string' && value.length > 0)) return undefined;
  return value;
};

export const ROLE_ACCOUNT = { super: 'superAdmin', partner: 'partnerAdmin', viewer: 'viewer' };
export const accountOf = (role) => cfg[ROLE_ACCOUNT[role]] || { username: '', password: '' };
export const roleConfigured = (role) => !!(accountOf(role).username && accountOf(role).password);

// setup(): sign the given roles in once (tag prep.login). Returns { super: <cookie>, partner: …,
// viewer: … } — a role whose account is not configured, or whose login failed, is absent; `strict`
// throws instead (a load run must not start without its session).
export const sessions = (roles, strict = true) => {
  const out = {};
  roles.forEach((role) => {
    const a = accountOf(role);
    if (!a.username || !a.password) {
      if (strict) throw new Error(`${role} account not configured — set PERF_${role === 'super' ? 'ADMIN' : role.toUpperCase()}_USER / _PASS (docs §1.2)`);
      return;
    }
    const s = login(a.username, a.password, 'prep.login');
    if (!s && strict) throw new Error(`${role} login failed for ${a.username} (see the prep.login checks)`);
    if (s) out[role] = s;
  });
  if (Object.keys(out).length) console.log(`[auth] signed in: ${Object.keys(out).map((r) => `${r}=${accountOf(r).username}`).join(' · ')}`);
  return out;
};

// The admin role the `who: 'admin'` endpoints and journeys use (PERF_ADMIN_ROLE: super | partner).
export const adminRole = () => (cfg.adminRole === 'partner' ? 'partner' : 'super');

// In the VU: the session for a role, from setup data; a VU without one (setup skipped the role,
// or the cookie expired after 12 h → 401) signs in itself ONCE with back-off, tagged prep.login,
// and counts the iterations it had to skip in `no_session` (lib/report.js warns).
const own = {};
let failures = 0, retryAt = 0;
const noSession = new Counter('no_session');
const backoffMs = (n) => Math.min(300000, 15000 * Math.pow(2, n - 1));
export const sessionFor = (data, role) => {
  const r = role === 'admin' ? adminRole() : role;
  const given = data && data.sessions && data.sessions[r];
  if (given) return given;
  if (own[r]) return own[r];
  const a = accountOf(r);
  if (!a.username || !a.password) { noSession.add(1, { role: r }); return undefined; }
  if (failures && Date.now() < retryAt) { noSession.add(1, { role: r }); return undefined; }
  const s = login(a.username, a.password, 'prep.login');
  if (s) { own[r] = s; failures = 0; } else { failures++; retryAt = Date.now() + backoffMs(failures); noSession.add(1, { role: r }); }
  return s;
};
// A 401 on an admin call means the cookie is gone (12 h) or the login was refused: drop the
// cached one so the next iteration signs in again (lib/endpoints.js / journeys call this).
export const forgetSession = (role) => { delete own[role === 'admin' ? adminRole() : role]; };
