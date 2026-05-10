#!/usr/bin/env bash
# clickhouse-backup-s3.sh — Backup ClickHouse PRO a GCS (S3-compat)
#
# === SCOPE ===================================================================
# Defensa en profundidad para ClickHouse PRO. Complementa los snapshots de
# disco GCE (rápidos, mismo zone) con un backup lógico cross-zone en GCS.
#
# Protege contra:
#   - Zonal outage (snapshots de disco son zonales en su versión inicial).
#   - Corrupción lógica que se snapshotea antes de detectarse.
#   - Eliminación accidental de la VM clickhouse-vm.
#
# Cadencia recomendada: semanal vía Cloud Scheduler + Cloud Run Job. Mientras
# eso no esté implementado, ejecutar manualmente en el ciclo de drill (cada
# trimestre) y antes de cualquier operación destructiva (upgrade, migration).
# =============================================================================
#
# Uso:
#   ./scripts/clickhouse-backup-s3.sh                    # backup full
#   ./scripts/clickhouse-backup-s3.sh --dry-run          # preview commands
#
# Pre-requisitos en la máquina del operador:
#   - gcloud CLI autenticado contra atlax360-ai-langfuse-pro
#   - Acceso IAP a la VM clickhouse-vm (rol roles/iap.tunnelResourceAccessor)
#
# Pre-requisitos en GCP:
#   - VM clickhouse-vm en europe-west1-b corriendo el contenedor clickhouse-pro
#   - Bucket gs://atlax360-ai-langfuse-clickhouse-backups con versioning ON
#   - Secret Manager: langfuse-gcs-hmac-id, langfuse-gcs-hmac-secret,
#                     langfuse-clickhouse-password
#
# Exit codes:
#   0 — backup completado y verificado en GCS
#   1 — error de configuración (gcloud, VM no accesible, secrets missing)
#   2 — backup falló durante BACKUP TO S3 o al verificar en GCS

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

GCP_PROJECT_ID="${GCP_PROJECT_ID:-atlax360-ai-langfuse-pro}"
GCP_ZONE="${GCP_ZONE:-europe-west1-b}"
VM_NAME="${VM_NAME:-clickhouse-vm}"
CONTAINER_NAME="${CONTAINER_NAME:-clickhouse-pro}"
GCS_BUCKET="${GCS_BUCKET:-atlax360-ai-langfuse-clickhouse-backups}"
DATABASE="${DATABASE:-default}"
DRY_RUN="${DRY_RUN:-0}"

# Path único con timestamp para evitar colisiones (BACKUP TO S3 falla si existe).
BACKUP_TIMESTAMP="$(date -u +%Y-%m-%d_%H%M%SZ)"
BACKUP_PATH="${DATABASE}_${BACKUP_TIMESTAMP}"
BACKUP_URL="https://storage.googleapis.com/${GCS_BUCKET}/${BACKUP_PATH}/"

# ─── Flags ───────────────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,28p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: flag desconocido: $arg" >&2
      echo "Uso: $0 [--dry-run]" >&2
      exit 1
      ;;
  esac
done

# ─── Helpers ─────────────────────────────────────────────────────────────────

log() {
  local level=$1; shift
  printf '{"ts":"%s","level":"%s","service":"clickhouse-backup-s3","msg":"%s"}\n' \
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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    log "error" "comando requerido no encontrado: $1"
    exit 1
  }
}

# ─── Preflight ───────────────────────────────────────────────────────────────

require_cmd gcloud

log "info" "preflight: project=$GCP_PROJECT_ID vm=$VM_NAME bucket=$GCS_BUCKET"

# Verificar que la VM existe y está corriendo
VM_STATUS=$(gcloud compute instances describe "$VM_NAME" \
  --zone="$GCP_ZONE" --project="$GCP_PROJECT_ID" \
  --format="value(status)" 2>/dev/null || echo "MISSING")
if [[ "$VM_STATUS" != "RUNNING" ]]; then
  log "error" "VM $VM_NAME no está RUNNING (status=$VM_STATUS)"
  exit 1
fi

# Verificar que el bucket existe
if ! gcloud storage buckets describe "gs://$GCS_BUCKET" \
     --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
  log "error" "bucket gs://$GCS_BUCKET no existe en $GCP_PROJECT_ID"
  exit 1
fi

# ─── Cargar credenciales desde Secret Manager ────────────────────────────────

log "info" "cargando credenciales desde Secret Manager"

