#!/usr/bin/env bash
# The LOCAL target: pmc-line itself on this machine, the way its own tests/load/run.sh boots it —
# throwaway Firestore + fake-GCS emulators on 8085 / 4448 (in memory, never the dev stack's
# 8080 / 4443), the perf seed, and a PRODUCTION build of the app on :3100 (a dev build's compile
# latency would fake the numbers). Everything is discarded on `down`.
#
#   scripts/local-stack.sh up          # emulators → seed (PERF_ORDERS, default 2000) → build → start :3100
#   scripts/local-stack.sh down        # stop the app, drop the emulators (and their data)
#   scripts/local-stack.sh status      # what is up, how many products / orders the app serves
#
# Env: PMC_LINE_DIR (../pmc-line) · PERF_ORDERS (2000; the emulator's 2 GB heap fits ≈ 20,000) ·
#      LOCAL_PORT (3100) · SKIP_BUILD=1 (reuse the last .next build)
# Accounts the seed creates (docs §1.3): perfadmin01 / perf-pass (SUPER_ADMIN), perfuser02…30 /
# perf-pass (PARTNER_ADMIN / PARTNER_VIEWER alternating) — lib/config.js' local defaults.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$(cd "$HERE/${PMC_LINE_DIR:-../pmc-line}" 2>/dev/null && pwd)" || { echo "pmc-line checkout not found (PMC_LINE_DIR)" >&2; exit 1; }
PORT="${LOCAL_PORT:-3100}"
ORDERS="${PERF_ORDERS:-2000}"
PROJECT="pmc-line-perf"
STATE="$HERE/results/_local"
COMPOSE=(docker compose -f "$APP/docker-compose.load.yml" -p "$PROJECT")
EMU=(FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 GCS_EMULATOR_HOST=127.0.0.1:4448 GCLOUD_PROJECT=demo-project GCS_BUCKET=demo-project)
mkdir -p "$STATE"

# the repo pins pnpm 11 (packageManager): go through corepack when it is there (a plain command, so `env … $PNPM` works)
if command -v corepack >/dev/null 2>&1; then PNPM="corepack pnpm"; else PNPM="pnpm"; fi
wait_for() {
  for _ in $(seq 1 "${2:-90}"); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "timed out waiting for $1" >&2; return 1
}
app_pid() { [ -f "$STATE/next.pid" ] && kill -0 "$(cat "$STATE/next.pid")" 2>/dev/null && cat "$STATE/next.pid"; }

status() {
  local up=0
  curl -sf -o /dev/null "http://127.0.0.1:8085/v1/projects/demo-project/databases/(default)/documents/?pageSize=1" && echo "✓ Firestore emulator :8085" || { echo "✗ Firestore emulator :8085"; up=1; }
  curl -sf -o /dev/null "http://127.0.0.1:4448/storage/v1/b" && echo "✓ fake-gcs :4448" || { echo "✗ fake-gcs :4448"; up=1; }
  if curl -sf -m 5 "http://localhost:$PORT/api/products" -o "$STATE/products.json"; then
    n=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len([p for p in d["products"] if p.get("active",True) and not p.get("outOfStock")]))' "$STATE/products.json")
    echo "✓ app http://localhost:$PORT · $n orderable product(s)$( [ -n "$(app_pid)" ] && echo " · pid $(app_pid)")"
  else
    echo "✗ app http://localhost:$PORT not answering"; up=1
  fi
  return $up
}

