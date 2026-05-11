#!/usr/bin/env bash
# upgrade-langfuse.sh — Mecaniza el upgrade DEV de Langfuse del stack local
#
# Aplica las fricciones identificadas en docs/operations/upgrade-trace-2026-05-11.md:
#   F-1: backup pre-upgrade obligatorio
#   F-2: pull paralelo de imágenes web + worker
#
# NO toca PRO. Para PRO ver `docs/operations/runbook.md §Upgrades`.
#
# Uso:
#   ./scripts/upgrade-langfuse.sh 3.173.0           # ejecuta el upgrade
#   ./scripts/upgrade-langfuse.sh 3.173.0 --dry-run # solo muestra qué haría
#
# Exit codes:
#   0 — upgrade completado, smoke 8/8 OK
#   1 — error de argumentos o pre-condiciones
#   2 — fallo en alguno de los steps (backup, pull, recreate, healthcheck, smoke)

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────────
NEW_VERSION="${1:-}"
DRY_RUN=0
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=1
done

if [ -z "$NEW_VERSION" ] || [ "$NEW_VERSION" = "--dry-run" ]; then
  cat >&2 <<EOF
Uso: $0 <NEW_VERSION> [--dry-run]
Ejemplo: $0 3.173.0
EOF
  exit 1
fi

# Validar formato semver (xxx.yyy.zzz)
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$'; then
  echo "[upgrade] NEW_VERSION inválido: $NEW_VERSION (esperado: x.y.z)" >&2
  exit 1
fi

# ── Paths ────────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
BACKUP_SCRIPT="$REPO_ROOT/scripts/backup-langfuse.sh"
SMOKE_SCRIPT="$REPO_ROOT/scripts/smoke-mcp-e2e.ts"

