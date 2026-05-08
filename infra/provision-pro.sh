#!/usr/bin/env bash
# provision-pro.sh — Aprovisiona la infra GCP para Langfuse v3 PRO.
#
# === STATUS: REFERENCE — REVISAR antes de ejecutar contra un proyecto real ===
#
# Idempotente: cada paso comprueba si el recurso ya existe antes de crearlo.
# Soporta --dry-run (imprime gcloud commands sin ejecutar).
#
# Plan formal: docs/operations/cloud-run-deployment-plan.md
# Decisión ClickHouse: docs/adr/ADR-012-clickhouse-gce-self-hosted.md
#
# Pre-requisitos:
#   - gcloud autenticado con cuenta que tenga roles/owner sobre el proyecto
#   - APIs habilitadas (compute, run, sql-admin, redis, secretmanager, scheduler,
#     vpcaccess, servicenetworking, storage, certificatemanager)
#   - Variables de entorno: GCP_PROJECT_ID, GCP_REGION, GCP_ZONE, DOMAIN
#
# Uso:
#   export GCP_PROJECT_ID=atlax-langfuse-prod
#   export GCP_REGION=europe-west1
#   export GCP_ZONE=europe-west1-b
#   export DOMAIN=langfuse.atlax360.com
#   bash infra/provision-pro.sh --dry-run     # preview
#   bash infra/provision-pro.sh                # ejecuta
#   bash infra/provision-pro.sh --skip-vpc     # saltarse pasos ya hechos

set -euo pipefail

DRY_RUN=false
SKIP_VPC=false
SKIP_SQL=false
SKIP_REDIS=false
SKIP_GCS=false
SKIP_GCE=false
SKIP_IAM=false
SKIP_SECRETS=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --skip-vpc) SKIP_VPC=true ;;
    --skip-sql) SKIP_SQL=true ;;
    --skip-redis) SKIP_REDIS=true ;;
    --skip-gcs) SKIP_GCS=true ;;
    --skip-gce) SKIP_GCE=true ;;
    --skip-iam) SKIP_IAM=true ;;
    --skip-secrets) SKIP_SECRETS=true ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# //'
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# ── Pre-flight ──────────────────────────────────────────────────────────────

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${GCP_REGION:?Set GCP_REGION}"
: "${GCP_ZONE:?Set GCP_ZONE}"
: "${DOMAIN:?Set DOMAIN (e.g. langfuse.atlax360.com)}"

if ! command -v gcloud >/dev/null; then
  echo "gcloud not found. Install: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
fi

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Predicate helper — exit 0 if resource exists, else 1
exists() {
  if eval "$1" >/dev/null 2>&1; then return 0; else return 1; fi
}

log() { echo "[provision] $*"; }

log "Project=$GCP_PROJECT_ID Region=$GCP_REGION Zone=$GCP_ZONE Domain=$DOMAIN"
log "DRY_RUN=$DRY_RUN"

# ── 1. APIs (requieren ya habilitadas — verificar) ──────────────────────────

log "Checking required APIs..."
for api in \
  compute.googleapis.com \
  run.googleapis.com \
  sql-component.googleapis.com \
  sqladmin.googleapis.com \
  redis.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  vpcaccess.googleapis.com \
  servicenetworking.googleapis.com \
  storage.googleapis.com \
  certificatemanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudbuild.googleapis.com
do
  if ! gcloud services list --project="$GCP_PROJECT_ID" --enabled --format='value(config.name)' | grep -q "^${api}$"; then
    log "Enabling $api..."
    run gcloud services enable "$api" --project="$GCP_PROJECT_ID"
  fi
done

# ── 2. VPC + subnets + firewall + Cloud NAT ─────────────────────────────────

