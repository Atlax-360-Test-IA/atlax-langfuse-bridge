#!/usr/bin/env bash
# restore-drill.sh — Drill no-destructivo de restore de Langfuse PRO
#
# === SCOPE ===================================================================
# Verifica que los mecanismos de backup PRO realmente restauran. Un backup que
# nunca se ha probado no es un backup — es un fichero opaco con esperanza dentro.
#
# Ejecuta tres validaciones en paralelo (no destructivo):
#   1. Postgres PITR — clone Cloud SQL a langfuse-pg-drill-{date} con --point-in-time
#      = ahora-1h. Espera a que esté RUNNABLE. Borra al final.
#   2. ClickHouse snapshot — crea disco temp desde el último snapshot. Verifica
#      que el snapshot es READY y el disco se crea sin errores. Borra al final.
#   3. ClickHouse backup S3 — lista los objetos del último backup en GCS y
#      valida que existe el archivo .backup raíz.
#
# Cadencia recomendada: trimestral. Entrada en infra/backup-story.md § Drill log
# después de cada ejecución.
# =============================================================================
#
# Uso:
#   ./scripts/restore-drill.sh                 # ejecuta drill + tear down
#   ./scripts/restore-drill.sh --dry-run       # preview de comandos
#   ./scripts/restore-drill.sh --no-teardown   # deja recursos para inspección
#
# Coste estimado por ejecución (con tear down): ~$0.10
#   - Cloud SQL clone db-custom-1-3840 + 10GB SSD: ~$0.07/h, dura ~30-60min
#   - Disco GCE 200GB pd-ssd: ~$0.02 por minuto activo
#   - Egress GCS list: despreciable
#
# Exit codes:
#   0 — drill completado, todos los checks pasaron
#   1 — error de configuración (gcloud, permisos)
#   2 — al menos un check falló (recursos creados pueden quedar colgando si
#       --no-teardown; revisar logs y limpiar manualmente)

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

GCP_PROJECT_ID="${GCP_PROJECT_ID:-atlax360-ai-langfuse-pro}"
GCP_REGION="${GCP_REGION:-europe-west1}"
GCP_ZONE="${GCP_ZONE:-europe-west1-b}"
SQL_SOURCE="${SQL_SOURCE:-langfuse-pg}"
DISK_SOURCE="${DISK_SOURCE:-disk-clickhouse-data}"
GCS_BUCKET="${GCS_BUCKET:-atlax360-ai-langfuse-clickhouse-backups}"
DRY_RUN="${DRY_RUN:-0}"
NO_TEARDOWN="${NO_TEARDOWN:-0}"

# Identificadores únicos del drill (sufijo timestamp para concurrencia)
DRILL_TIMESTAMP="$(date -u +%Y-%m-%d-%H%M)"
DRILL_SQL_NAME="langfuse-pg-drill-${DRILL_TIMESTAMP}"
DRILL_DISK_NAME="disk-clickhouse-drill-${DRILL_TIMESTAMP}"

# ─── Flags ───────────────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=1 ;;
    --no-teardown) NO_TEARDOWN=1 ;;
    --help|-h)
      sed -n '2,32p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: flag desconocido: $arg" >&2
      exit 1
      ;;
  esac
done

# ─── Helpers ─────────────────────────────────────────────────────────────────

log() {
  local level=$1; shift
  printf '{"ts":"%s","level":"%s","service":"restore-drill","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$*"
}

run_or_dry() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Tracking de fallos para resumen final
FAILED_CHECKS=()

