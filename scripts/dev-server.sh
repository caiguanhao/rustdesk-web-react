#!/usr/bin/env bash
# Isolated local RustDesk hbbs/hbbr for development and real-connect tests.
#
# Uses the official 1.1.16 Linux server binaries from GitHub releases, packed
# into a local scratch image (Docker Hub is not required). Containers use
# dedicated names, a data directory under .local/ and non-standard ports:
#
#   hbbs TCP/WS  12116 / 12118     (client: server=127.0.0.1:12116)
#   hbbr TCP/WS  12117 / 12119     (relay_server=127.0.0.1:12117)
#
# It never reads or writes the user's RustDesk client/server configuration.
# UDP port forwarding needs colima's gRPC forwarder:
#   colima start --port-forwarder grpc
#
# Usage: scripts/dev-server.sh [up|down|status|reset|logs]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCAL="$ROOT/.local/rustdesk-server"
DATA="$LOCAL/data"
CACHE="$LOCAL/cache"
VERSION=1.1.16
IMAGE="rustdesk-server-local:$VERSION"
HBBS_NAME=rdw-hbbs
HBBR_NAME=rdw-hbbr
BASE_PORT=${RD_BASE_PORT:-12116}
BIND_HOST=${RD_BIND_HOST:-127.0.0.1}
PUBLIC_HOST=${RD_PUBLIC_HOST:-127.0.0.1}
RELAY_PORT=$((BASE_PORT + 1))
WS_ID_PORT=$((BASE_PORT + 2))
WS_RELAY_PORT=$((BASE_PORT + 3))

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null || die "docker is not installed"
  if ! docker info >/dev/null 2>&1; then
    command -v colima >/dev/null || die "colima is not installed and Docker is not running"
    log "Starting colima with the gRPC port forwarder (UDP is required)..."
    colima start --port-forwarder grpc
  fi
  if ! grep -q '^portForwarder: grpc' "$HOME/.colima/default/colima.yaml" 2>/dev/null; then
    log "WARNING: colima is not using the gRPC port forwarder; hbbs UDP will not work."
    log "         Run: colima stop && colima start --port-forwarder grpc"
  fi
}

server_asset() {
  case "$(uname -m)" in
    arm64|aarch64)
      ASSET=rustdesk-server-linux-arm64v8.zip
      ASSET_DIR=arm64v8
      ASSET_SHA=6a4ae3c5ca257a4278ded72fd17eb2ca4eeb0356a5425e63a3e7fcb0ec6c155c
      ;;
    x86_64|amd64)
      ASSET=rustdesk-server-linux-amd64.zip
      ASSET_DIR=amd64
      ASSET_SHA=${RD_SERVER_AMD64_SHA256:-}
      ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
}

ensure_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1 && [[ "${RD_REBUILD:-0}" != "1" ]]; then
    log "Using existing $IMAGE (RD_REBUILD=1 rebuilds)."
    return
  fi
  server_asset
  mkdir -p "$CACHE" "$DATA"
  local zip="$CACHE/$ASSET" dir="$CACHE/$ASSET_DIR"
  if [[ ! -f "$zip" ]] || ! unzip -tq "$zip" >/dev/null 2>&1; then
    log "Downloading $ASSET from the official GitHub release..."
    rm -f "$zip"
    curl -fL --retry 5 --connect-timeout 15 -C - \
      -o "$zip" \
      "https://github.com/rustdesk/rustdesk-server/releases/download/$VERSION/$ASSET"
  fi
  if [[ -n "$ASSET_SHA" ]]; then
    local actual
    actual=$(shasum -a 256 "$zip" | awk '{print $1}')
    [[ "$actual" == "$ASSET_SHA" ]] || die "checksum mismatch for $ASSET: $actual"
  else
    log "WARNING: no pinned checksum for $(uname -m); using the official GitHub asset as-is."
  fi
  rm -rf "$dir"
  unzip -qo "$zip" -d "$CACHE"
  local ctx="$CACHE/image"
  mkdir -p "$ctx"
  cp "$dir/hbbs" "$ctx/hbbs"
  cp "$dir/hbbr" "$ctx/hbbr"
  cat > "$ctx/Dockerfile" <<'EOF'