if [[ "$SKIP_VPC" != "true" ]]; then
  log "VPC + subnets..."
  if ! exists "gcloud compute networks describe vpc-langfuse --project=$GCP_PROJECT_ID"; then
    run gcloud compute networks create vpc-langfuse \
      --project="$GCP_PROJECT_ID" \
      --subnet-mode=custom \
      --bgp-routing-mode=regional
  fi

  for subnet_spec in \
    "subnet-run-egress:10.20.0.0/24" \
    "subnet-data:10.20.10.0/24" \
    "subnet-jobs:10.20.20.0/24"
  do
    name="${subnet_spec%%:*}"
    range="${subnet_spec##*:}"
    if ! exists "gcloud compute networks subnets describe $name --region=$GCP_REGION --project=$GCP_PROJECT_ID"; then
      run gcloud compute networks subnets create "$name" \
        --project="$GCP_PROJECT_ID" \
        --network=vpc-langfuse \
        --region="$GCP_REGION" \
        --range="$range" \
        --enable-private-ip-google-access
    fi
  done

  log "Private Services Access for Cloud SQL..."
  if ! exists "gcloud compute addresses describe google-managed-services-vpc-langfuse --global --project=$GCP_PROJECT_ID"; then
    run gcloud compute addresses create google-managed-services-vpc-langfuse \
      --project="$GCP_PROJECT_ID" \
      --global \
      --purpose=VPC_PEERING \
      --addresses=10.20.100.0 \
      --prefix-length=20 \
      --network=vpc-langfuse
    run gcloud services vpc-peerings connect \
      --project="$GCP_PROJECT_ID" \
      --service=servicenetworking.googleapis.com \
      --ranges=google-managed-services-vpc-langfuse \
      --network=vpc-langfuse
  fi

  log "Cloud NAT for outbound (Anthropic API, Slack alerts)..."
  if ! exists "gcloud compute routers describe rt-langfuse --region=$GCP_REGION --project=$GCP_PROJECT_ID"; then
    run gcloud compute routers create rt-langfuse \
      --project="$GCP_PROJECT_ID" \
      --network=vpc-langfuse \
      --region="$GCP_REGION"
    run gcloud compute routers nats create nat-langfuse \
      --project="$GCP_PROJECT_ID" \
      --router=rt-langfuse \
      --region="$GCP_REGION" \
      --auto-allocate-nat-external-ips \
      --nat-all-subnet-ip-ranges
  fi

  log "Firewall rules..."
  if ! exists "gcloud compute firewall-rules describe fw-allow-run-to-data --project=$GCP_PROJECT_ID"; then
    run gcloud compute firewall-rules create fw-allow-run-to-data \
      --project="$GCP_PROJECT_ID" \
      --network=vpc-langfuse \
      --direction=INGRESS \
      --action=ALLOW \
      --rules=tcp:5432,tcp:6379,tcp:8123,tcp:9000 \
      --source-ranges=10.20.0.0/24,10.20.20.0/24 \
      --target-tags=langfuse-data
  fi
  if ! exists "gcloud compute firewall-rules describe fw-allow-iap-ssh --project=$GCP_PROJECT_ID"; then
    run gcloud compute firewall-rules create fw-allow-iap-ssh \
      --project="$GCP_PROJECT_ID" \
      --network=vpc-langfuse \
      --direction=INGRESS \
      --action=ALLOW \
      --rules=tcp:22 \
      --source-ranges=35.235.240.0/20 \
      --target-tags=langfuse-data
  fi
fi

# ── 3. Cloud SQL Postgres ───────────────────────────────────────────────────

