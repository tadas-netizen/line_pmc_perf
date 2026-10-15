#!/usr/bin/env python3
"""pmc-line perf runner — a local web page to start k6 scenarios and watch them live.

    python3 tools/runner.py              then open http://127.0.0.1:8765
    python3 tools/runner.py --port 9000

Kept from pmc-perf (tools/runner.py; originally ported from the TGIA reference toolkit), rewritten
for pmc-line's scenarios, PERF_* variables, targets and endpoint catalogue. Standard library only.

- Listens on 127.0.0.1 only; POSTs need the X-Runner header (no cross-site requests).
- Only whitelisted scenarios / variables / targets can be run — the page sends no paths or URLs.
- One run at a time. Stop = Ctrl+C to k6 (it still writes its summary); stop again = kill.
- Target "mock" starts scripts/mock_line.py. Target "local" = the pmc-line dev server on
  http://localhost:3000 (pnpm dev + the Firestore / GCS emulators); the page shows a checklist
  (app up, products, login, slip fixture) and "prepare now" runs scripts/local-prepare.sh.
  Targets "stg" / "prod" = PERF_TARGET + the host from PERF_STG_BASE / PERF_PROD_BASE and the
  accounts from .env / .env.<target>. Selecting one, and every run on one, needs the word typed in
  a modal (STAGING / PRODUCTION); the server checks it and passes it as PERF_CONFIRM.
- Live charts read k6's raw output (K6_OUT=json) from results/_live/, which is deleted at the end;
  a per-second summary is kept as results/<run>_live.json for replay.
"""
import argparse, calendar, csv, glob, json, os, re, signal, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

import runner_th  # Thai text for the page's TH language (tools/runner_th.py)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")
LIVE_DIR = os.path.join(RESULTS, "_live")
HTML = os.path.join(ROOT, "tools", "runner.html")
LAST_RUN = os.path.join(RESULTS, "_last_run.json")  # info of the latest finished run (gitignored with results/)
MOCK_PORT = int(os.environ.get("MOCK_PORT", "18090"))
MOCK_BASE = f"http://127.0.0.1:{MOCK_PORT}"
LOCAL_BASE = os.environ.get("LOCAL_BASE", "http://localhost:3100")

# ---- Targets --------------------------------------------------------------------------

CONFIRM_WORD = {"stg": "STAGING", "prod": "PRODUCTION", "custom": "CUSTOM"}  # must match lib/config.js
CUSTOM_FILE = os.path.join(RESULTS, "_custom_base.txt")  # the last custom URL, so the page pre-fills it
CUSTOM_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$")
TARGET_LABEL = {"mock": "local (mock)", "local": "local pmc-line", "stg": "STAGING", "prod": "PRODUCTION", "custom": "custom URL"}
# the mock's seed accounts (scripts/mock_line.py) = the emulator seed's (docs §1.2)
MOCK_ACCOUNTS = {"PERF_ADMIN_USER": "perfadmin01", "PERF_ADMIN_PASS": "perf-pass", "PERF_PARTNER_USER": "perfuser02", "PERF_PARTNER_PASS": "perf-pass",
                 "PERF_VIEWER_USER": "perfuser03", "PERF_VIEWER_PASS": "perf-pass", "PERF_INACTIVE_USER": "inactiveuser", "PERF_INACTIVE_PASS": "inactive-pass-1",
                 "PERF_PARTNER": "P01", "PERF_IMAGE_FILE_ID": "qr-1700000000-abcd1234.png"}
# the gate as lib/thresholds.js defaults it (PERF_GATE_* in .env override it for a run)
GATE = {"p95": 300, "errPct": 1, "slowMs": 1000}


def read_dotenv(target=None):
    """PERF_* from .env, then .env.<target> (per-environment accounts), then the real environment.
    Target / host / confirmation keys are never taken from files: the target is chosen on the page,
    hosts come from PERF_STG_BASE / PERF_PROD_BASE only, and the confirmation word is typed."""
    vals = {}
    for name in [".env"] + ([f".env.{target}"] if target and target != "mock" else []):
        path = os.path.join(ROOT, name)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"^\s*(PERF_[A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
                    if m:
                        vals[m.group(1)] = m.group(2).strip("'\"")
    vals.update({k: v for k, v in os.environ.items() if k.startswith("PERF_")})
    for k in [k for k in vals if k in ("PERF_TARGET", "PERF_CONFIRM", "PERF_BASE", "PERF_TARGET_LABEL")]:
        del vals[k]
    return vals


def preset_base(target):
    """The stg / prod host from .env / .env.<target> (PERF_STG_BASE / PERF_PROD_BASE); '' when unset."""
    return (read_dotenv(target).get(f"PERF_{target.upper()}_BASE") or "").rstrip("/")


def target_env(target):
    if target == "mock":
        return dict(MOCK_ACCOUNTS, PERF_BASE=MOCK_BASE, PERF_TARGET_LABEL="local (mock)")
    if target == "local":
        env = dict(read_dotenv("local"), PERF_TARGET="local", PERF_TARGET_LABEL="local pmc-line")
        env.pop("PERF_STG_BASE", None); env.pop("PERF_PROD_BASE", None)
        return env
    if target == "custom":
        return dict(read_dotenv(), PERF_TARGET_LABEL="custom")  # PERF_BASE comes from the page per run
    env = dict(read_dotenv(target), PERF_TARGET=target)
    return env


def host_of(url):
    return re.sub(r"^[a-z]+://", "", url or "").split("/")[0].split(":")[0].lower()


def is_local_host(h):
    return h in ("127.0.0.1", "localhost", "0.0.0.0", "[::1]")