# ── Helpers ──────────────────────────────────────────────────────────────────
log() { printf '{"ts":"%s","level":"info","service":"upgrade-langfuse","msg":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
err() { printf '{"ts":"%s","level":"error","service":"upgrade-langfuse","msg":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# ── Pre-condiciones ──────────────────────────────────────────────────────────
[ -f "$COMPOSE_FILE" ] || { err "docker-compose.yml no encontrado en $COMPOSE_FILE"; exit 1; }
[ -x "$BACKUP_SCRIPT" ] || { err "backup-langfuse.sh no es ejecutable: $BACKUP_SCRIPT"; exit 1; }
[ -f "$SMOKE_SCRIPT" ] || { err "smoke-mcp-e2e.ts no encontrado: $SMOKE_SCRIPT"; exit 1; }

# Detectar versión actual
CURRENT_VERSION=$(grep -E "^[[:space:]]+image: langfuse/langfuse:" "$COMPOSE_FILE" \
  | head -1 | sed -E 's/.*langfuse:([0-9.]+).*/\1/')

if [ -z "$CURRENT_VERSION" ]; then
  err "no pude detectar la versión actual en $COMPOSE_FILE"
  exit 1
fi

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  log "Versión actual ya es $NEW_VERSION — nada que hacer"
  exit 0
fi

log "upgrade: $CURRENT_VERSION → $NEW_VERSION (dry-run=$DRY_RUN)"

# ── F-1: Backup obligatorio pre-upgrade ──────────────────────────────────────
log "Step 1/5 — backup pre-upgrade"
run bash "$BACKUP_SCRIPT"

# ── Bump de versión en docker-compose.yml ────────────────────────────────────
log "Step 2/5 — bump versión en docker-compose.yml"
if [ "$DRY_RUN" = "1" ]; then
  printf '[dry-run] sed -i s/langfuse:%s/langfuse:%s/g %s\n' \
    "$CURRENT_VERSION" "$NEW_VERSION" "$COMPOSE_FILE"
  printf '[dry-run] sed -i s/langfuse-worker:%s/langfuse-worker:%s/g %s\n' \
    "$CURRENT_VERSION" "$NEW_VERSION" "$COMPOSE_FILE"
else
  # Usa # como delimitador para evitar problemas con dots en versiones
  sed -i "s#langfuse/langfuse:${CURRENT_VERSION}#langfuse/langfuse:${NEW_VERSION}#g" "$COMPOSE_FILE"
  sed -i "s#langfuse/langfuse-worker:${CURRENT_VERSION}#langfuse/langfuse-worker:${NEW_VERSION}#g" "$COMPOSE_FILE"
fi

# ── F-2: Pull paralelo de imágenes ───────────────────────────────────────────
log "Step 3/5 — pull paralelo de imágenes web + worker"
if [ "$DRY_RUN" = "1" ]; then
  printf '[dry-run] docker pull langfuse/langfuse:%s & docker pull langfuse/langfuse-worker:%s & wait\n' \
    "$NEW_VERSION" "$NEW_VERSION"
else
  PULL_START=$(date +%s)
  docker pull "langfuse/langfuse:${NEW_VERSION}" &
  PID_WEB=$!
  docker pull "langfuse/langfuse-worker:${NEW_VERSION}" &
  PID_WORKER=$!

  FAILED=0
  wait $PID_WEB || FAILED=1
  wait $PID_WORKER || FAILED=1
  PULL_END=$(date +%s)

  if [ "$FAILED" = "1" ]; then
    err "pull falló — revertir bump y abortar"
    sed -i "s#langfuse/langfuse:${NEW_VERSION}#langfuse/langfuse:${CURRENT_VERSION}#g" "$COMPOSE_FILE"
    sed -i "s#langfuse/langfuse-worker:${NEW_VERSION}#langfuse/langfuse-worker:${CURRENT_VERSION}#g" "$COMPOSE_FILE"
    exit 2
  fi
  log "pull completado en $((PULL_END - PULL_START))s"
fi

# ── Recreate solo web + worker (preserva uptime del resto del stack) ─────────
log "Step 4/5 — recreate web + worker (no toca postgres/clickhouse/redis/minio)"
run docker compose -f "$COMPOSE_FILE" up -d --no-deps langfuse-web langfuse-worker

# ── Healthcheck (poll, no sleep arbitrario) ──────────────────────────────────
if [ "$DRY_RUN" != "1" ]; then
  log "Step 4b/5 — esperar healthy (timeout 120s)"
  HEALTH_OK=0
  for i in $(seq 1 24); do
    WEB_STATUS=$(docker inspect docker-langfuse-web-1 --format '{{.State.Health.Status}}' 2>/dev/null || echo "missing")
    WORKER_STATUS=$(docker inspect docker-langfuse-worker-1 --format '{{.State.Health.Status}}' 2>/dev/null || echo "missing")
    if [ "$WEB_STATUS" = "healthy" ] && [ "$WORKER_STATUS" = "healthy" ]; then
      log "ambos healthy en t=$((i*5))s"
      HEALTH_OK=1
      break
    fi
    sleep 5
  done

  if [ "$HEALTH_OK" != "1" ]; then
    err "healthcheck falló tras 120s. web=$WEB_STATUS worker=$WORKER_STATUS — investigar manualmente"
    exit 2
  fi
fi

# ── Smoke E2E ────────────────────────────────────────────────────────────────
log "Step 5/5 — smoke E2E contra DEV"
if [ "$DRY_RUN" = "1" ]; then
  printf '[dry-run] source ~/.atlax-ai/dev.env && bun run %s\n' "$SMOKE_SCRIPT"
else
  if [ ! -f "$HOME/.atlax-ai/dev.env" ]; then
    log "WARN: ~/.atlax-ai/dev.env no existe — usando credenciales placeholder de docker-compose"
    LANGFUSE_HOST="http://localhost:3000" \
    LANGFUSE_PUBLIC_KEY="pk-lf-PENDIENTE" \
    LANGFUSE_SECRET_KEY="sk-lf-PENDIENTE" \
      bun run "$SMOKE_SCRIPT"
  else
    set +u
    # shellcheck disable=SC1091
    source "$HOME/.atlax-ai/dev.env"
    set -u
    bun run "$SMOKE_SCRIPT"
  fi
fi

log "Upgrade DEV completo: $CURRENT_VERSION → $NEW_VERSION"
log "Próximo: commit + PR + merge a main, luego aplicar a PRO (ver docs/operations/runbook.md §Upgrades)"