if [[ "$DRY_RUN" != "1" ]]; then
  HMAC_ID=$(gcloud secrets versions access latest \
    --secret=langfuse-gcs-hmac-id --project="$GCP_PROJECT_ID")
  HMAC_SECRET=$(gcloud secrets versions access latest \
    --secret=langfuse-gcs-hmac-secret --project="$GCP_PROJECT_ID")
  CH_PASSWORD=$(gcloud secrets versions access latest \
    --secret=langfuse-clickhouse-password --project="$GCP_PROJECT_ID")

  [[ -z "$HMAC_ID" || -z "$HMAC_SECRET" || -z "$CH_PASSWORD" ]] && {
    log "error" "alguna credencial vino vacía desde Secret Manager"
    exit 1
  }
else
  HMAC_ID="<hmac-id-from-secret>"
  HMAC_SECRET="<hmac-secret-from-secret>"
  CH_PASSWORD="<ch-pwd-from-secret>"
fi

# ─── BACKUP TO S3 vía SSH IAP ────────────────────────────────────────────────

log "info" "iniciando BACKUP TO S3: $BACKUP_URL"

# El BACKUP es síncrono por defecto cuando NO se usa ASYNC.
# Para datasets grandes se podría usar ASYNC + polling de system.backups,
# pero para piloto (1-50M traces) el síncrono es suficiente y más simple.
#
# Quoting del SQL: lo escribimos a archivo temp en la VM y ejecutamos con -f
# para evitar problemas de escape con comillas anidadas en SSH.

SQL_TMP="/tmp/backup-${BACKUP_TIMESTAMP}.sql"

# Construir el SQL en local
BACKUP_SQL="BACKUP DATABASE ${DATABASE} TO S3('${BACKUP_URL}', '${HMAC_ID}', '${HMAC_SECRET}');"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] gcloud compute ssh $VM_NAME --zone=$GCP_ZONE --tunnel-through-iap"
  echo "[dry-run]   sudo docker exec -i $CONTAINER_NAME clickhouse-client --user=langfuse --password=*** --query=\"$BACKUP_SQL\""
else
  # Ejecutar el BACKUP via SSH IAP. Pasamos el SQL via stdin para evitar
  # interpolación shell del HMAC_SECRET en la cmdline (visible en `ps`).
  # Usamos `sudo` porque el usuario SSH no está en el grupo `docker` de la VM.
  if ! echo "$BACKUP_SQL" | gcloud compute ssh "$VM_NAME" \
       --zone="$GCP_ZONE" --project="$GCP_PROJECT_ID" \
       --tunnel-through-iap \
       --command="sudo docker exec -i $CONTAINER_NAME clickhouse-client --user=langfuse --password='$CH_PASSWORD' --multiquery" 2>&1; then
    log "error" "BACKUP TO S3 falló — revisar permisos del SA langfuse-jobs sobre el bucket o credenciales HMAC"
    exit 2
  fi
  log "info" "BACKUP TO S3 completado en ClickHouse"
fi

# ─── Verificar en GCS ────────────────────────────────────────────────────────

log "info" "verificando objetos en GCS"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] gcloud storage ls gs://$GCS_BUCKET/$BACKUP_PATH/ --recursive"
else
  OBJECT_COUNT=$(gcloud storage ls "gs://$GCS_BUCKET/$BACKUP_PATH/" \
    --recursive --project="$GCP_PROJECT_ID" 2>/dev/null | wc -l)

  if [[ "$OBJECT_COUNT" -lt 1 ]]; then
    log "error" "no se encontraron objetos en gs://$GCS_BUCKET/$BACKUP_PATH/"
    exit 2
  fi

  TOTAL_SIZE=$(gcloud storage du "gs://$GCS_BUCKET/$BACKUP_PATH/" \
    --project="$GCP_PROJECT_ID" --summarize 2>/dev/null | awk '{print $1}')

  log "info" "backup verificado: $OBJECT_COUNT archivos, ${TOTAL_SIZE:-?} bytes"
fi

# ─── Resumen ─────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "1" ]]; then
  log "info" "DRY-RUN completado — ningún cambio aplicado"
else
  log "info" "backup completado: gs://$GCS_BUCKET/$BACKUP_PATH/"
  echo ""
  echo "Para restaurar más adelante:"
  echo ""
  echo "  RESTORE DATABASE ${DATABASE} AS ${DATABASE}_restored"
  echo "  FROM S3('${BACKUP_URL}', '<HMAC_ID>', '<HMAC_SECRET>');"
  echo ""
fi