case "${1:-}" in
  status) status ;;
  down)
    if p=$(app_pid); then kill "$p" 2>/dev/null; sleep 1; kill -9 "$p" 2>/dev/null; fi
    pkill -f "next start -p $PORT" 2>/dev/null
    rm -f "$STATE/next.pid"
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 && echo "emulators down" ;;
  up)
    for port in 8085 4448 "$PORT"; do
      if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && ! status >/dev/null 2>&1; then :; fi
    done
    if status >/dev/null 2>&1; then echo "already up:"; status; exit 0; fi
    if ! [[ "$ORDERS" =~ ^[0-9]+$ ]] || [ "$ORDERS" -le 0 ] || [ "$ORDERS" -gt 20000 ]; then echo "PERF_ORDERS=$ORDERS must be 1..20000 (emulator heap)" >&2; exit 1; fi
    echo "== 1/4 throwaway emulators (8085 / 4448, in memory) =="
    "${COMPOSE[@]}" up -d --quiet-pull || exit 1
    wait_for "http://127.0.0.1:8085/v1/projects/demo-project/databases/(default)/documents/?pageSize=1" || exit 1
    wait_for "http://127.0.0.1:4448/storage/v1/b" || exit 1
    (cd "$APP" && [ -d node_modules ] || { echo "== pnpm install (first time) =="; $PNPM install --frozen-lockfile; }) || exit 1
    (cd "$APP" && env "${EMU[@]}" node scripts/ensure-gcs-buckets.mjs) || exit 1
    echo "== 2/4 perf seed (PERF_ORDERS=$ORDERS) =="
    (cd "$APP" && env "${EMU[@]}" PERF_ORDERS="$ORDERS" node packages/database/scripts/seed-perf.mjs) || echo "seed did not run — the emulator already holds data (fine after a failed build); run \`down\` first to reseed"
    if [ "${SKIP_BUILD:-0}" != "1" ] || [ ! -d "$APP/.next" ]; then
      echo "== 3/4 next build (production) =="
      (cd "$APP" && env NEXT_PUBLIC_LIFF_STUB=true NEXT_PUBLIC_GCS_PUBLIC_BASE_URL= \
        GOOGLE_SERVICE_ACCOUNT_JSON= GOOGLE_APPLICATION_CREDENTIALS= FIRESTORE_EMULATOR_HOST= GCS_EMULATOR_HOST= \
        FIREBASE_PROJECT_ID= FIREBASE_DATABASE_NAME= FIREBASE_STORAGE_BUCKET= FIREBASE_STORAGE_EMULATOR_HOST= \
        $PNPM build > "$STATE/build.log" 2>&1) || { echo "build failed — see $STATE/build.log" >&2; tail -20 "$STATE/build.log"; exit 1; }
    else
      echo "== 3/4 build skipped (SKIP_BUILD=1) =="
    fi
    echo "== 4/4 next start -p $PORT =="
    (cd "$APP" && env "${EMU[@]}" ADMIN_SESSION_SECRET=perf-not-a-secret-perf-not-a-secret NEXT_PUBLIC_LIFF_STUB=true \
      GOOGLE_SERVICE_ACCOUNT_JSON= GOOGLE_APPLICATION_CREDENTIALS= \
      FIREBASE_PROJECT_ID= FIREBASE_DATABASE_NAME= FIREBASE_STORAGE_BUCKET= FIREBASE_STORAGE_EMULATOR_HOST= \
      nohup $PNPM exec next start -p "$PORT" > "$STATE/next.log" 2>&1 &
      echo $! > "$STATE/next.pid")
    wait_for "http://localhost:$PORT/api/products" || { tail -20 "$STATE/next.log"; exit 1; }
    # warm-up: first-hit connections + caches, not measured
    C=$(curl -s -D - -o /dev/null -X POST "http://localhost:$PORT/api/admin/login" -H 'Content-Type: application/json' -d '{"username":"perfadmin01","password":"perf-pass"}' | grep -i '^set-cookie' | cut -d' ' -f2 | cut -d';' -f1)
    curl -sf -o /dev/null -H "Cookie: $C" "http://localhost:$PORT/api/admin/orders?limit=10"
    curl -sf -o /dev/null -H "Cookie: $C" "http://localhost:$PORT/api/admin/dashboard-stats"
    status
    echo "run:  PERF_TARGET=local PERF_BASE=http://localhost:$PORT npm run smoke:all   (or the runner's \"local pmc-line\")"
    echo "down: scripts/local-stack.sh down" ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
