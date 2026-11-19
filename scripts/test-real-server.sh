#!/usr/bin/env bash
# Run the real hbbs/hbbr integration test against the isolated Docker server.
# Start it first with: npm run dev:server
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
[[ -f "$ROOT/.local/rustdesk-server/server.json" ]] || {
  echo "ERROR: run 'npm run dev:server' first" >&2
  exit 1
}

export RD_REAL_SERVER=1
exec "$ROOT/node_modules/.bin/vitest" run tests/real-server.test.ts