if [[ "$SKIP_SQL" != "true" ]]; then
  log "Cloud SQL Postgres..."
  if ! exists "gcloud sql instances describe langfuse-pg --project=$GCP_PROJECT_ID"; then
    SQL_ROOT_PASS=$(openssl rand -base64 32 | tr -d '\n')
    run gcloud sql instances create langfuse-pg \
      --project="$GCP_PROJECT_ID" \
      --database-version=POSTGRES_16 \
      --region="$GCP_REGION" \
      --tier=db-custom-2-7680 \
      --storage-type=SSD \
      --storage-size=50 \
      --network="projects/$GCP_PROJECT_ID/global/networks/vpc-langfuse" \
      --no-assign-ip \
      --backup \
      --backup-start-time=02:00 \
      --enable-point-in-time-recovery \
      --retained-backups-count=14 \
      --retained-transaction-log-days=7 \
      --availability-type=ZONAL \
      --root-password="$SQL_ROOT_PASS"
    log "SQL root password (guardar en bóveda manual, NO en Secret Manager para evitar bootstrap circular):"
    log "  $SQL_ROOT_PASS"
  fi

  if ! exists "gcloud sql databases describe langfuse --instance=langfuse-pg --project=$GCP_PROJECT_ID"; then
    run gcloud sql databases create langfuse --instance=langfuse-pg --project="$GCP_PROJECT_ID"
  fi

  if ! exists "gcloud sql users list --instance=langfuse-pg --project=$GCP_PROJECT_ID --filter=name=langfuse --format=value(name)"; then
    SQL_USER_PASS=$(openssl rand -base64 32 | tr -d '\n')
    run gcloud sql users create langfuse \
      --instance=langfuse-pg \
      --project="$GCP_PROJECT_ID" \
      --password="$SQL_USER_PASS"
    log "Creating secret langfuse-database-url..."
    SQL_HOST=$(gcloud sql instances describe langfuse-pg --project="$GCP_PROJECT_ID" --format='value(ipAddresses[0].ipAddress)' || echo "10.20.100.3")
    DB_URL="postgresql://langfuse:${SQL_USER_PASS}@${SQL_HOST}:5432/langfuse?sslmode=require"
    if ! exists "gcloud secrets describe langfuse-database-url --project=$GCP_PROJECT_ID"; then
      printf '%s' "$DB_URL" | run gcloud secrets create langfuse-database-url \
        --project="$GCP_PROJECT_ID" \
        --replication-policy=user-managed \
        --locations="$GCP_REGION" \
        --data-file=-
    fi
  fi
fi

# ── 4. Memorystore Redis ────────────────────────────────────────────────────

if [[ "$SKIP_REDIS" != "true" ]]; then
  log "Memorystore Redis..."
  if ! exists "gcloud redis instances describe langfuse-redis --region=$GCP_REGION --project=$GCP_PROJECT_ID"; then
    run gcloud redis instances create langfuse-redis \
      --project="$GCP_PROJECT_ID" \
      --tier=STANDARD_HA \
      --size=1 \
      --region="$GCP_REGION" \
      --network=vpc-langfuse \
      --connect-mode=PRIVATE_SERVICE_ACCESS \
      --transit-encryption-mode=SERVER_AUTHENTICATION \
      --enable-auth \
      --redis-version=redis_7_0
  fi
fi

# ── 5. GCS buckets ──────────────────────────────────────────────────────────

if [[ "$SKIP_GCS" != "true" ]]; then
  log "GCS buckets..."
  for bucket in events media clickhouse-backups pg-exports; do
    full="atlax-langfuse-$bucket"
    if ! exists "gcloud storage buckets describe gs://$full --project=$GCP_PROJECT_ID"; then
      run gcloud storage buckets create "gs://$full" \
        --project="$GCP_PROJECT_ID" \
        --location="$GCP_REGION" \
        --uniform-bucket-level-access \
        --public-access-prevention
      run gcloud storage buckets update "gs://$full" --versioning --project="$GCP_PROJECT_ID"
    fi
  done

  log "Lifecycle for events bucket..."
  cat > /tmp/lifecycle-events.json <<'EOF'
{
  "lifecycle": {
    "rule": [
      { "action": {"type": "SetStorageClass", "storageClass": "NEARLINE"},
        "condition": {"age": 30, "matchesStorageClass": ["STANDARD"]}},
      { "action": {"type": "SetStorageClass", "storageClass": "COLDLINE"},
        "condition": {"age": 90, "matchesStorageClass": ["NEARLINE"]}},
      { "action": {"type": "Delete"},
        "condition": {"age": 365, "isLive": false}}
    ]
  }
}
EOF
  run gcloud storage buckets update gs://atlax-langfuse-events \
    --project="$GCP_PROJECT_ID" \
    --lifecycle-file=/tmp/lifecycle-events.json
