#!/bin/sh
# Container entrypoint (Dockerfile). Picks the scenario from PERF_SCENARIO and, when the job runs
# with N tasks (Cloud Run Jobs set CLOUD_RUN_TASK_INDEX / _COUNT), gives each task its execution
# segment so the arrival rate is split across tasks.
set -eu
set -o pipefail

SCENARIO="${PERF_SCENARIO:?PERF_SCENARIO is required (smoke|check|ts01|ts02|ts03|ts04|soak|stress|spike|auth)}"
case "$SCENARIO" in
  ts01) SCRIPT=scenarios/ts01-endpoint.js ;;
  ts02) SCRIPT=scenarios/ts02-storefront.js ;;
  ts03) SCRIPT=scenarios/ts03-admin-orders.js ;;
  ts04) SCRIPT=scenarios/ts04-dashboard.js ;;
  smoke|check|soak|stress|spike|auth) SCRIPT="scenarios/$SCENARIO.js" ;;
  *) echo "unknown scenario: $SCENARIO" >&2; exit 2 ;;
esac

RUN_ID="${PERF_RUN_ID:?PERF_RUN_ID is required}"
ROUND="${PERF_ROUND:-1}"
IDX="${CLOUD_RUN_TASK_INDEX:-0}"
CNT="${CLOUD_RUN_TASK_COUNT:-1}"

OUT="${PERF_RESULTS_DIR}/${RUN_ID}/${SCENARIO}/round-${ROUND}"
[ "$SCENARIO" = "ts01" ] && OUT="${PERF_RESULTS_DIR}/${RUN_ID}/ts01/${PERF_ENDPOINT:?PERF_ENDPOINT is required for ts01}/round-${ROUND}"
[ "$CNT" -gt 1 ] && OUT="${OUT}/task-${IDX}"
mkdir -p "$OUT"

SEGMENT_ARGS=""
if [ "$CNT" -gt 1 ]; then
  SEQ=$(awk -v n="$CNT" 'BEGIN{s="0";for(i=1;i<=n;i++)s=s","i"/"n;print s}')
  SEG=$(awk -v i="$IDX" -v n="$CNT" 'BEGIN{print i"/"n":"(i+1)"/"n}')
  SEGMENT_ARGS="--execution-segment=$SEG --execution-segment-sequence=$SEQ"
fi
export PERF_SUMMARY_DIR="$OUT"
export K6_WEB_DASHBOARD=true
export K6_WEB_DASHBOARD_EXPORT="${OUT}/dashboard.html"

EXTRA_OUT=""
[ "$SCENARIO" = "stress" ] && EXTRA_OUT="--out json=${OUT}/raw.json.gz"

# shellcheck disable=SC2086
k6 run $SEGMENT_ARGS $EXTRA_OUT \
  --summary-export="${OUT}/k6-summary-export.json" \
  "$SCRIPT" 2>&1 | tee "${OUT}/k6.log"
