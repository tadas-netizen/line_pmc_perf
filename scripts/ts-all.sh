#!/usr/bin/env bash
# TS-All — run the whole suite ONE AFTER ANOTHER (never at the same time), so an engineer can
# start it, leave, and come back to the results:
#
#   TS-01 Endpoint (Group Run) for ALL endpoints (reads → auth → writes, its own 60 s gap)
#   → gap → TS-02 Storefront → gap → TS-03 Admin orders → gap → TS-04 Dashboard
#
# Every TS runs with its own DEFAULT settings (rate, VUs, …). The only shared knob is the load
# shape — ramp 30 s / hold 5 min / ramp down 30 s unless TSALL_RAMP / TSALL_HOLD / TSALL_RAMP_DOWN
# say otherwise. With the defaults this takes ≈ 4 h, most of it TS-01 (36 endpoints × ~7 min).
# A failing TS does not stop the sequence; the exit code is non-zero if any TS failed.
#
#   scripts/ts-all.sh                              # everything
#   TSALL_TS01=0 scripts/ts-all.sh                 # skip TS-01
#   TSALL_GAP=120 scripts/ts-all.sh                # 2 min between the TSs
#   TSALL_HOLD=1m scripts/ts-all.sh                # every TS holds 1 min (rehearsal)
#
# Env: TSALL_TS01 / TSALL_TS02 / TSALL_TS03 / TSALL_TS04 (1 = include, default; 0 = skip)
#      TSALL_GAP (seconds between TSs, default 60) · PERF_RUN_ID (one id for the whole sequence)
#      TSALL_RAMP / TSALL_HOLD / TSALL_RAMP_DOWN (shape for every TS; default 30s / 5m / 30s)
#      TSALL_TS01_TPS / TSALL_TS01_AUTH_TPS / TSALL_TS01_WRITE_TPS (TS-01 rate for every read / auth /
#      write endpoint; whole numbers; empty = each endpoint's own default, lib/endpoints.js `rate`)
#      TSALL_KEEP_SETTINGS=1 keeps PERF_* tuning variables from the environment (rehearsal only)
# Target / credentials / confirmation come from the environment as for any run (PERF_TARGET +
# PERF_CONFIRM for stg/prod, or the mock's PERF_BASE). tools/runner.py runs this as "TS-All".
set -uo pipefail
cd "$(dirname "$0")/.."

GAP="${TSALL_GAP:-60}"
export PERF_RUN_ID="${PERF_RUN_ID:-ts-all-$(date +%m%d-%H%M%S)}"
inc() { [ "${1:-1}" = "1" ]; }

if [ "${TSALL_KEEP_SETTINGS:-0}" != "1" ]; then
  unset PERF_ENDPOINT PERF_RPS PERF_STEPS PERF_MAX_VUS PERF_VUS PERF_ROUND PERF_HOLD PERF_RAMP PERF_RAMP_DOWN \
    PERF_ORDERS_PER_SEC PERF_P_VALIDATE PERF_TARGET_RPS PERF_P_SLIP PERF_P_NOTE PERF_P_STATUS PERF_P_RANGE TS01_GAP TS01_RATES
fi
[ -n "${TSALL_RAMP:-}" ] && export PERF_RAMP="$TSALL_RAMP"
[ -n "${TSALL_HOLD:-}" ] && export PERF_HOLD="$TSALL_HOLD"
[ -n "${TSALL_RAMP_DOWN:-}" ] && export PERF_RAMP_DOWN="$TSALL_RAMP_DOWN"

PLAN=()
inc "${TSALL_TS01:-1}" && PLAN+=("ts01")
inc "${TSALL_TS02:-1}" && PLAN+=("ts02")
inc "${TSALL_TS03:-1}" && PLAN+=("ts03")
inc "${TSALL_TS04:-1}" && PLAN+=("ts04")
[ "${#PLAN[@]}" -gt 0 ] || { echo "TS-All: nothing selected" >&2; exit 2; }

STOPPED=0
trap 'STOPPED=1; echo; echo "TS-All: stop requested — finishing the current step, starting nothing new"' INT TERM