fi

# ── 6. GCE ClickHouse VM ────────────────────────────────────────────────────

if [[ "$SKIP_GCE" != "true" ]]; then
  log "GCE ClickHouse VM..."
  if ! exists "gcloud iam service-accounts describe clickhouse-vm@$GCP_PROJECT_ID.iam.gserviceaccount.com --project=$GCP_PROJECT_ID"; then
    run gcloud iam service-accounts create clickhouse-vm \
      --project="$GCP_PROJECT_ID" \
      --display-name="ClickHouse VM (langfuse)"
  fi

  if ! exists "gcloud compute addresses describe ip-clickhouse --region=$GCP_REGION --project=$GCP_PROJECT_ID"; then
    run gcloud compute addresses create ip-clickhouse \
      --project="$GCP_PROJECT_ID" \
      --region="$GCP_REGION" \
      --subnet=subnet-data \
      --addresses=10.20.10.20
  fi

  if ! exists "gcloud compute disks describe disk-clickhouse-data --zone=$GCP_ZONE --project=$GCP_PROJECT_ID"; then
    run gcloud compute disks create disk-clickhouse-data \
      --project="$GCP_PROJECT_ID" \
      --size=200GB \
      --type=pd-ssd \
      --zone="$GCP_ZONE"
  fi

  if ! exists "gcloud compute instances describe clickhouse-vm --zone=$GCP_ZONE --project=$GCP_PROJECT_ID"; then
    run gcloud compute instances create clickhouse-vm \
      --project="$GCP_PROJECT_ID" \
      --zone="$GCP_ZONE" \
      --machine-type=n2-highmem-4 \
      --network-interface="network=vpc-langfuse,subnet=subnet-data,private-network-ip=10.20.10.20,no-address" \
      --tags=langfuse-data \
      --image-family=cos-stable \
      --image-project=cos-cloud \
      --boot-disk-size=50GB \
      --boot-disk-type=pd-balanced \
      --disk="name=disk-clickhouse-data,device-name=clickhouse-data,mode=rw,boot=no" \
      --metadata=enable-oslogin=TRUE \
      --service-account="clickhouse-vm@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
      --scopes=cloud-platform \
      --shielded-secure-boot \
      --shielded-vtpm \
      --shielded-integrity-monitoring
  fi

  log "Snapshot policy..."
  if ! exists "gcloud compute resource-policies describe sp-clickhouse-daily --region=$GCP_REGION --project=$GCP_PROJECT_ID"; then
    run gcloud compute resource-policies create snapshot-schedule sp-clickhouse-daily \
      --project="$GCP_PROJECT_ID" \
      --region="$GCP_REGION" \
      --start-time=02:30 \
      --daily-schedule \
      --max-retention-days=7 \
      --on-source-disk-delete=keep-auto-snapshots
    run gcloud compute disks add-resource-policies disk-clickhouse-data \
      --project="$GCP_PROJECT_ID" \
      --resource-policies=sp-clickhouse-daily \
      --zone="$GCP_ZONE"
  fi

  log "ClickHouse VM creada. SIGUIENTE PASO MANUAL:"
  log "  gcloud compute ssh clickhouse-vm --zone=$GCP_ZONE --tunnel-through-iap"
  log "  Dentro de la VM:"
  log "    sudo mkfs.ext4 -F /dev/disk/by-id/google-clickhouse-data"
  log "    sudo mkdir -p /var/lib/clickhouse"
  log "    sudo mount /dev/disk/by-id/google-clickhouse-data /var/lib/clickhouse"
  log "    docker run -d --name clickhouse --restart unless-stopped \\"
  log "      -p 8123:8123 -p 9000:9000 \\"
  log "      -v /var/lib/clickhouse:/var/lib/clickhouse \\"
  log "      -e CLICKHOUSE_USER=default \\"
  log "      -e CLICKHOUSE_PASSWORD=<from Secret Manager> \\"
  log "      -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \\"
  log "      -e TZ=UTC \\"
  log "      --ulimit nofile=262144:262144 \\"
  log "      clickhouse/clickhouse-server:24.12"
