#!/usr/bin/env bash
# TS-01 Endpoint (Group Run): TS-01 for a group of endpoints, one k6 run each, with a pause between
# them so one endpoint's tail never overlaps the next.
#
#   scripts/ts01-queue.sh focus                        # the spec's five focus lines (#1 orders, #3 products, #7 admin orders, #10 dashboard, #11 admin products)
#   scripts/ts01-queue.sh reads                        # every read endpoint (safe: no document written)
#   scripts/ts01-queue.sh heavy                        # the unbounded admin-orders reads (all / search)
#   scripts/ts01-queue.sh auth                         # the login (bcrypt)
#   scripts/ts01-queue.sh writes                       # CREATES / CHANGES data — see README "What a run leaves behind"
#   scripts/ts01-queue.sh all                          # reads, then auth, then writes (TS-All)
#   scripts/ts01-queue.sh products.list,admin.dashboard   # explicit list
#   scripts/ts01-queue.sh --list reads                 # print the ids of a group and exit
#
# Any PERF_* env is passed through (PERF_RPS, PERF_STEPS, PERF_HOLD, …). TS01_RATES="id:rps,…" gives
# single endpoints their own rate (PERF_RPS for that endpoint only).
set -uo pipefail

cd "$(dirname "$0")/.."

# Group membership comes from lib/endpoints.js (kind / heavy) so the list lives in one place.
list_group() {
  node -e '
      const src = require("fs").readFileSync("lib/endpoints.js", "utf8");
      const want = process.argv[1];
      if (want === "focus") { const f = /export const FOCUS = \[([^\]]*)\]/.exec(src); process.stdout.write(f[1].replace(/[^a-zA-Z.,]/g, "")); process.exit(0); }
      const re = /^\s+.([a-zA-Z.]+).: \{[^\n]*\n?\s*kind: .(\w+).([^\n]*)/gm;
      const out = []; let m;
      while ((m = re.exec(src))) {
        const heavy = /heavy: true/.test(m[3]);
        if (want === "heavy" ? heavy : want === "reads" ? m[2] === "read" && !heavy : want === "auth" ? m[2] === "auth" : m[2] === "write") out.push(m[1]);
      }
      process.stdout.write(out.join(","));
    ' "$1"
}
if [ "${1:-}" = "--list" ]; then list_group "${2:-reads}"; echo; exit 0; fi

GROUP="${1:?usage: ts01-queue.sh <focus|reads|heavy|auth|writes|all|id,id,…>}"
GAP="${TS01_GAP:-60}"
case "$GROUP" in
  all) IDS="$(list_group reads),$(list_group auth),$(list_group writes)" ;;
  focus|reads|heavy|auth|writes) IDS=$(list_group "$GROUP") ;;
  *) IDS="$GROUP" ;;
esac
[ -n "$IDS" ] || { echo "no endpoints for $GROUP" >&2; exit 2; }

export PERF_RUN_ID="${PERF_RUN_ID:-ts01-$(date +%m%d-%H%M%S)}"
echo "TS-01 Endpoint (Group Run) $PERF_RUN_ID: ${IDS//,/ → } (gap ${GAP}s)"

FAILED=()
STOPPED=0
# Ctrl+C / the runner's Stop: k6 finishes cleanly, then no further endpoint starts.
trap 'STOPPED=1; echo; echo "stop requested — no further endpoints"' INT TERM
IFS=',' read -ra LIST <<< "$IDS"
for i in "${!LIST[@]}"; do
  id="${LIST[$i]}"
  [ "$STOPPED" = "1" ] && { FAILED+=("$id(not started)"); continue; }
  echo; echo "== [$((i + 1))/${#LIST[@]}] $id  $(date +%H:%M:%S)"
  # tools/runner.py sets LIVE_DIR: one raw-output file per endpoint for its live charts.
  if [ -n "${LIVE_DIR:-}" ]; then export K6_OUT="json=${LIVE_DIR}/${PERF_RUN_ID}-${id}.json"; fi
  rate=$(printf '%s\n' "${TS01_RATES:-}" | tr ',' '\n' | awk -F: -v id="$id" '$1 == id && $2 ~ /^[0-9.]+$/ { print $2; exit }')
  if [ -n "$rate" ]; then
    PERF_ENDPOINT="$id" PERF_RPS="$rate" k6 run -q scenarios/ts01-endpoint.js || FAILED+=("$id")
  else
    PERF_ENDPOINT="$id" k6 run -q scenarios/ts01-endpoint.js || FAILED+=("$id")
  fi
  [ "$i" -lt $((${#LIST[@]} - 1)) ] && [ "$STOPPED" = "0" ] && { sleep "$GAP" || true; }
done

echo; echo "done: ${#LIST[@]} endpoint(s), ${#FAILED[@]} failed${FAILED[*]:+: ${FAILED[*]}}"
echo "rollup: node scripts/rollup.ts results"
[ "$STOPPED" = "1" ] && exit 130
[ "${#FAILED[@]}" -eq 0 ]