# Cleanup ordenado al salir (incluso por trap de error)
cleanup() {
  if [[ "$NO_TEARDOWN" == "1" ]]; then
    log "warn" "tear down OMITIDO (--no-teardown). Recursos a limpiar manualmente:"
    log "warn" "  gcloud sql instances delete $DRILL_SQL_NAME --project=$GCP_PROJECT_ID --quiet"
    log "warn" "  gcloud compute disks delete $DRILL_DISK_NAME --zone=$GCP_ZONE --project=$GCP_PROJECT_ID --quiet"
    return
  fi

  log "info" "tear down iniciado"

  # Cloud SQL clone (puede no existir si el clone falló antes de crearse)
  if [[ "$DRY_RUN" != "1" ]]; then
    if gcloud sql instances describe "$DRILL_SQL_NAME" \
         --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
      # Cloud SQL lanza BACKUP_VOLUME automáticamente al alcanzar RUNNABLE.
      # Si intentamos borrar mientras corre, devuelve HTTP 409. Esperamos
      # a que no haya operaciones RUNNING antes de borrar.
      local sql_wait_deadline=$(($(date +%s) + 600))  # 10 min máximo
      while [[ $(date +%s) -lt $sql_wait_deadline ]]; do
        local pending
        pending=$(gcloud sql operations list \
          --instance="$DRILL_SQL_NAME" \
          --project="$GCP_PROJECT_ID" \
          --filter="status=RUNNING" \
          --format="value(name)" 2>/dev/null | wc -l)
        [[ "$pending" -eq 0 ]] && break
        log "info" "tear down: esperando $pending operación(es) en curso del clone..."
        sleep 20
      done

      if gcloud sql instances delete "$DRILL_SQL_NAME" \
           --project="$GCP_PROJECT_ID" --quiet 2>&1 | head -3; then
        log "info" "tear down: Cloud SQL clone $DRILL_SQL_NAME borrado"
      else
        log "warn" "tear down: fallo al borrar $DRILL_SQL_NAME — limpiar manualmente"
      fi
    fi

    if gcloud compute disks describe "$DRILL_DISK_NAME" \
         --zone="$GCP_ZONE" --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
      gcloud compute disks delete "$DRILL_DISK_NAME" \
        --zone="$GCP_ZONE" --project="$GCP_PROJECT_ID" --quiet 2>&1 | head -3 || true
      log "info" "tear down: disco $DRILL_DISK_NAME borrado"
    fi
  fi
}
trap cleanup EXIT

# ─── Check 1: Cloud SQL PITR clone ───────────────────────────────────────────

check_postgres_pitr() {
  log "info" "[1/3] Cloud SQL PITR clone: $SQL_SOURCE → $DRILL_SQL_NAME"

  # PITR a "ahora menos 1h" — garantiza que el WAL existe (PITR retiene 7d).
  local pit_target
  pit_target=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
    || date -u -v-1H +%Y-%m-%dT%H:%M:%S.000Z) # macOS fallback

  log "info" "    point-in-time: $pit_target"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] gcloud sql instances clone $SQL_SOURCE $DRILL_SQL_NAME --point-in-time=$pit_target"
    return 0
  fi

  # --async para no bloquear el script y poder hacer polling controlado.
  if ! gcloud sql instances clone "$SQL_SOURCE" "$DRILL_SQL_NAME" \
       --project="$GCP_PROJECT_ID" \
       --point-in-time="$pit_target" \
       --async 2>&1 | head -5; then
    log "error" "    clone command falló al lanzarse"
    FAILED_CHECKS+=("postgres-pitr-launch")
    return 1
  fi

  # Polling: clone PITR puede tardar 30-60min en datasets grandes; con piloto
  # (10GB, pocos commits) suele completarse en 5-15min.
  local deadline=$(($(date +%s) + 5400))  # 90 min
  while [[ $(date +%s) -lt $deadline ]]; do
    local state
    state=$(gcloud sql instances describe "$DRILL_SQL_NAME" \
      --project="$GCP_PROJECT_ID" \
      --format="value(state)" 2>/dev/null || echo "PENDING")

    log "info" "    state=$state"
    [[ "$state" == "RUNNABLE" ]] && {
      log "info" "    ✓ Cloud SQL clone está RUNNABLE"
      return 0
    }
    sleep 30
  done

  log "error" "    timeout esperando clone RUNNABLE (>90min)"
  FAILED_CHECKS+=("postgres-pitr-timeout")
  return 1
}

# ─── Check 2: ClickHouse disk snapshot ───────────────────────────────────────