def last_custom_base():
    try:
        with open(CUSTOM_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def creds_of(env):
    """Which accounts are set (never their values): super / partner / viewer."""
    return {"super": bool(env.get("PERF_ADMIN_USER") and env.get("PERF_ADMIN_PASS")),
            "partner": bool(env.get("PERF_PARTNER_USER") and env.get("PERF_PARTNER_PASS")),
            "viewer": bool(env.get("PERF_VIEWER_USER") and env.get("PERF_VIEWER_PASS")),
            "imageId": bool(env.get("PERF_IMAGE_FILE_ID"))}


def target_meta():
    out = {"mock": {"label": TARGET_LABEL["mock"], "base": MOCK_BASE, "ok": True, "word": None, "creds": creds_of(MOCK_ACCOUNTS),
                    "note": "scripts/mock_line.py (every route of docs/api-spec-loadtest.md, 2,000 fake orders) — proves the script, not performance",
                    "noteTh": runner_th.MOCK_NOTE}}
    env = target_env("local")
    # the local accounts default to the emulator seed's when unset (lib/config.js) — say so
    c = creds_of(env)
    c = {k: True if k != "imageId" else c[k] for k in c} if not any(v for k, v in c.items() if k != "imageId") else c
    up = port_open(int(LOCAL_BASE.rsplit(":", 1)[-1])) if LOCAL_BASE.rsplit(":", 1)[-1].isdigit() else True
    out["local"] = {"label": TARGET_LABEL["local"], "base": LOCAL_BASE, "ok": up, "word": None, "creds": c,
                    "note": f"pmc-line on this machine at {LOCAL_BASE}: throwaway emulators (8085 / 4448) + the perf seed + a production build (scripts/local-stack.sh up) · accounts = the perf seed's (perfadmin01 / perfuser02 / perfuser03, perf-pass) unless .env.local says otherwise · "
                            "proves scripts and data end to end on one machine, not performance" + ("" if up else " · NOT RUNNING (\"prepare now\" boots it)"),
                    "noteTh": runner_th.LOCAL_NOTE + ("" if up else " · ยังไม่ได้เปิด (เปิด emulator และ pnpm dev ก่อน)")}
    for t in ("stg", "prod"):
        env = target_env(t)
        base = preset_base(t)
        c = creds_of(env)
        out[t] = {"label": TARGET_LABEL[t], "base": base or f"(PERF_{t.upper()}_BASE not set in .env.{t})", "ok": bool(base) and c["super"] or c["partner"],
                  "creds": c, "word": CONFIRM_WORD[t],
                  "note": (f"{TARGET_LABEL[t]} ({base or 'host not set'}) · " +
                           ("REAL CUSTOMERS AND ADMINS use it · " if t == "prod" else "shared with the team · ") +
                           f"host in .env.{t} as PERF_{t.upper()}_BASE, dedicated perf accounts as PERF_ADMIN_* / PERF_PARTNER_* / PERF_VIEWER_* · "
                           f"type {CONFIRM_WORD[t]} to select it and again for every run"),
                  "noteTh": runner_th.note(t, base, CONFIRM_WORD[t])}
    c = creds_of(read_dotenv())
    out["custom"] = {"label": TARGET_LABEL["custom"], "base": last_custom_base(), "ok": True, "word": CONFIRM_WORD["custom"], "custom": True, "creds": c,
                     "note": "any base URL typed on the page (e.g. a preview deployment, or the app on another port) · accounts from .env (PERF_ADMIN_* …) · "
                             "a localhost URL runs at once; any other host needs CUSTOM typed for every run; the STAGING / PRODUCTION hosts must use their own target",
                     "noteTh": runner_th.CUSTOM_NOTE}
    return out


def endpoint_catalogue():
    """TS-01 endpoints and their kind / who / api / db / rate / heavy, read from lib/endpoints.js (one place of truth)."""
    try:
        src = open(os.path.join(ROOT, "lib", "endpoints.js"), encoding="utf-8").read()
    except OSError:
        return []
    out = []
    fm = re.search(r"export const FOCUS = \[([^\]]*)\]", src)
    focus = set(re.findall(r"'([a-zA-Z.]+)'", fm.group(1))) if fm else set()
    for m in re.finditer(r"^\s+'([a-zA-Z.]+)': \{[^\n]*\n?\s*kind: '(\w+)', who: '(\w+)', api: '((?:[^'\\]|\\.)*)', db: '(\w+)', rate: (\d+)(,\s*heavy: true)?", src, re.M):
        out.append({"id": m.group(1), "kind": m.group(2), "who": m.group(3), "api": m.group(4).replace("\\'", "'"), "db": m.group(5),
                    "rate": int(m.group(6)), "heavy": bool(m.group(7)), "focus": m.group(1) in focus})
    return out


def requirements(case, env):
    """What a run needs besides the target: the roles it signs in as (super / partner / viewer) and the
    optional image id. Mirrors needsOf() in runner.html. The admin role is PERF_ADMIN_ROLE (super
    unless 'partner')."""
    eps = {e["id"]: e for e in endpoint_catalogue()}
    admin = "partner" if (env.get("PERF_ADMIN_ROLE") or read_dotenv().get("PERF_ADMIN_ROLE")) == "partner" else "super"

    def of(ids):
        out = set()
        for i in ids:
            e = eps.get(i)
            if not e:
                continue
            if e["who"] == "admin" or e["kind"] == "auth":
                out.add(admin)
            if e["who"] == "super":
                out.add("super")
            if i == "products.image":
                out.add("imageId")
        return out
    if case == "ts01":
        return of([env.get("PERF_ENDPOINT", "")])
    if case in ("ts01q", "check"):
        return of(env.get("ENDPOINTS", "").split(","))
    if case == "ts02":
        return set()  # public storefront only
    if case == "smoke":
        secs = env.get("PERF_SMOKE_SECTIONS") or "all"
        secs = ["public", "auth", "neg", "ts01", "order", "writes"] if secs == "all" else secs.split(",")
        out = set()
        if "ts01" in secs or "writes" in secs:
            out |= {admin, "super"}
        return out  # auth / neg skip roles that are not configured
    if case == "tsall":
        out = of(list(eps)) if env.get("TSALL_TS01", "1") != "0" else set()
        if env.get("TSALL_TS03", "1") != "0" or env.get("TSALL_TS04", "1") != "0":
            out.add(admin)
        return out
    return {admin}  # ts03, ts04, auth, soak, spike, stress


def F(key, label, default, dflt, hint, info, options=None):
    return {"key": key, "label": label, "default": default, "dflt": dflt, "hint": hint, "info": info, "options": options}


SHAPE = [
    F("PERF_RAMP", "Ramp up", "30s", "30s",
      "time from 0 to the target load — measured",
      "How long the load takes to climb from zero to the target. Requests during the ramp COUNT toward PASS/FAIL (they are tagged stage=ramp-up for the charts). Formats: 30s, 2m, 1m30s."),
    F("PERF_HOLD", "Hold", "5m", "5m",
      "steady window at the target",
      "How long the load stays at the target. PASS/FAIL (p95 ≤ the gate, error rate < the gate; a response slower than the slow gate counts as an error) is measured over the whole run: ramp up + hold + ramp down (per ladder step: its ramp + hold). Longer holds weigh the ramps less and give steadier numbers, but create more data in write scenarios."),
    F("PERF_RAMP_DOWN", "Ramp down", "30s", "30s",
      "time from the target back to 0 — measured",
      "How long the load takes to wind down after the hold. These requests count toward PASS/FAIL too (stage=ramp-down)."),
]
ROLE = F("PERF_ADMIN_ROLE", "Admin role", "", "super",
         "which cookie the admin calls carry: super (every partner) or partner (scoped)",
         "The session the admin endpoints and journeys use: super = SUPER_ADMIN (sees every partner, no ?partner=); partner = PARTNER_ADMIN (scoped to its own partners, the `in` query; PERF_PARTNER names the one used where a single code is needed). Super-only endpoints (users, partners, QR upload) always use the SUPER_ADMIN account.",
         [["", "super (SUPER_ADMIN)"], ["partner", "partner (PARTNER_ADMIN, scoped)"]])
RATE_TS01 = F("PERF_RPS", "Rate (TPS)", "", "the endpoint's own default (docs \"List Load Test\": 50 admin orders / products / dashboard, 10 orders, 20 other reads, 5 writes, 2 bcrypt calls, 1 heavy reads)",
              "TPS to the endpoint (target mode)",
              "The fixed arrival rate for the endpoint, in TPS (HTTP requests per second). k6 starts requests at this rate regardless of how fast the server answers. Leave empty for the endpoint's default (lib/endpoints.js `rate`, from the docs' priority lines). Ignored when Ladder steps is set.")
STEPS_TS01 = F("PERF_STEPS", "Ladder steps", "", "none — target mode (one rate)",
               "e.g. 25,50,100 — switches to capacity (ladder) mode",
               "A comma-separated list of rates. Each step ramps up and holds for the Hold time and is judged on its own window (its ramp + hold); the result is the highest step within the gate ('capacity'). The run stops early if a step clearly breaks (p95 > 2× the gate or errors > 5 %). Empty = target mode with one rate.")

CASES = {
    "smoke": {"label": "Smoke", "script": "scenarios/smoke.js", "steady": False,
              "desc": "1 VU, one pass through every request path, strict checks. Run first.",
              "how": "One pass, no load. Strict: every check must pass and no request may fail — it proves the SCRIPT and the environment work, not performance. Run it before any load run. The write sections create data (one order, perf products / codes / a partner / a user, images).",
              "fields": [
                  F("PERF_SMOKE_SECTIONS", "Sections", "all", "all (the page pre-fills all; the script alone defaults to public,auth,neg,ts01)",
                    "public,auth,neg,ts01,order,writes — or all",
                    "Which parts to exercise: public = GET /api/products, POST /api/discount/validate, GET /api/product-image; auth = login as every configured role + logout; neg = no cookie → 401, viewer write → 403, out-of-scope partner → 403, inactive account → 401; ts01 = every TS-01 READ endpoint once; order = ONE real order with a slip; writes = every TS-01 WRITE endpoint once. Comma-separated, or `all`."),
                  F("PERF_DEBUG", "Print failures", "1", "on",
                    "print status + body of every failed check in the k6 log",
                    "On: every failed check prints the response status and body to the log (open 'k6 log' below the results). Turn off only for very noisy runs.",
                    [["1", "on"], ["", "off"]]), ROLE]},
    "tsall": {"label": "TS-All", "script": "scripts/ts-all.sh", "steady": True,
              "desc": "The whole suite, ONE AFTER ANOTHER (never at the same time): TS-01 all endpoints → TS-02 → TS-03 → TS-04. Start it, leave, come back to the results.",
              "how": "A launcher, not a new load test: runs TS-01 Endpoint (Group Run) for all 36 endpoints (reads → auth → writes, 60 s apart; the two heavy unbounded reads are left out), then TS-02 Storefront, TS-03 Admin orders and TS-04 Dashboard, with a gap between each. Every TS uses its OWN default settings; the shared settings are the load shape (ramp up / hold / ramp down, default 30s / 5m / 30s) and the TS-01 rate (one TPS for every read endpoint, one for auth, one for writes). With everything included at the default shape this takes ≈ 4 h (TS-01 alone ≈ 3 h 40 min). A failing TS does not stop the sequence. All results share this run's id. Write parts create data (orders, perf products / codes / partners / users).",
              "fields": [
                  F("TSALL_TS01", "TS-01 Endpoint (all)", "1", "included", "34 endpoints one by one (no heavy reads), ≈ 3 h 40 min",
                    "TS-01 Endpoint (Group Run) for every endpoint except the heavy unbounded reads: reads, then auth, then writes; each at its default rate with the standard shape, 60 s between endpoints. Writes create data.", "@check"),
                  F("TSALL_TS02", "TS-02 Storefront", "1", "included", "customer orders at 10 orders/s, ≈ 6 min — creates orders",
                    "LINE OA customers placing orders at the default 10 orders/s (≈ 23 TPS): catalog → maybe a discount code → order with slip. ≈ 6 min. Creates ≈ 3,300 real orders.", "@check"),
                  F("TSALL_TS03", "TS-03 Admin orders", "1", "included", "admin order desk at 50 TPS, ≈ 6 min",
                    "The admin order desk at the default 50 TPS: list → filter → next page → slip → note / status. ≈ 6 min. Changes notes / statuses of existing orders.", "@check"),
                  F("TSALL_TS04", "TS-04 Dashboard", "1", "included", "admin dashboard at 50 TPS, ≈ 6 min",
                    "The admin dashboard at the default 50 TPS: stats + partners together, sometimes a date range. ≈ 6 min. Reads only.", "@check"),
                  F("TSALL_TS01_TPS", "TS-01 TPS (read)", "", "each endpoint's own default",
                    "rate for every read endpoint in the TS-01 part — whole number",
                    "TPS for each read endpoint in the TS-01 part (each still runs on its own, one after another). Empty = each endpoint's default (50 for the admin orders / dashboard / products lines, 20 for the rest). Auth and writes have their own boxes. Whole numbers only."),
                  F("TSALL_TS01_AUTH_TPS", "TS-01 TPS (auth)", "", "2 (the endpoint's default)",
                    "rate for the login endpoint — bcrypt, keep it low",
                    "TPS for POST /api/admin/login in the TS-01 part. Every call is a bcrypt hash (cost 12, ~100 ms CPU): this measures what a login costs, not a ceiling. Empty = 2. Whole numbers only."),
                  F("TSALL_TS01_WRITE_TPS", "TS-01 TPS (write)", "", "each endpoint's own default (10 orders / order writes, 5 other writes, 2 bcrypt-bound creates)",
                    "rate for every write endpoint in the TS-01 part — creates data",
                    "TPS for each write endpoint in the TS-01 part. Each request creates or changes a document (and a GCS file for orders / uploads), so raising it multiplies what the run leaves behind. Empty = the defaults. Whole numbers only."),
                  F("TSALL_RAMP", "Ramp up (every TS)", "30s", "30s",
                    "same ramp up for every TS — measured",
                    "The ramp up every TS uses (passed on as PERF_RAMP; for TS-01 also each ladder step's ramp). Formats: 30s, 2m, 1m30s."),
                  F("TSALL_HOLD", "Hold (every TS)", "5m", "5m",
                    "same hold for every TS — e.g. 1m for a rehearsal",
                    "The hold every TS uses (passed on as PERF_HOLD). Shorter holds make the whole sequence much shorter (TS-01 alone has 34 endpoints) but give noisier numbers; keep 5m for the real run."),
                  F("TSALL_RAMP_DOWN", "Ramp down (every TS)", "30s", "30s",
                    "same ramp down for every TS — measured",
                    "The ramp down every TS uses (passed on as PERF_RAMP_DOWN)."),
                  F("TSALL_GAP", "Gap (s)", "60", "60 s",
                    "pause between one TS and the next",
                    "Seconds between the end of one TS and the start of the next, so one test's tail never overlaps the next one's measurement. (TS-01 keeps its own 60 s gap between endpoints.)"), ROLE]},
    "ts01": {"label": "TS-01 Endpoint", "script": "scenarios/ts01-endpoint.js", "steady": True,
             "desc": "One endpoint at a fixed rate (target) or a ladder of rates. Ramps included in the measurement.",
             "how": "Tests ONE endpoint on its own. Target mode: one rate, PASS/FAIL over the whole run (ramps included). Ladder mode: several rates, reports the highest that stays within the gate. The admin cookie is obtained once in setup() (bcrypt) and shared by every VU. Write endpoints create or change a document per request (the per-VU fixtures they act on are created once, inactive).",
             "fields": [
                 F("PERF_ENDPOINT", "Endpoint", "admin.orders.list", "admin.orders.list",
                   "the endpoint to test — badge shows read / auth / write",
                   "Any entry from lib/endpoints.js. read = repeatable, consumes nothing (heavy = the unbounded admin-orders reads, every order in scope per request). auth = the bcrypt login. write = creates or changes data on every request (see what each leaves behind in the list).", "@endpoints"),
                 RATE_TS01, STEPS_TS01,
                 F("PERF_MAX_VUS", "Max VUs", "", "auto: rate × 1 + 5 (read), × 2 + 5 (auth), × 3 + 5 (write), × 10 + 5 (heavy)",
                   "upper limit of concurrent virtual users",
                   "k6 adds VUs as needed to keep the rate; this caps them. Raise only if the run reports dropped iterations."), ROLE] + SHAPE},
    "ts01q": {"label": "TS-01 Endpoint (Group Run)", "script": "scripts/ts01-queue.sh", "steady": True,
              "desc": "TS-01 Endpoint for the ticked endpoints, one after another, each at its own rate, with a gap between them (scripts/ts01-queue.sh).",
              "how": "Runs TS-01 Endpoint for every ticked endpoint, one at a time, in list order. Quick picks tick a whole group (focus = the spec's five lines / reads / heavy / auth / writes / no DB write / all / none). Each endpoint uses the rate in its TPS box, else Rate (TPS) for the rest, else its own default; \"use last passing rate\" fills the boxes from this target's latest passing TS-01 runs. The other settings apply to all. Duration ≈ endpoints × (ramp + hold × steps + ramp down) + gaps. One verdict per endpoint; the charts cover the whole run.",
              "fields": [
                  F("ENDPOINTS", "Endpoints", "", "every read endpoint ticked (no heavy reads)",
                    "tick the endpoints to run, in this order; each can have its own TPS",
                    "The endpoints to run one after another (comma-separated ids from lib/endpoints.js). The page shows a checklist with quick picks and a TPS box per endpoint. read = safe. heavy = unbounded reads (every order in scope per request): a scenario of their own, 1 TPS by default. auth = the bcrypt login. write = creates or changes data per request.", "@eplist"),
                  F("TS01_RATES", "Rate per endpoint", "", "none — every endpoint uses Rate (TPS)",
                    "id:TPS pairs from the checklist's TPS boxes",
                    "Per-endpoint rates (id:rps,…) set from the TPS box next to each endpoint; an empty box uses Rate (TPS) below (or the endpoint's default). Ignored when Ladder steps is set.", "@hidden"),
                  dict(RATE_TS01, label="Rate (TPS) for the rest", hint="for ticked endpoints with an empty TPS box (target mode)"), STEPS_TS01,
                  F("TS01_GAP", "Gap (s)", "60", "60 s",
                    "pause between endpoints",
                    "Seconds to wait after one endpoint finishes before the next starts, so one endpoint's tail never overlaps the next one's measurement."), ROLE] + SHAPE},
    "check": {"label": "Check", "script": "scenarios/check.js", "steady": False,
              "desc": "Does each ticked endpoint work? A moment at a low rate per endpoint (default 5 TPS for 1 s, no ramp), all in one k6 run — a functional check, not a measurement.",
              "how": "Every ticked endpoint for a moment at its rate (default 5 TPS for 1 s), one after another with a short gap, in ONE k6 run: the roles sign in once in setup() (bcrypt), the login endpoint itself runs last and logs in per request. PASS per endpoint = at least one of its requests ran and none answered an unexpected status; latency is shown, never gated. 15 reads ≈ 35 s. The quick pick \"no DB write\" leaves out everything that creates or changes data.",
              "fields": [
                  F("ENDPOINTS", "Endpoints", "", "every read endpoint ticked (no heavy reads)",
                    "tick the endpoints to check, in this order; each can have its own TPS",
                    "The endpoints to check one after another in one k6 run (comma-separated ids from lib/endpoints.js). Checklist with quick picks (focus = the spec's five lines, …) and a TPS box per endpoint. A write endpoint still creates / changes data per request.", "@eplist"),
                  F("TS01_RATES", "Rate per endpoint", "", "none — every endpoint uses Rate (TPS)",
                    "id:TPS pairs from the checklist's TPS boxes", "Per-endpoint rates (id:rps,…) from the TPS boxes; an empty box uses Rate (TPS).", "@hidden"),
                  F("PERF_RPS", "Rate (TPS)", "5", "5 TPS", "for ticked endpoints with an empty TPS box",
                    "Requests per second for each endpoint while it is checked (constant arrival rate, no ramp)."),
                  F("PERF_HOLD", "Each for", "1s", "1 s", "how long each endpoint is fired",
                    "How long each endpoint runs at its rate (k6 duration, e.g. 1s, 5s). Rate × this = requests per endpoint."),
                  F("CHECK_GAP", "Gap (s)", "1", "1 s", "pause after each endpoint",
                    "Seconds between endpoints, so one endpoint's slow tail never reaches the next one."), ROLE]},
    "ts02": {"label": "TS-02 Storefront", "script": "scenarios/ts02-storefront.js", "steady": True,
             "desc": "LINE OA customers: catalog → maybe a discount code → order with slip, as orders per second (docs line #1: 10 TPS on POST /api/orders). Creates real orders.",
             "how": "Each iteration = one customer: GET /api/products?partner= → with probability P a POST /api/discount/validate → POST /api/orders (multipart: payload + slip). ≈ 2.3 requests per order, so 10 orders/s ≈ 23 TPS. Orders are spread round-robin over every orderable partner, because the order number is a Firestore transaction on one counter document per partner-month (docs §3.1.1) — one partner alone is a contention test. Every order creates a real order document and uploads a slip to GCS.",
             "fields": [
                 F("PERF_ORDERS_PER_SEC", "Orders/s", "10", "10 (≈ 23 TPS)",
                   "orders placed per second — the main load knob",
                   "Orders placed per second across all partners. k6 starts a new customer at this rate whatever the server's speed. TPS ≈ orders/s × 2.3 with the other defaults. The docs' line #1 is 10 TPS on POST /api/orders."),
                 F("PERF_P_VALIDATE", "P(discount code)", "0.3", "0.3 (30 % of orders)",
                   "share of customers that check a referral code first",
                   "Probability (0–1) that the customer validates a referral code (POST /api/discount/validate, public) before ordering; when it is valid the order carries it."),
                 F("PERF_PARTNERS", "Partners", "", "every partner with an orderable product",
                   "comma list of partner codes to spread the orders over",
                   "Limits the storefront to these partner codes (comma-separated). Empty = every partner that has an active, in-stock product in GET /api/products. One partner = one order counter = a contention test."),
                 F("PERF_MAX_VUS", "Max VUs", "", "auto: orders/s × 4 + 5",
                   "upper limit of concurrent customers",
                   "k6 adds VUs as needed to keep the rate; this caps them. An order iteration lasts ≈ 1–3 s (the upload is the long call). Raise only if the run reports dropped iterations.")] + SHAPE},
    "ts03": {"label": "TS-03 Admin orders", "script": "scenarios/ts03-admin-orders.js", "steady": True,
             "desc": "The admin order desk (docs line #7: 50 TPS on GET /api/admin/orders): list → filter → next page → slip → note / status.",
             "how": "Each iteration = one admin working the list: first page (limit 10) → status filter → next page (cursor) → with probability a slip (binary from GCS), a note, a status change (alternating pending ↔ confirmed). ≈ 4 requests per iteration, so 50 TPS ≈ 12.5 iterations/s. The admin cookie is obtained once in setup() and shared by every VU (docs §2). The note / status writes change real order documents.",
             "fields": [
                 F("PERF_TARGET_RPS", "Rate (TPS)", "50", "50 TPS (≈ 12.5 iterations/s)",
                   "constant request rate",
                   "Target TPS; converted to iterations per second (÷ 4). k6 starts iterations at this rate however fast the server answers. Ignored when VUs (legacy) is set."),
                 F("PERF_MAX_VUS", "Max VUs", "60", "60",
                   "cap on concurrent admins",
                   "k6 adds VUs as needed to keep the rate, up to this. 60 keeps 12.5 iterations/s up to ~4.8 s per iteration; raise it if the run reports dropped iterations."),
                 F("PERF_VUS", "VUs (legacy)", "", "empty = fixed rate",
                   "set to switch to n VUs walking back to back",
                   "Number of VUs walking back to back instead of a fixed arrival rate; the rate is then whatever the server allows. Leave empty for the fixed rate."),
                 F("PERF_P_SLIP", "P(slip)", "0.5", "0.5", "share of iterations that open a slip", "Probability (0–1) of GET /api/admin/slip/{fileId} (binary from GCS) in an iteration."),
                 F("PERF_P_NOTE", "P(note)", "0.3", "0.3", "share of iterations that write a note", "Probability (0–1) of PATCH …/note in an iteration (changes the order's adminNote)."),
                 F("PERF_P_STATUS", "P(status)", "0.2", "0.2", "share of iterations that change a status", "Probability (0–1) of PATCH …/status in an iteration (alternates รอตรวจสอบสลิป ↔ ยืนยันแล้ว on the order)."),
                 ROLE] + SHAPE},
    "ts04": {"label": "TS-04 Dashboard", "script": "scenarios/ts04-dashboard.js", "steady": True,
             "desc": "The admin dashboard (docs line #10: 50 TPS on GET /api/admin/dashboard-stats): stats + partners together, sometimes a date range.",
             "how": "Each iteration = one dashboard load: GET /api/admin/dashboard-stats (Firestore aggregation, 30 s cache per key) and GET /api/admin/partners (read live) in parallel, then with probability P a date range (a new cache key → a real aggregation). ≈ 2.3 requests per iteration, so 50 TPS ≈ 22 loads/s. Reads only.",
             "fields": [
                 F("PERF_TARGET_RPS", "Rate (TPS)", "50", "50 TPS (≈ 22 loads/s)",
                   "constant request rate",
                   "Target TPS; converted to dashboard loads per second (÷ 2.3). Ignored when VUs (legacy) is set."),
                 F("PERF_MAX_VUS", "Max VUs", "60", "60",
                   "cap on concurrent admins",
                   "k6 adds VUs as needed to keep the rate, up to this."),
                 F("PERF_VUS", "VUs (legacy)", "", "empty = fixed rate",
                   "set to switch to n VUs walking back to back",
                   "Number of VUs loading the dashboard back to back instead of a fixed arrival rate. Leave empty for the fixed rate."),
                 F("PERF_P_RANGE", "P(date range)", "0.3", "0.3", "share of loads that pick a date range", "Probability (0–1) that the admin also loads the stats for a date range (from / to, a rotating range so the 30 s cache rarely hits)."),
                 ROLE] + SHAPE},
    "soak": {"label": "Soak", "script": "scenarios/soak.js", "steady": True,
             "desc": "The priority mix at a constant rate for a long hold (default 170 TPS = the docs' five lines together).",
             "how": "ONE request per iteration, drawn from the docs' priority lines by weight (PERF_MIX: order 10 · products 50 · admin orders 50 · dashboard 50 · admin products 10 → 170 TPS reproduces the table exactly), for a long hold, to find slow degradation. ≈ 6 % of the requests place real orders.",
             "fields": [
                 F("PERF_TARGET_RPS", "Rate (TPS)", "170", "170 TPS (the mix's total)",
                   "constant request rate",
                   "Target TPS = iterations per second (one request each)."),
                 F("PERF_MIX", "Mix", "", "order:10,products:50,orders:50,dashboard:50,catalog:10",
                   "weights of the five lines (name:weight,…)",
                   "The share of each priority line in the mix: order = POST /api/orders, products = GET /api/products, orders = GET /api/admin/orders?limit=10, dashboard = GET /api/admin/dashboard-stats, catalog = GET /api/admin/products. Weights, not TPS: at the default total they equal the docs' TPS per line."),
                 F("PERF_SOAK_HOLD", "Hold", "15m", "15m",
                   "time at the constant rate (plus ramps, all measured)",
                   "A soak's point is duration, so it has its own hold instead of the standard 5 min."),
                 F("PERF_MAX_VUS", "Max VUs", "", "auto: rate × 2 + 10", "upper limit of concurrent virtual users", "k6 adds VUs as needed to keep the rate; this caps them."),
                 ROLE, SHAPE[0], SHAPE[2]]},
    "stress": {"label": "Stress", "script": "scenarios/stress.js", "steady": True,
               "desc": "The priority mix in +50 TPS steps, each judged on its own window (the gate); stops at the first step that breaks it.",
               "how": "Steps up the priority mix by +50 TPS (50, 100, … up to the top). Each step ramps then holds and is judged on its own window. Stops at the first step that breaks the gate (p95 or errors, judged 30 s into the step). Result: the highest step within the gate, plus where p95 crossed the gate and 500 ms. Can degrade the environment and places ≈ 6 % of its requests as real orders — run last. Up to ~1 h 50 min at the defaults.",
               "fields": [
                   F("PERF_STRESS_MAX", "Top (TPS)", "1000", "1000 TPS (20 steps)",
                     "highest step: 50, 100, … up to this",
                     "The ladder goes 50, 100, 150 … up to this value. Lower it to shorten the run."),
                   F("PERF_STRESS_STEP", "Step (TPS)", "50", "50", "increment per step", "The TPS added at every step."),
                   F("PERF_STRESS_HOLD", "Hold per step", "5m", "5m",
                     "time each step holds its rate (measured with its ramp)",
                     "Each step holds this long and is judged on its own window (its ramp + hold)."),
                   F("PERF_MIX", "Mix", "", "order:10,products:50,orders:50,dashboard:50,catalog:10", "weights of the five lines (name:weight,…)", "See Soak."),
                   F("PERF_RAMP", "Ramp per step", "30s", "30s", "climb time before each step — measured with that step",
                     "How long each step takes to climb to its rate; counts toward that step's window."),
                   ROLE, SHAPE[2]]},
    "spike": {"label": "Spike", "script": "scenarios/spike.js", "steady": True,
              "desc": "0 → peak in seconds, hold; whole run gated, first 30 s at peak also shown as cold start.",
              "how": "Jumps from 0 to the peak in a few seconds (Vercel functions must scale out cold), then holds. The whole run is gated; the first 30 s at peak are also shown separately as cold start. The priority mix, ≈ 6 % real orders.",
              "fields": [
                  F("PERF_SPIKE_RPS", "Peak (TPS)", "340", "340 TPS (2 × the mix)",
                    "the rate to jump to",
                    "Peak TPS (one request per iteration)."),
                  F("PERF_SPIKE_RAMP", "Jump", "10s", "10s",
                    "how fast 0 → peak happens",
                    "The jump time; shorter = harsher spike."),
                  F("PERF_MIX", "Mix", "", "order:10,products:50,orders:50,dashboard:50,catalog:10", "weights of the five lines (name:weight,…)", "See Soak."),
                  ROLE, SHAPE[1], SHAPE[2]]},
    "auth": {"label": "Sign-in", "script": "scenarios/auth.js", "steady": True,
             "desc": "POST /api/admin/login on its own — bcrypt cost 12, so a CPU measurement, never a throughput target.",
             "how": "Logins at a constant, low rate (default 2/s), alternating the configured accounts. Each call hashes the password (bcrypt cost 12, ~100 ms of CPU on the function): the point is what a login costs, not a ceiling — docs §3.2 says never to drive it as throughput.",
             "fields": [
                 F("PERF_LOGINS_PER_SEC", "Logins/s", "2", "2",
                   "logins per second — keep it low",
                   "Logins started per second. More than 5 saturates the function's CPU by design.")] + SHAPE},
}
PARTNER = [
    F("PERF_PARTNER", "Partner", "", "the first partner with an orderable product",
      "the one partner code used where a single code is needed",
      "The partner code used where one is needed: GET /api/admin/products?partner=, the discount-code fixtures, the scoped ?partner= when the admin role is partner, the image uploads. Empty = the first partner with an active, in-stock product in GET /api/products."),
    F("PERF_PARTNERS", "Partners (storefront)", "", "every partner with an orderable product",
      "comma list of partner codes the storefront calls spread over",
      "Limits the storefront calls (GET /api/products?partner=, POST /api/discount/validate, POST /api/orders — TS-02, the mix, the TS-01 public entries) to these partner codes, comma-separated. Empty = every partner that has an active, in-stock product. One partner = one order counter = a contention test."),
]
for _c in CASES.values():
    _have = {f["key"] for f in _c["fields"]}
    _c["fields"] = _c["fields"] + [f for f in PARTNER if f["key"] not in _have]
VALUE_RE = re.compile(r"^[A-Za-z0-9_.:,/\-]{0,200}$")
LONG_VALUE_RE = re.compile(r"^[A-Za-z0-9_.:,\-]{0,4000}$")  # endpoint lists / per-endpoint rates
LONG_KEYS = ("ENDPOINTS", "TS01_RATES")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
RUN_ID_RE = re.compile(r"[^A-Za-z0-9\-]")  # no "_": it separates parts of result file names


def case_meta():
    eps = endpoint_catalogue()
    out = {}
    for k, c in CASES.items():
        fields = []
        for f in c["fields"]:
            f = dict(f)
            if f["options"] == "@check":
                f["options"], f["check"] = [["1", "include"], ["0", "skip"]], True
            elif f["options"] == "@endpoints":
                f["options"] = [[e["id"], e["id"]] for e in eps]
                f["kinds"] = {e["id"]: e["kind"] for e in eps}
                f["who"] = {e["id"]: e["who"] for e in eps}
                f["db"] = {e["id"]: e["db"] for e in eps}  # none | cache | write (lib/endpoints.js)
                f["api"] = {e["id"]: e["api"] for e in eps}
                f["rates"] = {e["id"]: e["rate"] for e in eps}
                f["heavy"] = {e["id"]: e["heavy"] for e in eps}
                f["focus"] = {e["id"]: e["focus"] for e in eps}  # the spec's five "List Load Test" lines
            elif f["options"] in ("@eplist", "@hidden"):
                f[f["options"][1:]] = True
                f["options"] = None
            f["th"] = runner_th.field(k, f["key"])
            fields.append(f)
        th = runner_th.CASES.get(k, {})
        out[k] = {"label": c["label"], "desc": c["desc"], "how": c["how"], "fields": fields, "steady": c["steady"],
                  "th": {"desc": th.get("desc"), "how": th.get("how")}}
    return out


def settings_markdown():
    """docs/runner-settings.md — generated from CASES so the page and the doc never drift."""
    out = ["# Runner settings", "",
           "Generated by `python3 tools/runner.py --settings-md > docs/runner-settings.md` (`npm run settings-md`) from the",
           "settings table in `tools/runner.py` — edit there, then regenerate. The runner page shows the",
           "same text (each field's default under the input; full explanations in \"What do these",
           "settings mean?\").", "",
           "**PASS/FAIL** for every load scenario is exactly two conditions over the whole run (ramp up +",
           f"hold + ramp down): **p95 ≤ {GATE['p95']} ms** and **error rate < {GATE['errPct']} %**, where a response slower than {GATE['slowMs'] / 1000:g} s",
           "counts as an error (lib/thresholds.js GATE; PERF_GATE_P95 / PERF_GATE_ERR / PERF_GATE_SLOW_MS override it). Everything else is reported only.",
           "Empty field = the script's default (shown below). Durations: `30s`, `5m`, `1m30s`.", ""]
    for k, c in CASES.items():
        out += [f"## {c['label']}", "", c["how"], "",
                "| Setting | Default | What it does |", "|---|---|---|"]
        for f in c["fields"]:
            info = f["info"].replace("|", "\\|")
            if f.get("options") and f["options"] not in ("@endpoints", "@check", "@eplist", "@hidden"):
                info += " Options: " + ", ".join(f"`{v}` = {l}" if v else f"(empty) = {l}" for v, l in f["options"]) + "."
            out.append(f"| **{f['label']}** (`{f['key']}`) | {f['dflt']} | {info} |")
        out.append("")
    out += ["## TS-01 endpoints", "", "From `lib/endpoints.js` (the ids the Endpoint / Endpoints fields take). `rate` = the default TPS.", "",
            "| id | kind | who | default TPS | leaves in the DB | request |", "|---|---|---|---|---|---|"]
    # (★ = one of the spec's five focus lines)
    for e in endpoint_catalogue():
        api_txt = e["api"].replace("|", "\\|")
        out.append(f"| `{e['id']}`{' ★' if e['focus'] else ''} | {e['kind']}{' (heavy)' if e['heavy'] else ''} | {e['who']} | {e['rate']} | {e['db']} | {api_txt} |")
    out.append("")
    return "\n".join(out)


# ---- Live aggregation (k6 --out json → per-second buckets) ------------------------------
TS_RE = re.compile(r'"time":"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)[.\d]*(Z|([+-])(\d\d):(\d\d))"')


def pct(vals, p):
    if not vals:
        return None
    vals.sort()
    return round(vals[min(len(vals) - 1, int(len(vals) * p))], 1)


class Live:
    """Tails every *.json in results/_live/ and closes one bucket per second: requests,
    failures, p50/p95, statuses, VUs, dropped iterations, dominant endpoint tag and phase."""

    def __init__(self, run_id, slow_ms):
        self.run_id = run_id
        self.slow_ms = slow_ms
        self.lock = threading.Lock()
        self.pos, self.rest, self.buckets, self.series = {}, {}, {}, []
        self.last = None
        self.total = {"n": 0, "fail": 0, "st": {}}
        self.fails = {}  # (name, status) → {n, first, last}
        self.errs = {}  # err_detail: (name, status, code, src, msg) → {n, first, last}
        self.errs_min = {}  # (minute, name, status, code, src) → n
        self.done = False
        os.makedirs(LIVE_DIR, exist_ok=True)
        for f in glob.glob(os.path.join(LIVE_DIR, "*.json")):
            try:
                os.remove(f)
            except OSError:
                pass
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def bucket(self, sec):
        b = self.buckets.get(sec)
        if b is None:
            b = self.buckets[sec] = {"n": 0, "fail": 0, "st": {}, "d": [], "ep": {}, "ph": {}, "sg": {}, "vus": None, "drop": 0}
        return b

    def feed(self, line):
        if '"type":"Point"' not in line:
            return
        if '"metric":"http_req_duration"' in line:
            kind = "d"
        elif '"metric":"vus"' in line:
            kind = "v"
        elif '"metric":"dropped_iterations"' in line:
            kind = "x"
        elif '"metric":"err_detail"' in line:
            kind = "e"
        else:
            return
        m = TS_RE.search(line)
        if not m:
            return
        y, mo, d, h, mi, se = (int(x) for x in m.groups()[:6])
        sec = calendar.timegm((y, mo, d, h, mi, se, 0, 0, 0))
        if m.group(7) != "Z":
            off = int(m.group(9)) * 3600 + int(m.group(10)) * 60
            sec -= off if m.group(8) == "+" else -off
        if self.last is not None and sec <= self.last:
            sec = self.last + 1  # late point for a closed second → next second
        j = json.loads(line)["data"]
        if kind == "e":  # classified failure (lib/errors.js)
            t = j.get("tags") or {}
            key = (t.get("name", ""), t.get("status", ""), t.get("code", ""), t.get("src", ""), t.get("msg", ""))
            e = self.errs.setdefault(key, {"n": 0, "first": sec, "last": sec})
            e["n"] += j["value"]
            e["first"], e["last"] = min(e["first"], sec), max(e["last"], sec)
            mk = (sec - sec % 60,) + key[:4]
            self.errs_min[mk] = self.errs_min.get(mk, 0) + j["value"]
            return
        b = self.bucket(sec)
        if kind == "v":
            b["vus"] = j["value"]
        elif kind == "x":
            b["drop"] += j["value"]
        else:
            t = j.get("tags") or {}
            st, name, ph, sg = t.get("status", "?"), t.get("name", ""), t.get("phase", ""), t.get("stage", "")
            b["n"] += 1
            b["d"].append(j["value"])
            b["st"][st] = b["st"].get(st, 0) + 1
            if ph:
                b["ph"][ph] = b["ph"].get(ph, 0) + 1
            if sg:
                b["sg"][sg] = b["sg"].get(sg, 0) + 1
            # Same rule as the gate (lib/http.js req_failed): an HTTP error, or slower than the slow gate.
            http_failed = t.get("expected_response") == "false"
            if http_failed or j["value"] > self.slow_ms:
                b["fail"] += 1
                f = self.fails.setdefault((name, st if http_failed else f"> {self.slow_ms / 1000:g} s"), {"n": 0, "first": sec, "last": sec})
                f["n"] += 1
                f["last"] = max(f["last"], sec)
            if name and not name.startswith("prep."):  # prep.* = setup steps, not the measured call
                b["ep"][name] = b["ep"].get(name, 0) + 1

    def read(self):
        for f in sorted(glob.glob(os.path.join(LIVE_DIR, "*.json")), key=os.path.getmtime):
            try:
                with open(f, "r", encoding="utf-8", errors="replace") as fh:
                    fh.seek(self.pos.get(f, 0))
                    chunk = fh.read(8 * 1024 * 1024)
                    self.pos[f] = fh.tell()
            except OSError:
                continue
            if not chunk:
                continue
            lines = (self.rest.get(f, "") + chunk).split("\n")
            self.rest[f] = lines.pop()
            for line in lines:
                try:
                    self.feed(line)
                except Exception:
                    pass

    def close_until(self, until):
        for sec in sorted(k for k in self.buckets if k < until):
            b = self.buckets.pop(sec)
            if self.last is not None:  # fill silent seconds (gaps between endpoints in a group run)
                for gap in range(self.last + 1, min(sec, self.last + 600)):
                    self.series.append({"t": gap, "n": 0, "fail": 0, "p50": None, "p95": None, "st": {}, "ep": None, "ph": None, "sg": None, "vus": None, "drop": 0})
            top = lambda d: max(d, key=d.get) if d else None
            self.series.append({"t": sec, "n": b["n"], "fail": b["fail"], "p50": pct(b["d"], 0.5), "p95": pct(b["d"], 0.95),
                                "st": b["st"], "ep": top(b["ep"]), "ph": top(b["ph"]), "sg": top(b["sg"]), "vus": b["vus"], "drop": b["drop"]})
            self.total["n"] += b["n"]
            self.total["fail"] += b["fail"]
            for k, v in b["st"].items():
                self.total["st"][k] = self.total["st"].get(k, 0) + v
            self.last = sec

    def loop(self):
        while True:
            with self.lock:
                self.read()
                self.close_until(int(time.time()) - 1)
                if self.done:
                    self.read()
                    self.close_until(10 ** 12)
                    break
            time.sleep(0.5)
        for f in glob.glob(os.path.join(LIVE_DIR, "*.json")):
            try:
                os.remove(f)
            except OSError:
                pass

    def fail_list(self):
        out = [{"name": k[0], "status": k[1], "n": v["n"], "first": v["first"], "last": v["last"]} for k, v in self.fails.items()]
        return sorted(out, key=lambda x: -x["n"])

    def err_list(self):
        out = [{"name": k[0], "status": k[1], "code": k[2], "src": k[3], "msg": k[4], "n": v["n"], "first": v["first"], "last": v["last"]}
               for k, v in self.errs.items()]
        return sorted(out, key=lambda x: -x["n"])

    def err_minutes(self):
        out = [{"t": k[0], "name": k[1], "status": k[2], "code": k[3], "src": k[4], "n": v} for k, v in self.errs_min.items()]
        return sorted(out, key=lambda x: (x["t"], -x["n"]))

    def snapshot(self, frm):
        with self.lock:
            return {"series": self.series[frm:], "len": len(self.series), "total": self.total, "done": self.done, "fails": self.fail_list(), "errs": self.err_list(),
                    "errsMin": self.err_minutes()}

    def save(self, info):
        self.thread.join(timeout=30)
        keep = {k: info.get(k) for k in ("runId", "case", "target", "env", "start", "end", "date")}
        with self.lock:
            data = {"info": keep, "series": self.series, "total": self.total, "fails": self.fail_list(),
                    "errs": self.err_list(), "errsMin": self.err_minutes()}
        if data["series"]:
            with open(os.path.join(RESULTS, f"{self.run_id}_live.json"), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


# ---- Results (our verdict.json files) ---------------------------------------------------


def read_verdicts(run_id):
    out = []
    for p in sorted(glob.glob(os.path.join(RESULTS, f"{glob.escape(run_id)}_*verdict.json"))):
        try:
            with open(p, encoding="utf-8") as f:
                v = json.load(f)
        except (OSError, ValueError):
            continue
        tags = sorted(({"tag": k, **t} for k, t in (v.get("perTag") or {}).items() if t.get("count")),
                      key=lambda x: -(x.get("p95") or 0))
        out.append({"file": os.path.basename(p), "scenario": v.get("scenario"), "pass": v.get("pass"), "window": v.get("window"),
                    "requests": v.get("requests"), "rps": v.get("rps"), "p95": v.get("p95"), "p99": v.get("p99"),
                    "max": v.get("max"), "errRate": v.get("errRate"), "failed": v.get("failedThresholds") or [],
                    "tags": tags, "steps": v.get("steps"), "endpoint": v.get("endpoint"), "mode": v.get("mode"),
                    "targetFloor": v.get("targetFloor"), "targetMet": v.get("targetMet"), "targetRps": v.get("targetRps"),
                    "ordersPlaced": v.get("ordersPlaced"),
                    "files": {ext: os.path.basename(p.replace("_verdict.json", ext)) for ext in
                              ("_report.html", "_results.csv", "_report.png", "_summary.json")
                              if os.path.exists(p.replace("_verdict.json", ext))},
                    "capacityRps": v.get("capacityRps"), "measured": v.get("measured")})
    return out


def last_pass(target):
    """Highest rate each TS-01 endpoint passed on this target, from its latest verdict that
    passed a step: {id: {rps, runId, time, mode}}. Only runner run ids (<target>-…) count."""
    out = {}
    paths = glob.glob(os.path.join(RESULTS, f"{glob.escape(target)}-*_ts01-*_verdict.json"))
    for p in sorted(paths, key=os.path.getmtime, reverse=True):
        try:
            with open(p, encoding="utf-8") as f:
                v = json.load(f)
        except (OSError, ValueError):
            continue
        ep, steps = v.get("endpoint"), v.get("steps") or []
        if not ep or ep in out:
            continue
        ok = [s for s in steps if s.get("pass")]
        rps = (v.get("capacityRps") or 0) if v.get("mode") == "ladder" else (ok[0].get("offered") if ok else 0)
        if rps:
            out[ep] = {"rps": rps, "runId": os.path.basename(p).split("_", 1)[0], "mode": v.get("mode"),
                       "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(p)))}
    return out


def read_sheet(run_id):
    """Every <run>_*results.csv of a run (one per scenario / endpoint) as one table."""
    head, rows = [], []
    for p in sorted(glob.glob(os.path.join(RESULTS, f"{glob.escape(run_id)}_*results.csv")), key=os.path.getmtime):
        try:
            with open(p, encoding="utf-8", newline="") as f:
                data = list(csv.reader(f))
        except OSError:
            continue
        if not data:
            continue
        head = head or data[0]
        rows += [r for r in data[1:] if r]
    return {"head": head, "rows": rows}


def history():
    runs = {}
    for p in glob.glob(os.path.join(RESULTS, "*_verdict.json")) + glob.glob(os.path.join(RESULTS, "*_live.json")):
        name = os.path.basename(p)
        rid = name.split("_", 1)[0] if name.endswith("_live.json") else re.sub(r"_[^_]+_round-\d+_verdict\.json$", "", name)
        r = runs.setdefault(rid, {"runId": rid, "mtime": 0, "live": False, "verdicts": 0, "pass": True, "report": None, "png": False, "csv": False})
        r["mtime"] = max(r["mtime"], os.path.getmtime(p))
        if name.endswith("_live.json"):
            r["live"] = True
        else:
            r["verdicts"] += 1
            rep = p.replace("_verdict.json", "_report.html")
            if os.path.exists(rep) and not r["report"]:
                r["report"] = os.path.basename(rep)
            r["png"] = r["png"] or os.path.exists(p.replace("_verdict.json", "_report.png"))
            r["csv"] = r["csv"] or os.path.exists(p.replace("_verdict.json", "_results.csv"))
            try:
                with open(p, encoding="utf-8") as f:
                    r["pass"] = r["pass"] and bool(json.load(f).get("pass"))
            except (OSError, ValueError):
                pass
    items = sorted(runs.values(), key=lambda x: -x["mtime"])[:200]
    for it in items:
        it["time"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(it["mtime"]))
        m = re.match(r"^(?:mock|local|stg|prod|custom)-([a-z0-9]+)-\d{4}-\d{6}$", it["runId"])  # runner run ids: <target>-<case>-<mmdd-hhmmss>
        it["case"] = m.group(1) if m and m.group(1) in CASES else ""
        lv = os.path.join(RESULTS, f"{it['runId']}_live.json")
        if os.path.exists(lv):
            try:
                with open(lv, encoding="utf-8") as f:
                    m = re.search(r'"case":"([a-z0-9]+)"', f.read(3000))
                it["case"] = m.group(1) if m else it["case"]
            except OSError:
                pass
    return items


# ---- Run lifecycle ----------------------------------------------------------------------


class Run:
    def __init__(self):
        self.lock = threading.Lock()
        self.proc, self.info, self.log = None, None, []

    def running(self):
        return self.proc is not None and self.proc.poll() is None


RUN = Run()
LIVE = {"obj": None}
MOCK = {"proc": None}


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_mock():
    if port_open(MOCK_PORT):
        return
    MOCK["proc"] = subprocess.Popen([sys.executable, os.path.join(ROOT, "scripts", "mock_line.py"), str(MOCK_PORT)],
                                    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        if port_open(MOCK_PORT):
            return
        time.sleep(0.1)
    raise RuntimeError("the mock did not start (scripts/mock_line.py)")


# ---- Report post-processing (err_section / inject_errors / screenshot) ------------------------
SRC_LABEL = {
    "vercel": ("Vercel edge", "the platform answered, not the app (function timeout 504, payload 413, WAF / deployment protection, 502 invocation failed)"),
    "backend": ("pmc-line route", "the app's own error envelope ({success:false, error}) — validation, auth, scoping, Firestore / GCS"),
    "network": ("network / k6", "no response: timeout, connection reset, DNS"),
    "other": ("other", "a response that matched none of the above"),
}


def _e(x):
    return str(x).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def err_section(errs, mins=None):
    """Error-detail block inserted into a report.html (between markers, so it can be redone)."""
    hm = lambda t: time.strftime("%H:%M:%S", time.localtime(t))
    if not errs:
        body = '<div class="card" style="padding:12px 14px">No failed requests.</div>'
    else:
        total = sum(x["n"] for x in errs) or 1
        by_src = {}
        for x in errs:
            by_src[x["src"]] = by_src.get(x["src"], 0) + x["n"]
        src_rows = "".join(f'<tr><td class="l"><b>{_e(SRC_LABEL.get(k, (k, ""))[0])}</b></td><td>{int(v):,}</td><td>{v * 100 / total:.1f} %</td>'
                           f'<td class="l" style="white-space:normal">{_e(SRC_LABEL.get(k, ("", ""))[1])}</td></tr>'
                           for k, v in sorted(by_src.items(), key=lambda kv: -kv[1]))
        rows = "".join(f'<tr><td class="l">{_e(x["name"])}</td><td>{_e(x["status"])}</td><td class="l"><code>{_e(x["code"])}</code></td>'
                       f'<td class="l">{_e(SRC_LABEL.get(x["src"], (x["src"], ""))[0])}</td><td class="l" style="white-space:normal;max-width:360px">{_e(x["msg"])}</td>'
                       f'<td>{int(x["n"]):,}</td><td>{hm(x["first"])}–{hm(x["last"])}</td></tr>' for x in errs[:50])
        body = (f'<div class="card"><table><thead><tr><th class="l">failed at</th><th>count</th><th>%</th><th class="l">meaning</th></tr></thead><tbody>{src_rows}</tbody></table></div>'
                f'<div class="card" style="margin-top:10px"><table><thead><tr><th class="l">tag</th><th>status</th><th class="l">error code</th><th class="l">failed at</th>'
                f'<th class="l">message</th><th>count</th><th>time</th></tr></thead><tbody>{rows}</tbody></table></div>'
                + (f'<div class="meta" style="margin-top:6px">first 50 of {len(errs)} kinds</div>' if len(errs) > 50 else ""))
        if mins:
            mrows = "".join(f'<tr><td class="l">{time.strftime("%H:%M", time.localtime(x["t"]))}</td><td class="l">{_e(x["name"])}</td><td>{_e(x["status"])}</td>'
                            f'<td class="l"><code>{_e(x["code"])}</code></td><td class="l">{_e(SRC_LABEL.get(x["src"], (x["src"], ""))[0])}</td><td>{int(x["n"]):,}</td></tr>'
                            for x in mins[:200])
            body += (f'<h2>Errors per minute</h2><div class="card"><table><thead><tr><th class="l">minute</th><th class="l">tag</th><th>status</th>'
                     f'<th class="l">error code</th><th class="l">failed at</th><th>count</th></tr></thead><tbody>{mrows}</tbody></table></div>')
    return ('<!--err-detail--><h2>Error detail</h2>' + body +
            '<div class="meta" style="margin-top:6px">Every failed check over the whole run, classified by where it failed (lib/errors.js). '
            'Tags starting with prep. are setup steps (login, fixtures), not the measured call. Added by tools/runner.py.</div><!--/err-detail-->')


def run_window(summary_path):
    """(start, end) epoch seconds of one k6 run, from its summary file."""
    try:
        end = os.path.getmtime(summary_path)
        with open(summary_path, encoding="utf-8") as f:
            dur = json.load(f)["state"]["testRunDurationMs"] / 1000
        return end - dur - 5, end + 5
    except (OSError, ValueError, KeyError):
        return None


def inject_errors(run_id, errs, mins=None):
    """Insert the Error detail into every report.html of this run. A group run has one report
    per endpoint: each gets the errors whose time falls inside that endpoint's own run."""
    reports = sorted(glob.glob(os.path.join(RESULTS, f"{glob.escape(run_id)}_*report.html")))
    for path in reports:
        mine, mine_min = errs, mins or []
        if len(reports) > 1:
            win = run_window(path.replace("_report.html", "_summary.json"))
            if win:
                mine = [x for x in errs if x["last"] >= win[0] and x["first"] <= win[1]]
                mine_min = [x for x in (mins or []) if win[0] - 60 <= x["t"] <= win[1]]
        with open(path, encoding="utf-8") as f:
            html = f.read()
        html = re.sub(r"<!--err-detail-->.*?<!--/err-detail-->", "", html, flags=re.S)
        sec = err_section(mine, mine_min)
        for mark in ('<h2>Settings of this run</h2>', '<div class="foot">', "</main>"):
            if mark in html:
                html = html.replace(mark, sec + mark, 1)
                break
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)


ICT = 7 * 3600  # Thai time (UTC+7, no DST): the CSV's Date / Start time / End time (lib/report.js)
SRC_SHORT = {"backend": "pmc-line", "vercel": "Vercel", "network": "network", "other": "other"}
NOTE_MARK = " · errors: "


def _ict(sec, fmt="%H:%M"):
    return time.strftime(fmt, time.gmtime(sec + ICT))


def _row_window(row, idx):
    try:
        d, a, b = row[idx["Date"]], row[idx["Start time"]], row[idx["End time"]]
        if not (d and a and b):
            return None
        start = calendar.timegm(time.strptime(f"{d} {a}", "%Y-%m-%d %H:%M:%S")) - ICT
        end = calendar.timegm(time.strptime(f"{d} {b}", "%Y-%m-%d %H:%M:%S")) - ICT
        return start, end + (86400 if end < start else 0)
    except (KeyError, IndexError, ValueError):
        return None


def inject_csv_notes(run_id, errs, errs_min=None):
    """Append error codes, where they failed and when to the Notes of each results.csv row. A tag
    row takes that tag's errors, the blended row takes all of them, both limited to the row's own
    window. Re-running replaces what an earlier pass appended."""
    for path in sorted(glob.glob(os.path.join(RESULTS, f"{glob.escape(run_id)}_*results.csv"))):
        with open(path, encoding="utf-8", newline="") as f:
            data = list(csv.reader(f))
        if len(data) < 2 or "Notes" not in data[0]:
            continue
        idx = {h: i for i, h in enumerate(data[0])}
        file_win = run_window(path.replace("_results.csv", "_summary.json"))
        rows_here = {r[idx["Row"]] for r in data[1:] if len(r) > idx["Row"]}
        for row in data[1:]:
            if len(row) <= idx["Notes"]:
                continue
            win = _row_window(row, idx) or file_win
            tag = row[idx["Row"]]
            mine = [x for x in errs if (tag == "ALL requests" or x["name"] == tag)
                    and (win is None or (x["last"] >= win[0] - 5 and x["first"] <= win[1] + 5))]
            note = row[idx["Notes"]].split(NOTE_MARK)[0]
            if note.startswith("errors: "):
                note = ""

            def summary(xs, with_tag):
                groups = {}
                for x in xs:
                    k = ((x["name"],) if with_tag else ()) + (x["status"], x["code"], x["src"])
                    g = groups.setdefault(k, {"n": 0, "first": x["first"], "last": x["last"]})
                    g["n"] += x["n"]
                    g["first"], g["last"] = min(g["first"], x["first"]), max(g["last"], x["last"])
                parts = []
                for k, g in sorted(groups.items(), key=lambda kv: -kv[1]["n"])[:5]:
                    *tag_, st, code, src = k
                    when = _ict(g["first"]) if _ict(g["first"]) == _ict(g["last"]) else f"{_ict(g['first'])}–{_ict(g['last'])}"
                    parts.append(f"{(tag_[0] + ' ') if tag_ else ''}{st}{'' if code == '-' else ' ' + code}×{g['n']:,} ({SRC_SHORT.get(src, src)}, {when})")
                return "; ".join(parts)
            if mine:
                note = (note + NOTE_MARK if note else "errors: ") + summary(mine, tag == "ALL requests")
            # a tag row also says what else failed in its window — the login / fixture calls in front of it
            others = [dict(x, first=x["t"], last=x["t"] + 59) for x in (errs_min or [])
                      if tag != "ALL requests" and x["name"] not in rows_here and not x["status"].startswith(">")
                      and win is not None and win[1] - win[0] >= 60 and x["t"] + 59 >= win[0] and x["t"] <= win[1]]
            if others:
                note = (note + NOTE_MARK if note else "errors: ") + "other requests in the same minutes: " + summary(others, True)
            row[idx["Notes"]] = note
        with open(path, "w", encoding="utf-8", newline="") as f:
            csv.writer(f, lineterminator="\n").writerows(data)


def find_chrome():
    for c in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]:
        if os.path.exists(c):
            return c
    for n in ["google-chrome", "chromium", "chromium-browser"]:
        for d in os.environ.get("PATH", "").split(os.pathsep):
            if os.access(os.path.join(d, n), os.X_OK):
                return os.path.join(d, n)
    return None


def screenshot(report_path):
    """PNG of a report.html (headless Chrome), for slides / chat. None if Chrome is missing."""
    chrome = find_chrome()
    if not chrome or not os.path.exists(report_path):
        return None
    out = report_path.replace("_report.html", "_report.png")
    try:
        with open(report_path, encoding="utf-8") as f:
            rows = f.read().count("<tr")
    except OSError:
        rows = 0
    height = max(1300, min(8000, 600 + rows * 34))
    try:
        subprocess.run([chrome, "--headless", "--disable-gpu", "--hide-scrollbars", f"--window-size=1200,{height}",
                        f"--screenshot={out}", "file://" + report_path + "#light"], timeout=60,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        return None
    return out if os.path.exists(out) else None


def watch(proc, info):
    for line in proc.stdout:
        line = ANSI_RE.sub("", line.rstrip("\n"))
        with RUN.lock:
            RUN.log.append(line)
            if len(RUN.log) > 4000:
                del RUN.log[:1000]
    proc.wait()
    lv = LIVE["obj"]
    if lv:
        time.sleep(1)
        with lv.lock:
            lv.done = True
    info["end"] = time.strftime("%H:%M:%S")
    info["endedAt"] = time.time()
    if lv:
        try:
            lv.save(info)
        except Exception as e:
            RUN.log.append(f"[runner] could not save the live series: {e}")
        try:
            inject_errors(info["runId"], lv.err_list(), lv.err_minutes())
        except Exception as e:
            RUN.log.append(f"[runner] could not add Error detail to the report: {e}")
        try:
            inject_csv_notes(info["runId"], lv.err_list(), lv.err_minutes())
        except Exception as e:
            RUN.log.append(f"[runner] could not add error detail to results.csv: {e}")
    for rep in sorted(glob.glob(os.path.join(RESULTS, f"{glob.escape(info['runId'])}_*report.html"))):
        if not screenshot(rep):
            RUN.log.append("[runner] no report screenshot (Google Chrome not found)")
            break
    info["exit"] = proc.returncode
    info["verdicts"] = read_verdicts(info["runId"])
    info["done"] = True
    try:  # so "Latest run" survives a runner restart
        with open(LAST_RUN, "w", encoding="utf-8") as f:
            json.dump(info, f, ensure_ascii=False)
    except (OSError, TypeError):
        pass


def gate_of(env):
    """The gate this run will use (PERF_GATE_* in .env override lib/thresholds.js's defaults)."""
    g = dict(GATE)
    try:
        if env.get("PERF_GATE_P95"):
            g["p95"] = float(env["PERF_GATE_P95"])
        if env.get("PERF_GATE_ERR"):
            g["errPct"] = float(env["PERF_GATE_ERR"]) * 100
        if env.get("PERF_GATE_SLOW_MS"):
            g["slowMs"] = float(env["PERF_GATE_SLOW_MS"])
    except ValueError:
        pass
    return g


def start_run(body):
    case, target = body.get("case"), body.get("target")
    if case not in CASES:
        raise ValueError(f"unknown scenario {case}")
    if target not in ("mock", "local", "stg", "prod", "custom"):
        raise ValueError(f"unknown target {target}")
    custom_base = ""
    if target == "custom":
        custom_base = str(body.get("baseUrl") or "").strip().rstrip("/")
        if not CUSTOM_RE.match(custom_base):
            raise ValueError("custom URL: http(s)://host[:port][/path], e.g. https://line-order-preview.vercel.app")
        h = host_of(custom_base)
        for t in ("stg", "prod"):
            if preset_base(t) and host_of(preset_base(t)) == h:
                raise ValueError(f"{custom_base} is the {TARGET_LABEL[t]} host — pick the {TARGET_LABEL[t]} target (its own typed word)")
        if not is_local_host(h) and body.get("confirmText") != CONFIRM_WORD["custom"]:
            raise ValueError(f"custom URL on a remote host: type {CONFIRM_WORD['custom']} to confirm this run")
    elif target in CONFIRM_WORD and body.get("confirmText") != CONFIRM_WORD[target]:
        raise ValueError(f"{TARGET_LABEL[target]}: type {CONFIRM_WORD[target]} to confirm this run (scheduled, team informed)")
    c = CASES[case]
    allowed = {f["key"] for f in c["fields"]}
    env = {}
    for k, v in (body.get("env") or {}).items():
        v = str(v).strip()
        if v == "":
            continue
        if k not in allowed:
            raise ValueError(f"{case} does not take {k}")
        if not (LONG_VALUE_RE if k in LONG_KEYS else VALUE_RE).match(v):
            raise ValueError(f"{k}: characters not allowed")
        env[k] = v
    ids = {e["id"] for e in endpoint_catalogue()}
    if case == "ts01" and env.get("PERF_ENDPOINT") not in ids:
        raise ValueError("pick an endpoint from the list")
    if case in ("ts01q", "check"):
        pick = [x for x in env.get("ENDPOINTS", "").split(",") if x]
        if not pick:
            raise ValueError("tick at least one endpoint")
        if any(x not in ids for x in pick):
            raise ValueError("unknown endpoint in the list")
        for pair in [x for x in env.get("TS01_RATES", "").split(",") if x]:
            ep, _, r = pair.partition(":")
            if ep not in pick or not re.match(r"^\d+$", r) or int(r) <= 0:
                raise ValueError(f"bad rate {pair} (id:TPS for a ticked endpoint, whole number)")
    if env.get("CHECK_GAP") and not re.match(r"^\d{1,3}$", env["CHECK_GAP"]):
        raise ValueError("CHECK_GAP: whole seconds, e.g. 1")
    for k in ("TSALL_TS01_TPS", "TSALL_TS01_AUTH_TPS", "TSALL_TS01_WRITE_TPS", "PERF_RPS", "PERF_ORDERS_PER_SEC", "PERF_TARGET_RPS", "PERF_STRESS_MAX", "PERF_STRESS_STEP", "PERF_SPIKE_RPS", "PERF_LOGINS_PER_SEC"):
        if env.get(k) and (not re.match(r"^\d+$", env[k]) or int(env[k]) <= 0):
            raise ValueError(f"{k}: a whole number of TPS, e.g. 50")
    for k in ("PERF_PARTNER", "PERF_PARTNERS"):
        if env.get(k) and not re.match(r"^[A-Za-z0-9_-]{1,40}(,[A-Za-z0-9_-]{1,40})*$", env[k]):
            raise ValueError(f"{k}: partner codes (A-Z 0-9 _ -), comma-separated")
    if env.get("PERF_PARTNER") and "," in env["PERF_PARTNER"]:
        raise ValueError("PERF_PARTNER: one code (PERF_PARTNERS takes the list)")
    for k in ("PERF_P_VALIDATE", "PERF_P_SLIP", "PERF_P_NOTE", "PERF_P_STATUS", "PERF_P_RANGE"):
        if env.get(k) and not re.match(r"^(0(\.\d+)?|1(\.0+)?)$", env[k]):
            raise ValueError(f"{k}: a probability 0–1, e.g. 0.3")
    if env.get("PERF_MIX") and not re.match(r"^(order|products|orders|dashboard|catalog):\d+(,(order|products|orders|dashboard|catalog):\d+)*$", env["PERF_MIX"]):
        raise ValueError("PERF_MIX: name:weight pairs, e.g. order:10,products:50,orders:50,dashboard:50,catalog:10")
    real = bool(body.get("real")) and target in ("stg", "prod", "custom")  # local / mock runs never go to the results sheet
    if real and not body.get("announced"):
        raise ValueError("real run: tick \"Announced in the team chat\" first")
    run_id = RUN_ID_RE.sub("", body.get("runId") or "") or f"{target}-{case}-{time.strftime('%m%d-%H%M%S')}"

    with RUN.lock:
        if RUN.running():
            raise ValueError("a run is in progress — stop it or wait")
        if PREP.info and not PREP.info.get("done"):
            raise ValueError("the local app is being prepared — wait for it to finish")
        base = target_env(target)
        if target in ("stg", "prod") and not preset_base(target):
            raise ValueError(f"{target}: set PERF_{target.upper()}_BASE (the app's URL) in .env.{target}")
        if target != "mock":
            need, c_ok = requirements(case, env), creds_of(base)
            local_like = target == "local" or (target == "custom" and is_local_host(host_of(custom_base)))
            if local_like and not any(c_ok[r] for r in ("super", "partner", "viewer")):
                c_ok = {"super": True, "partner": True, "viewer": True, "imageId": c_ok["imageId"]}  # the seed's defaults (lib/config.js)
            for role, var in (("super", "PERF_ADMIN_USER + PERF_ADMIN_PASS (a SUPER_ADMIN)"), ("partner", "PERF_PARTNER_USER + PERF_PARTNER_PASS (a PARTNER_ADMIN)"), ("viewer", "PERF_VIEWER_USER + PERF_VIEWER_PASS")):
                if role in need and not c_ok[role]:
                    raise ValueError(f"{target}: this run signs in as {role} — set {var} in .env or .env.{target}")
            if "imageId" in need and not c_ok["imageId"]:
                raise ValueError(f"{target}: products.image needs PERF_IMAGE_FILE_ID (a QR / product file id) in .env.{target}")
        if target == "custom":
            base["PERF_BASE"] = custom_base
            if not is_local_host(host_of(custom_base)):
                base["PERF_CONFIRM"] = CONFIRM_WORD["custom"]  # typed on the page for this run
            try:
                with open(CUSTOM_FILE, "w", encoding="utf-8") as f:
                    f.write(custom_base)
            except OSError:
                pass
        if target == "mock":
            ensure_mock()
        if target == "local":
            rows = local_checks()
            bad = [r for r in rows if r["need"] and not r["ok"]]
            if bad:
                raise ValueError("local: " + " · ".join(f"{r['label']}: {r['detail']}" for r in bad) + " — press \"prepare now\" or fix by hand")
        child = {k: v for k, v in os.environ.items() if k not in ("PERF_TARGET", "PERF_CONFIRM", "PERF_BASE", "PERF_TARGET_LABEL")}
        child.update(base)
        if target in CONFIRM_WORD:
            child["PERF_CONFIRM"] = CONFIRM_WORD[target]  # typed on the page for this run
        child.update(env)
        child.update({"PERF_RUN_ID": run_id, "LIVE_DIR": LIVE_DIR})
        if case == "ts01q":
            cmd = ["bash", c["script"], env["ENDPOINTS"]]
        elif case == "tsall":
            cmd = ["bash", c["script"]]  # sets K6_OUT per k6 run itself (LIVE_DIR)
        else:
            cmd = ["k6", "run", "-q", c["script"]]
            child["K6_OUT"] = "json=" + os.path.join(LIVE_DIR, f"{run_id}.json")
        shown = " ".join(f"{k}={v}" for k, v in env.items()) + (" " if env else "") + " ".join(cmd)
        RUN.log = [f"$ {shown}", f"# target {target} · run {run_id}", ""]
        RUN.info = {"case": case, "target": target, "runId": run_id, "env": env, "real": real, "gate": gate_of(child),
                    "start": time.strftime("%H:%M:%S"), "date": time.strftime("%Y-%m-%d"), "startedAt": time.time(),
                    "estimateSec": body.get("estimateSec") if isinstance(body.get("estimateSec"), (int, float)) else None,
                    "done": False}
        LIVE["obj"] = Live(run_id, RUN.info["gate"]["slowMs"])
        RUN.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1, start_new_session=True, env=child,
                                    preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))
        threading.Thread(target=watch, args=(RUN.proc, RUN.info), daemon=True).start()
    return RUN.info


# ---- local pmc-line: what a run needs, and getting it ready (scripts/local-prepare.sh) ---------

PREP = Run()


def http_get(url, timeout=5):
    try:
        with urlopen(Request(url, headers={"user-agent": "pmc-line-perf runner"}), timeout=timeout) as r:
            return r.status, r.read()
    except Exception as e:  # noqa: BLE001
        code = getattr(e, "code", None)
        return code or 0, b""


def local_checks():
    """The checklist for a run on the local app: [{key, label, ok, need, detail, fix}]."""
    env = target_env("local")
    base = LOCAL_BASE
    code, body = http_get(f"{base}/api/products")
    products = 0
    if code == 200:
        try:
            products = len([p for p in json.loads(body).get("products", []) if p.get("active", True) and not p.get("outOfStock")])
        except ValueError:
            products = -1
    rows = [
        {"key": "app", "label": f"pmc-line ({base})", "need": True, "ok": code == 200,
         "detail": "answers GET /api/products" if code == 200 else f"not answering (HTTP {code or 'no connection'})",
         "fix": None if code == 200 else "scripts/local-stack.sh up (emulators 8085 / 4448 → perf seed → next build → next start :3100; a few minutes the first time)"},
        {"key": "products", "label": "catalog (GET /api/products)", "need": True, "ok": products > 0,
         "detail": f"{products} orderable product(s)" if products >= 0 else "could not parse", "fix": "scripts/local-stack.sh down && scripts/local-stack.sh up (reseeds)"},
    ]
    user, pw = env.get("PERF_ADMIN_USER") or "perfadmin01", env.get("PERF_ADMIN_PASS") or "perf-pass"
    login = 0
    if code == 200:
        try:
            req = Request(f"{base}/api/admin/login", data=json.dumps({"username": user, "password": pw}).encode(), headers={"content-type": "application/json"}, method="POST")
            with urlopen(req, timeout=15) as r:
                login = r.status
        except Exception as e:  # noqa: BLE001
            login = getattr(e, "code", 0) or 0
    rows.append({"key": "login", "label": f"admin login ({user})", "need": True, "ok": login == 200,
                 "detail": "POST /api/admin/login → 200" if login == 200 else f"→ {login or 'no answer'}", "fix": "the perf seed's perfadmin01 / perf-pass (scripts/local-stack.sh up), or PERF_ADMIN_USER / _PASS in .env.local"})
    slip = os.path.join(ROOT, "fixtures", "slip.png")
    rows.append({"key": "slip", "label": "fixtures/slip.png (the uploaded slip)", "need": True, "ok": os.path.exists(slip),
                 "detail": f"{os.path.getsize(slip):,} bytes" if os.path.exists(slip) else "missing", "fix": None})
    return rows


def prep_watch(proc, info):
    for line in proc.stdout:
        with PREP.lock:
            PREP.log.append(ANSI_RE.sub("", line.rstrip("\n")))
            if len(PREP.log) > 4000:
                del PREP.log[:1000]
    proc.wait()
    with PREP.lock:
        info.update({"done": True, "ok": proc.returncode == 0, "exit": proc.returncode, "end": time.strftime("%H:%M:%S")})


def start_prepare(body):
    """Run scripts/local-stack.sh up (emulators → seed → build → start) into PREP.log."""
    with RUN.lock, PREP.lock:
        if RUN.running() or (PREP.info and not PREP.info.get("done")):
            raise ValueError("busy — a run or a prepare is in progress")
        env = dict(os.environ)
        env.update({k: v for k, v in target_env("local").items() if k.startswith("PERF_")})
        env["PERF_BASE"] = LOCAL_BASE
        orders = str(body.get("orders") or "").strip()
        if orders:
            if not re.match(r"^\d{1,6}$", orders):
                raise ValueError("orders: a whole number up to 999999")
            env["PERF_ORDERS"] = orders
        cmd = ["bash", os.path.join("scripts", "local-stack.sh"), "up"]
        PREP.log = [f"$ {'PERF_ORDERS=' + orders + ' ' if orders else ''}{' '.join(cmd)}"]
        PREP.info = {"start": time.strftime("%H:%M:%S"), "done": False, "ok": None}
        PREP.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                                     start_new_session=True, env=env, preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))
        info = PREP.info
    threading.Thread(target=prep_watch, args=(PREP.proc, info), daemon=True).start()
    return info


