#!/usr/bin/env bash
# backup-langfuse.sh — Daily backup of Langfuse Postgres + ClickHouse
#
# Stores compressed dumps in ~/.atlax-ai/backups/
# Retention: last 7 daily + last 4 weekly (Sundays)
#
# Usage:
#   ./scripts/backup-langfuse.sh              # full backup
#   DRY_RUN=1 ./scripts/backup-langfuse.sh    # show what would happen
#
# Exit codes:
#   0 — backup completed successfully
#   1 — configuration error
#   2 — backup failed

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/.atlax-ai/backups}"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/../docker" && pwd)}"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
DAILY_KEEP=${DAILY_KEEP:-7}
WEEKLY_KEEP=${WEEKLY_KEEP:-4}
DRY_RUN="${DRY_RUN:-0}"
DATE=$(date +%Y-%m-%d)
DOW=$(date +%u)  # 1=Monday, 7=Sunday

log() {
  local level=$1; shift
  printf '{"ts":"%s","level":"%s","service":"backup-langfuse","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$*"
}

# ── Preflight ────────────────────────────────────────────────────────────────

if [ ! -f "$COMPOSE_FILE" ]; then
  log "error" "docker-compose.yml not found at $COMPOSE_FILE"
  exit 1
fi

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# Verify containers are running
if ! docker compose -f "$COMPOSE_FILE" ps --format '{{.Name}}' 2>/dev/null | grep -q postgres; then
  log "error" "Postgres container not running"
  exit 1
fi

if ! docker compose -f "$COMPOSE_FILE" ps --format '{{.Name}}' 2>/dev/null | grep -q clickhouse; then
  log "error" "ClickHouse container not running"
  exit 1
fi

# ── Postgres dump ────────────────────────────────────────────────────────────

PG_FILE="$BACKUP_DIR/daily/langfuse-pg-${DATE}.sql.gz"

if [ "$DRY_RUN" = "1" ]; then
  log "info" "[DRY_RUN] Would dump Postgres to $PG_FILE"
else
  log "info" "Dumping Postgres..."
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U langfuse --clean --if-exists langfuse \
    2>/dev/null | gzip > "$PG_FILE"

  PG_SIZE=$(du -h "$PG_FILE" | cut -f1)
  log "info" "Postgres dump OK: $PG_FILE ($PG_SIZE)"
fi

# ── ClickHouse dump ──────────────────────────────────────────────────────────
# Langfuse v3 stores trace/observation data in ClickHouse `default` database.
# We export each non-View table as: CREATE TABLE DDL + data in CSVWithNames.

CH_FILE="$BACKUP_DIR/daily/langfuse-ch-${DATE}.sql.gz"
CH_CONTAINER=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Name}}' 2>/dev/null | grep clickhouse)

if [ "$DRY_RUN" = "1" ]; then
  log "info" "[DRY_RUN] Would dump ClickHouse to $CH_FILE"
else
  log "info" "Dumping ClickHouse..."

  {
    # List non-View tables in default database (where Langfuse v3 stores data)
    docker exec "$CH_CONTAINER" clickhouse-client \
      --query="SELECT name FROM system.tables WHERE database='default' AND engine NOT LIKE '%View%' ORDER BY name" \
      2>/dev/null | while read -r table; do
        echo "-- Table: $table"
        echo "-- DDL:"
        docker exec "$CH_CONTAINER" clickhouse-client \
          --query="SHOW CREATE TABLE default.$table FORMAT TabSeparatedRaw" 2>/dev/null || true
        echo ";"
        echo "-- Data:"
        docker exec "$CH_CONTAINER" clickhouse-client \
          --query="SELECT * FROM default.$table FORMAT CSVWithNames" 2>/dev/null || true
        echo ""
      done
  } | gzip > "$CH_FILE"

  CH_SIZE=$(du -h "$CH_FILE" | cut -f1)
  log "info" "ClickHouse dump OK: $CH_FILE ($CH_SIZE)"
fi

# ── Weekly copy (Sundays) ────────────────────────────────────────────────────

if [ "$DOW" = "7" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "info" "[DRY_RUN] Would copy daily backups to weekly/"
  else
    cp "$PG_FILE" "$BACKUP_DIR/weekly/"
    cp "$CH_FILE" "$BACKUP_DIR/weekly/"
    log "info" "Weekly copy created"
  fi
fi

# ── Rotation ─────────────────────────────────────────────────────────────────

rotate() {
  local dir=$1 keep=$2
  local count
  count=$(find "$dir" -maxdepth 1 -name "langfuse-*" -type f | wc -l)
  if [ "$count" -gt "$((keep * 2))" ]; then
    # keep * 2 because we have pg + ch files per day
    find "$dir" -maxdepth 1 -name "langfuse-*" -type f -printf '%T@ %p\n' \
      | sort -n \
      | head -n "-$((keep * 2))" \
      | cut -d' ' -f2- \
      | while read -r f; do
          if [ "$DRY_RUN" = "1" ]; then
            log "info" "[DRY_RUN] Would delete $f"
          else
            rm "$f"
            log "info" "Rotated: $f"
          fi
        done
  fi
}

rotate "$BACKUP_DIR/daily" "$DAILY_KEEP"
rotate "$BACKUP_DIR/weekly" "$WEEKLY_KEEP"

# ── Summary ──────────────────────────────────────────────────────────────────

TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
log "info" "Backup complete. Total backup storage: $TOTAL_SIZE"

exit 0