fi

# ── 7. Service accounts + IAM ───────────────────────────────────────────────

if [[ "$SKIP_IAM" != "true" ]]; then
  log "Service accounts..."
  for sa in langfuse-web langfuse-worker langfuse-jobs langfuse-scheduler langfuse-gcs-hmac; do
    if ! exists "gcloud iam service-accounts describe $sa@$GCP_PROJECT_ID.iam.gserviceaccount.com --project=$GCP_PROJECT_ID"; then
      run gcloud iam service-accounts create "$sa" \
        --project="$GCP_PROJECT_ID" \
        --display-name="Langfuse $sa"
    fi
  done

  log "Grant roles to langfuse-web..."
  for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
    run gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
      --member="serviceAccount:langfuse-web@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
      --role="$role" \
      --condition=None
  done

  log "Grant roles to langfuse-worker..."
  for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
    run gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
      --member="serviceAccount:langfuse-worker@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
      --role="$role" \
      --condition=None
  done

  log "Bucket-scoped permissions..."
  run gcloud storage buckets add-iam-policy-binding gs://atlax-langfuse-events \
    --project="$GCP_PROJECT_ID" \
    --member="serviceAccount:langfuse-gcs-hmac@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"

  run gcloud storage buckets add-iam-policy-binding gs://atlax-langfuse-media \
    --project="$GCP_PROJECT_ID" \
    --member="serviceAccount:langfuse-gcs-hmac@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"

  run gcloud storage buckets add-iam-policy-binding gs://atlax-langfuse-clickhouse-backups \
    --project="$GCP_PROJECT_ID" \
    --member="serviceAccount:langfuse-jobs@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"

  run gcloud storage buckets add-iam-policy-binding gs://atlax-langfuse-pg-exports \
    --project="$GCP_PROJECT_ID" \
    --member="serviceAccount:langfuse-jobs@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"

  log "HMAC key for langfuse-gcs-hmac..."
  if [[ "$DRY_RUN" != "true" ]]; then
    if ! gcloud storage hmac list --project="$GCP_PROJECT_ID" --filter="serviceAccountEmail=langfuse-gcs-hmac@$GCP_PROJECT_ID.iam.gserviceaccount.com" --format='value(accessId)' | grep -q .; then
      gcloud storage hmac create \
        --project="$GCP_PROJECT_ID" \
        --service-account="langfuse-gcs-hmac@$GCP_PROJECT_ID.iam.gserviceaccount.com" > /tmp/hmac.json
      HMAC_ID=$(jq -r '.metadata.accessId' /tmp/hmac.json)
      HMAC_SECRET=$(jq -r '.secret' /tmp/hmac.json)
      shred -u /tmp/hmac.json 2>/dev/null || rm -f /tmp/hmac.json
      log "HMAC ID: $HMAC_ID (guardar en Secret Manager)"
      log "HMAC secret guardado en variable. Ejecutar siguiente bloque para meterlos en Secret Manager."
      export HMAC_ID HMAC_SECRET
    fi
  fi
fi

# ── 8. Secret Manager (los que no se han creado en pasos previos) ───────────

