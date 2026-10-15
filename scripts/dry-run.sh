#!/usr/bin/env bash
# Dry-run a scenario on this machine against the local pmc-line mock — no real environment.
# Starts the mock, points the scripts at it, runs k6 with the web dashboard (live at
# http://127.0.0.1:5665, saved as results/<run>_report.html), and stops the mock afterwards.
#
#   scripts/dry-run.sh <scenario> [extra k6 args…]
#   scenario: smoke | check | ts01 | ts02 | ts03 | ts04 | soak | stress | spike | auth
#
#   scripts/dry-run.sh smoke                                   # every request path once, strict
#   scripts/dry-run.sh ts03                                    # admin order desk, 2 min hold
#   PERF_HOLD=5m scripts/dry-run.sh ts02                       # full-length hold
#   PERF_ENDPOINT=admin.dashboard PERF_STEPS=5,10,20 scripts/dry-run.sh ts01   # ladder
#   DASHBOARD=0 scripts/dry-run.sh smoke                       # no browser
#
# Env: MOCK_PORT (18090) · MOCK_LATENCY_MS (20) · MOCK_ERROR_RATE (0; e.g. 0.05 = 5 % of calls fail, to
#      rehearse error reporting) · MOCK_ORDERS (2000) · DASHBOARD (1) · any PERF_* (passed through).
# Shorter-than-real defaults so a dry run takes minutes: PERF_HOLD=2m, soak 2m, stress steps of 20 s
# up to 150 TPS. A pass proves the SCRIPT works; the mock's latency is fake.
set -euo pipefail

SCENARIO="${1:-}"
case "$SCENARIO" in
  smoke) SCRIPT=scenarios/smoke.js ;;
  check) SCRIPT=scenarios/check.js ;;
  ts01) SCRIPT=scenarios/ts01-endpoint.js ;;
  ts02) SCRIPT=scenarios/ts02-storefront.js ;;
  ts03) SCRIPT=scenarios/ts03-admin-orders.js ;;
  ts04) SCRIPT=scenarios/ts04-dashboard.js ;;
  soak | stress | spike | auth) SCRIPT="scenarios/$SCENARIO.js" ;;
  *)
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
shift

cd "$(dirname "$0")/.."
command -v k6 >/dev/null || { echo "k6 not found — brew install k6" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }

mkdir -p results
PORT="${MOCK_PORT:-18090}"
BASE="http://127.0.0.1:$PORT"

# ---- 1. the mock ----------------------------------------------------------------------
MOCK_PID=""
cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if curl -fsS -m 2 "$BASE/healthz" >/dev/null 2>&1; then
  echo "• mock already answering on :$PORT — reusing it"
elif lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken by something that isn't the mock — set MOCK_PORT" >&2
  exit 1
else
  python3 scripts/mock_line.py "$PORT" "${MOCK_LATENCY_MS:-20}" >results/dry-run-mock.log 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 50); do
    curl -fsS -m 1 "$BASE/healthz" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl -fsS -m 1 "$BASE/healthz" >/dev/null 2>&1 || { echo "mock failed to start — see results/dry-run-mock.log" >&2; exit 1; }
  echo "• mock started on :$PORT (pid $MOCK_PID, ${MOCK_LATENCY_MS:-20} ms latency)"
fi

# ---- 2. point the scripts at the mock -------------------------------------------------
# A dry run is mock-only: drop any real target / confirmation left in the shell.
unset PERF_TARGET PERF_CONFIRM PERF_STG_BASE PERF_PROD_BASE
export PERF_BASE="$BASE" PERF_TARGET_LABEL="local (mock)"
export PERF_ADMIN_USER="${PERF_ADMIN_USER:-perfadmin01}" PERF_ADMIN_PASS="${PERF_ADMIN_PASS:-perf-pass}"
export PERF_PARTNER_USER="${PERF_PARTNER_USER:-perfuser02}" PERF_PARTNER_PASS="${PERF_PARTNER_PASS:-perf-pass}"
export PERF_VIEWER_USER="${PERF_VIEWER_USER:-perfuser03}" PERF_VIEWER_PASS="${PERF_VIEWER_PASS:-perf-pass}"
export PERF_INACTIVE_USER="${PERF_INACTIVE_USER:-inactiveuser}" PERF_INACTIVE_PASS="${PERF_INACTIVE_PASS:-inactive-pass-1}"
export PERF_PARTNER="${PERF_PARTNER:-P01}" PERF_IMAGE_FILE_ID="${PERF_IMAGE_FILE_ID:-qr-1700000000-abcd1234.png}"
export PERF_HOLD="${PERF_HOLD:-2m}" PERF_SOAK_HOLD="${PERF_SOAK_HOLD:-2m}"
export PERF_STRESS_HOLD="${PERF_STRESS_HOLD:-20s}" PERF_STRESS_MAX="${PERF_STRESS_MAX:-150}"
[ "$SCENARIO" = "ts01" ] && export PERF_ENDPOINT="${PERF_ENDPOINT:-admin.orders.list}"
# check: every read endpoint unless ENDPOINTS is set (its own 1 s default, not the 2 m dry-run hold)
[ "$SCENARIO" = "check" ] && export ENDPOINTS="${ENDPOINTS:-$(bash scripts/ts01-queue.sh --list reads)}" PERF_HOLD="${CHECK_HOLD:-1s}"
[ "$SCENARIO" = "smoke" ] && export PERF_SMOKE_SECTIONS="${PERF_SMOKE_SECTIONS:-all}" PERF_DEBUG="${PERF_DEBUG:-1}"
export PERF_RUN_ID="${PERF_RUN_ID:-dry-$SCENARIO-$(date +%m%d-%H%M%S)}"

# ---- 3. dashboard (k6 ≥ 0.49 has it built in) ----------------------------------------
K6_VERSION=$(k6 version 2>/dev/null | sed -nE 's/.*v([0-9]+)\.([0-9]+).*/\1 \2/p' | head -1)
K6_MAJOR=${K6_VERSION%% *}
K6_MINOR=${K6_VERSION##* }
REPORT=""
if [ "${DASHBOARD:-1}" = "1" ]; then
  if [ "${K6_MAJOR:-0}" -ge 1 ] || { [ "${K6_MAJOR:-0}" -eq 0 ] && [ "${K6_MINOR:-0}" -ge 49 ]; }; then
    REPORT="results/${PERF_RUN_ID}_report.html"
    export K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_OPEN=true K6_WEB_DASHBOARD_EXPORT="$REPORT"
    echo "• dashboard: http://127.0.0.1:5665 (live) → $REPORT (saved)"
  else
    echo "• no dashboard: k6 v${K6_MAJOR}.${K6_MINOR} predates it (needs ≥ 0.49) — brew upgrade k6"
  fi
fi

# ---- 4. run ---------------------------------------------------------------------------
echo "• running $SCRIPT as $PERF_RUN_ID (hold $PERF_HOLD)${PERF_ENDPOINT:+, endpoint $PERF_ENDPOINT}"
echo
set +e
k6 run "$@" "$SCRIPT"
CODE=$?
set -e

echo
echo "exit $CODE ($([ $CODE -eq 0 ] && echo 'all thresholds passed' || echo 'thresholds failed or script error'))"
for f in results/"${PERF_RUN_ID}"_*verdict.json; do [ -e "$f" ] && echo "verdict: $f"; done
[ -n "$REPORT" ] && [ -e "$REPORT" ] && echo "report:  $REPORT"
exit $CODE