# id:TPS for every TS-01 endpoint from the three TS-01 rate knobs (passed to ts01-queue.sh as
# TS01_RATES); empty when none is set, so every endpoint keeps its default.
ts01_rates() {
  [ -z "${TSALL_TS01_TPS:-}${TSALL_TS01_AUTH_TPS:-}${TSALL_TS01_WRITE_TPS:-}" ] && return 0
  node -e '
      const src = require("fs").readFileSync("lib/endpoints.js", "utf8");
      const [read, auth, write] = process.argv.slice(1), re = /^\s+.([a-zA-Z.]+).: \{[^\n]*\n?\s*kind: .(\w+).([^\n]*)/gm, out = []; let m;
      while ((m = re.exec(src))) { if (/heavy: true/.test(m[3])) continue; const r = { read, auth, write }[m[2]]; if (r) out.push(m[1] + ":" + r); }
      process.stdout.write(out.join(","));
    ' "${TSALL_TS01_TPS:-}" "${TSALL_TS01_AUTH_TPS:-}" "${TSALL_TS01_WRITE_TPS:-}"
}

label() { case "$1" in ts01) echo "TS-01 Endpoint (Group Run, all endpoints)";; ts02) echo "TS-02 Storefront";; ts03) echo "TS-03 Admin orders";; ts04) echo "TS-04 Dashboard";; esac; }
script() { case "$1" in ts02) echo scenarios/ts02-storefront.js;; ts03) echo scenarios/ts03-admin-orders.js;; ts04) echo scenarios/ts04-dashboard.js;; esac; }

echo "TS-All $PERF_RUN_ID · $(date '+%Y-%m-%d %H:%M:%S')"
echo "  sequence: $(for t in "${PLAN[@]}"; do printf '%s → ' "$(label "$t")"; done | sed 's/ → $//')"
[ -n "${TSALL_TS01_TPS:-}${TSALL_TS01_AUTH_TPS:-}${TSALL_TS01_WRITE_TPS:-}" ] && echo "  TS-01 TPS: read ${TSALL_TS01_TPS:-(default)} · auth ${TSALL_TS01_AUTH_TPS:-(default)} · write ${TSALL_TS01_WRITE_TPS:-(default)}"
echo "  gap between TSs: ${GAP}s · shape ramp ${PERF_RAMP:-30s} / hold ${PERF_HOLD:-5m} / ramp down ${PERF_RAMP_DOWN:-30s} · other settings: each TS's defaults · one at a time"
echo

declare -a RESULT
for i in "${!PLAN[@]}"; do
  t="${PLAN[$i]}"
  [ "$STOPPED" = "1" ] && { RESULT+=("$(label "$t"): not started (stopped)"); continue; }
  echo; echo "===== [$((i + 1))/${#PLAN[@]}] $(label "$t") · $(date +%H:%M:%S)"
  if [ "$t" = "ts01" ]; then
    TS01_RATES="$(ts01_rates)" bash scripts/ts01-queue.sh all
    code=$?
    [ "$code" -eq 130 ] && STOPPED=1
  else
    if [ -n "${LIVE_DIR:-}" ]; then export K6_OUT="json=${LIVE_DIR}/${PERF_RUN_ID}-${t}.json"; fi
    k6 run -q "$(script "$t")"
    code=$?
  fi
  RESULT+=("$(label "$t"): $([ $code -eq 0 ] && echo PASS || echo "FAIL (exit $code)")")
  if [ "$i" -lt $((${#PLAN[@]} - 1)) ] && [ "$STOPPED" = "0" ]; then
    echo; echo "----- gap ${GAP}s before the next TS"
    sleep "$GAP" || true
  fi
done

echo
echo "TS-All $PERF_RUN_ID finished · $(date '+%Y-%m-%d %H:%M:%S')"
printf '  %s\n' "${RESULT[@]}"
echo "  results: results/${PERF_RUN_ID}_* (report.html, results.csv, verdict.json per TS / endpoint)"
printf '%s\n' "${RESULT[@]}" | grep -q "FAIL\|not started" && exit 1
exit 0