if [[ "$SKIP_SECRETS" != "true" ]]; then
  log "Secret Manager..."

  create_secret() {
    local name=$1
    local value=$2
    if exists "gcloud secrets describe $name --project=$GCP_PROJECT_ID"; then
      log "  $name already exists (skipping)"
      return
    fi
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "[dry-run] gcloud secrets create $name [VALUE_HIDDEN]"
    else
      printf '%s' "$value" | gcloud secrets create "$name" \
        --project="$GCP_PROJECT_ID" \
        --replication-policy=user-managed \
        --locations="$GCP_REGION" \
        --data-file=-
    fi
  }

  # Estables (se generan una vez, no rotar)
  create_secret langfuse-nextauth-secret "$(openssl rand -base64 32 | tr -d '\n')"
  create_secret langfuse-salt "$(openssl rand -base64 32 | tr -d '\n')"
  create_secret langfuse-encryption-key "$(openssl rand -hex 32 | tr -d '\n')"
  create_secret langfuse-init-admin-password "$(openssl rand -base64 24 | tr -d '\n')"

  # ClickHouse password (la VM debe usarla al arrancar el container)
  create_secret langfuse-clickhouse-password "$(openssl rand -base64 32 | tr -d '\n')"

  # ClickHouse URLs (IP privada conocida)
  create_secret langfuse-clickhouse-url "http://10.20.10.20:8123"
  create_secret langfuse-clickhouse-migration-url "clickhouse://default:PLACEHOLDER@10.20.10.20:9000/default"

  # Redis host (Memorystore IP — se obtiene tras crear la instancia)
  if exists "gcloud redis instances describe langfuse-redis --region=$GCP_REGION --project=$GCP_PROJECT_ID"; then
    REDIS_HOST=$(gcloud redis instances describe langfuse-redis --region="$GCP_REGION" --project="$GCP_PROJECT_ID" --format='value(host)')
    REDIS_AUTH=$(gcloud redis instances get-auth-string langfuse-redis --region="$GCP_REGION" --project="$GCP_PROJECT_ID" --format='value(authString)')
    create_secret langfuse-redis-host "$REDIS_HOST"
    create_secret langfuse-redis-auth "$REDIS_AUTH"
  else
    log "  langfuse-redis no existe — saltarse host/auth (re-ejecutar tras crear Redis)"
  fi

  # HMAC keys (si se generaron en paso 7)
  if [[ -n "${HMAC_ID:-}" && -n "${HMAC_SECRET:-}" ]]; then
    create_secret langfuse-gcs-hmac-id "$HMAC_ID"
    create_secret langfuse-gcs-hmac-secret "$HMAC_SECRET"
    unset HMAC_ID HMAC_SECRET
  fi
fi

# ── 9. Resumen ──────────────────────────────────────────────────────────────

log ""
log "=== Provisioning complete (or dry-run) ==="
log ""
log "SIGUIENTE PASO MANUAL:"
log "  1. Conectar a la VM ClickHouse vía IAP SSH (ver mensaje arriba)"
log "  2. Migrar datos (Fase 2 del plan): docs/operations/cloud-run-deployment-plan.md §5"
log "  3. Render manifest:"
log "       export LANGFUSE_VERSION=3.172.1"
log "       envsubst < infra/cloud-run.yaml > /tmp/cloud-run.rendered.yaml"
log "  4. Deploy Cloud Run (Fase 3): gcloud run services replace /tmp/cloud-run.rendered.yaml --region=$GCP_REGION"
log "  5. Custom domain (Fase 4): ver §7 del plan"
log "  6. Cutover (Fase 5): ver §8 del plan"
log ""
log "Recursos creados:"
log "  VPC:         vpc-langfuse"
log "  Subnets:     subnet-run-egress, subnet-data, subnet-jobs"
log "  Postgres:    langfuse-pg ($GCP_REGION)"
log "  Redis:       langfuse-redis ($GCP_REGION)"
log "  ClickHouse:  clickhouse-vm en $GCP_ZONE (IP 10.20.10.20)"
log "  GCS:         atlax-langfuse-{events,media,clickhouse-backups,pg-exports}"
log "  SAs:         langfuse-{web,worker,jobs,scheduler,gcs-hmac}, clickhouse-vm"
log "  Secrets:     langfuse-{database-url,clickhouse-*,redis-*,gcs-hmac-*,nextauth-secret,salt,encryption-key,init-admin-password}"