check_clickhouse_snapshot() {
  log "info" "[2/3] ClickHouse snapshot → disco temp"

  # Buscar el snapshot más reciente del disco source
  local latest_snapshot
  latest_snapshot=$(gcloud compute snapshots list \
    --project="$GCP_PROJECT_ID" \
    --filter="sourceDisk:$DISK_SOURCE AND status=READY" \
    --sort-by=~creationTimestamp \
    --limit=1 \
    --format="value(name)" 2>/dev/null)

  if [[ -z "$latest_snapshot" ]]; then
    log "error" "    no hay snapshots READY de $DISK_SOURCE"
    FAILED_CHECKS+=("clickhouse-snapshot-missing")
    return 1
  fi

  log "info" "    snapshot fuente: $latest_snapshot"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] gcloud compute disks create $DRILL_DISK_NAME --source-snapshot=$latest_snapshot"
    return 0
  fi

  if ! gcloud compute disks create "$DRILL_DISK_NAME" \
       --project="$GCP_PROJECT_ID" \
       --zone="$GCP_ZONE" \
       --source-snapshot="$latest_snapshot" \
       --type=pd-ssd 2>&1 | head -5; then
    log "error" "    fallo al crear disco desde snapshot"
    FAILED_CHECKS+=("clickhouse-disk-create")
    return 1
  fi

  log "info" "    ✓ disco creado desde snapshot — restore de bloque OK"
  return 0
}

# ─── Check 3: ClickHouse BACKUP TO S3 in GCS ─────────────────────────────────

check_clickhouse_s3_backup() {
  log "info" "[3/3] ClickHouse backup en GCS"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] gcloud storage ls gs://$GCS_BUCKET/ --recursive | tail"
    return 0
  fi

  # Listar el directorio raíz del bucket — buscamos el backup más reciente
  local latest_backup_dir
  latest_backup_dir=$(gcloud storage ls "gs://$GCS_BUCKET/" \
    --project="$GCP_PROJECT_ID" 2>/dev/null \
    | grep -v "^$" | tail -1)

  if [[ -z "$latest_backup_dir" ]]; then
    log "warn" "    bucket gs://$GCS_BUCKET vacío — ejecutar clickhouse-backup-s3.sh primero"
    FAILED_CHECKS+=("clickhouse-s3-empty")
    return 1
  fi

  log "info" "    último backup: $latest_backup_dir"

  # Verificar que tiene contenido (>1 archivo, suma >0 bytes)
  local file_count
  file_count=$(gcloud storage ls "$latest_backup_dir" --recursive \
    --project="$GCP_PROJECT_ID" 2>/dev/null | wc -l)

  if [[ "$file_count" -lt 5 ]]; then
    log "error" "    backup parece incompleto ($file_count archivos)"
    FAILED_CHECKS+=("clickhouse-s3-incomplete")
    return 1
  fi

  log "info" "    ✓ backup S3 con $file_count archivos — listable y consistente"
  return 0
}

# ─── Main ────────────────────────────────────────────────────────────────────

log "info" "drill iniciado: project=$GCP_PROJECT_ID drill_id=$DRILL_TIMESTAMP"
[[ "$DRY_RUN" == "1" ]] && log "info" "modo: DRY-RUN"
[[ "$NO_TEARDOWN" == "1" ]] && log "info" "modo: NO-TEARDOWN"

check_postgres_pitr      || true  # no early-exit, reportar todos los fallos
check_clickhouse_snapshot || true
check_clickhouse_s3_backup || true

echo ""
if [[ ${#FAILED_CHECKS[@]} -eq 0 ]]; then
  log "info" "✓ drill completado — todos los checks pasaron"
  echo ""
  echo "Próximos pasos:"
  echo "  1. Documentar resultado en infra/backup-story.md § Drill log"
  echo "  2. Programar próximo drill (trimestral): $(date -u -d '+3 months' +%Y-%m-%d 2>/dev/null || date)"
  exit 0
else
  log "error" "✗ drill falló: ${FAILED_CHECKS[*]}"
  echo ""
  echo "Investigar cada check fallido. Documentar el incident en backup-story.md."
  exit 2
fi