FROM scratch
WORKDIR /root
COPY hbbs /hbbs
COPY hbbr /hbbr
ENTRYPOINT ["/hbbs"]
EOF
  log "Building $IMAGE..."
  docker build -q -t "$IMAGE" "$ctx" >/dev/null
}

stop_containers() {
  docker rm -f "$HBBS_NAME" "$HBBR_NAME" >/dev/null 2>&1 || true
}

start_servers() {
  require_docker
  ensure_image
  stop_containers
  mkdir -p "$DATA"

  log "Starting hbbs on $BIND_HOST:$BASE_PORT (ws :$WS_ID_PORT, relay $PUBLIC_HOST:$RELAY_PORT)..."
  docker run -d --name "$HBBS_NAME" \
    -p "$BIND_HOST:$BASE_PORT:21116" \
    -p "$BIND_HOST:$BASE_PORT:21116/udp" \
    -p "$BIND_HOST:$((BASE_PORT - 1)):21115" \
    -p "$BIND_HOST:$WS_ID_PORT:21118" \
    -v "$DATA":/root \
    "$IMAGE" -r "$PUBLIC_HOST:$RELAY_PORT" >/dev/null

  local key_file="$DATA/id_ed25519.pub"
  for _ in $(seq 1 100); do
    [[ -s "$key_file" ]] && break
    sleep 0.1
  done
  [[ -s "$key_file" ]] || { docker logs "$HBBS_NAME" 2>&1 | tail -20; die "hbbs did not generate a key"; }

  log "Starting hbbr on $BIND_HOST:$RELAY_PORT (ws :$WS_RELAY_PORT)..."
  docker run -d --name "$HBBR_NAME" --entrypoint /hbbr \
    -p "$BIND_HOST:$RELAY_PORT:21117" \
    -p "$BIND_HOST:$WS_RELAY_PORT:21119" \
    -v "$DATA":/root \
    "$IMAGE" >/dev/null

  sleep 0.5
  local key
  key=$(tr -d '\r\n' < "$key_file")
  cat > "$LOCAL/server.json" <<EOF
{
  "version": "$VERSION",
  "host": "127.0.0.1",
  "port": $BASE_PORT,
  "relayPort": $RELAY_PORT,
  "wsIdUrl": "ws://127.0.0.1:$WS_ID_PORT/ws/id",
  "wsRelayUrl": "ws://127.0.0.1:$WS_RELAY_PORT/ws/relay",
  "serverKey": "$key"
}
EOF
  docker ps --filter "name=^${HBBS_NAME}$" --filter "name=^${HBBR_NAME}$" \
    --format '  {{.Names}} {{.Status}} {{.Ports}}'
  log ""
  log "Server:     127.0.0.1:$BASE_PORT"
  log "Server Key: $key"
  log "Relay:      $PUBLIC_HOST:$RELAY_PORT"
  log "Info file:  $LOCAL/server.json"
}

status_servers() {
  docker ps -a --filter "name=^${HBBS_NAME}$" --filter "name=^${HBBR_NAME}$" \
    --format '{{.Names}} {{.Status}} {{.Ports}}' || true
  if [[ -s "$DATA/id_ed25519.pub" ]]; then
    log "Server Key: $(tr -d '\r\n' < "$DATA/id_ed25519.pub")"
  else
    log "No server key yet (run: $0 up)"
  fi
}

case "${1:-up}" in
  up|start) start_servers ;;
  down|stop)
    stop_containers
    log "Stopped $HBBS_NAME and $HBBR_NAME (data kept in $DATA)."
    ;;
  reset)
    stop_containers
    rm -rf "$DATA"
    log "Removed $DATA."
    start_servers
    ;;
  status) status_servers ;;
  logs)
    docker logs -f "$HBBS_NAME" &
    docker logs -f "$HBBR_NAME"
    ;;
  *)
    cat <<EOF
Usage: $0 [up|down|status|reset|logs]
  up      start isolated hbbs/hbbr (default)
  down    stop and remove the containers, keep data
  reset   stop, delete the isolated data/key, start fresh
  status  show containers and the server key
  logs    follow both container logs
Environment:
  RD_BASE_PORT    hbbs control port (default 12116; WS is +2)
  RD_BIND_HOST    host interface to publish on (default 127.0.0.1)
  RD_PUBLIC_HOST  relay host returned to clients (default 127.0.0.1)
  RD_REBUILD=1    rebuild the local server image
EOF
    ;;
esac