def prep_status(frm):
    with PREP.lock:
        running = bool(PREP.info) and not PREP.info.get("done")
        return {"running": running, "info": PREP.info, "log": PREP.log[frm:], "logLen": len(PREP.log)}


# ---- HTTP -------------------------------------------------------------------------------


def q1(u, key):
    return (parse_qs(u.query).get(key) or [""])[0]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def local_only(self):
        return (self.headers.get("Host") or "").split(":")[0] in ("127.0.0.1", "localhost")

    def do_GET(self):
        if not self.local_only():
            return self.send(403, {"error": "forbidden"})
        u = urlparse(self.path)
        if u.path == "/":
            with open(HTML, "rb") as f:
                return self.send(200, f.read(), "text/html; charset=utf-8")
        if u.path == "/api/meta":
            return self.send(200, {"targets": target_meta(), "cases": case_meta(), "gate": gate_of(read_dotenv()), "localBase": LOCAL_BASE})
        if u.path == "/api/local/check":
            return self.send(200, {"checks": local_checks()})
        if u.path == "/api/local/prepare/status":
            return self.send(200, prep_status(int(q1(u, "from") or 0)))
        if u.path == "/api/lastpass":
            t = q1(u, "target")
            return self.send(200, last_pass(t) if t in ("mock", "local", "stg", "prod", "custom") else {})
        if u.path == "/api/status":
            frm = int(q1(u, "from") or 0)
            with RUN.lock:
                return self.send(200, {"running": RUN.running(), "info": RUN.info, "log": RUN.log[frm:], "logLen": len(RUN.log)})
        if u.path == "/api/live":
            rid = RUN_ID_RE.sub("", q1(u, "run"))
            if rid:
                p = os.path.join(RESULTS, f"{rid}_live.json")
                if not os.path.isfile(p):
                    return self.send(404, {"error": "no live series for this run"})
                with open(p, "rb") as f:
                    return self.send(200, f.read())
            lv = LIVE["obj"]
            return self.send(200, lv.snapshot(int(q1(u, "from") or 0)) if lv else {"series": [], "len": 0, "total": None, "done": True, "fails": []})
        if u.path == "/api/verdicts":
            return self.send(200, read_verdicts(RUN_ID_RE.sub("", q1(u, "run"))))
        if u.path == "/api/history":
            return self.send(200, history())
        if u.path == "/api/sheet":
            return self.send(200, read_sheet(RUN_ID_RE.sub("", q1(u, "run"))))
        if u.path.startswith("/results/"):
            name = os.path.basename(u.path)  # no directories: only files directly in results/
            p = os.path.join(RESULTS, name)
            ctype = {".json": "application/json", ".html": "text/html; charset=utf-8", ".csv": "text/csv; charset=utf-8",
                     ".png": "image/png"}.get(os.path.splitext(name)[1])
            if ctype and os.path.isfile(p):
                with open(p, "rb") as f:
                    return self.send(200, f.read(), ctype)
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        if not self.local_only() or self.headers.get("X-Runner") != "1":
            return self.send(403, {"error": "forbidden"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.send(400, {"error": "bad json"})
        try:
            if self.path == "/api/run":
                return self.send(200, start_run(body))
            if self.path == "/api/local/prepare":
                return self.send(200, start_prepare(body))
            if self.path == "/api/stop":
                with RUN.lock:
                    if not RUN.running():
                        return self.send(200, {"stopped": False})
                    sig = signal.SIGKILL if RUN.info.get("stopping") else signal.SIGINT  # 2nd press = kill
                    RUN.info["stopping"] = True
                    os.killpg(RUN.proc.pid, sig)
                return self.send(200, {"stopped": True})
        except (ValueError, RuntimeError) as e:
            return self.send(400, {"error": str(e)})
        return self.send(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser(description="pmc-line perf runner (local web UI for k6)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--settings-md", action="store_true", help="print docs/runner-settings.md and exit")
    args = ap.parse_args()
    if args.settings_md:
        print(settings_markdown())
        return
    if not any(os.access(os.path.join(p, "k6"), os.X_OK) for p in os.environ.get("PATH", "").split(os.pathsep)):
        sys.exit("k6 not found in PATH — brew install k6")
    os.makedirs(RESULTS, exist_ok=True)
    try:
        with open(LAST_RUN, encoding="utf-8") as f:
            RUN.info = dict(json.load(f), done=True)
    except (OSError, ValueError):
        pass
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), H)
    srv.daemon_threads = True
    print(f"pmc-line perf runner → http://127.0.0.1:{args.port}   (Ctrl+C to quit)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if RUN.running():
            os.killpg(RUN.proc.pid, signal.SIGINT)
        if MOCK["proc"]:
            MOCK["proc"].terminate()


if __name__ == "__main__":
    main()
