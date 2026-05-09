# Plan de Despliegue PRO — Langfuse v3 en Cloud Run

> **Status**: Plan formal, aprobado 2026-05-08. Ejecución stage-by-stage con checkpoints.
> **Decisiones clave fijadas**: GCE self-hosted ClickHouse ([ADR-012](../adr/ADR-012-clickhouse-gce-self-hosted.md)), `minScale=0` en web (cold start aceptado), `minScale=1` en worker (BullMQ loop), dominio custom `langfuse.atlax360.ai` desde día 1, `vpc-access-egress: private-ranges-only` mantenido.

> 📖 **Referencias**: [`infra/cloud-run.yaml`](../../infra/cloud-run.yaml), [`infra/backup-story.md`](../../infra/backup-story.md), [`infra/provision-pro.sh`](../../infra/provision-pro.sh), [ADR-002](../adr/ADR-002-edge-core-split.md) (I-13).

---

## 0. Resumen ejecutivo

Despliegue de la stack Langfuse v3 (web + worker) en Google Cloud Run en `europe-west1`, con ClickHouse self-hosted en una VM Compute Engine en el mismo VPC, Cloud SQL Postgres y Memorystore Redis como backends, GCS como blob storage.

**No migran a Cloud Run** (invariante I-13): `hooks/langfuse-sync.ts`, `scripts/reconcile-traces.ts`, `scripts/detect-tier.ts`, `setup/`, `browser-extension/`. Estos componentes se quedan en cada laptop dev.

**Coste mensual estimado total**: **~$145-180/mes en F1 minimum viable** (decisión 2026-05-09: e2-small ClickHouse, db-custom-1-3840 SQL, Redis BASIC, Cloud LB + NAT postpuestos). Target ~$480-540/mes cuando se promueva a sizing completo (38 devs).

**Downtime real durante migración**: ~15-30 minutos en F2 (export+import de ClickHouse + Postgres dump).

**Tiempo total estimado** de ejecución completa (5 fases): 1-2 días de trabajo dedicado.

---

## 1. Topología target

```
              38 devs (laptops)                                Operadores Atlax
                  │                                                  │
                  │  HTTPS POST /api/public/ingestion                │  https://langfuse.atlax360.ai
                  ▼                                                  ▼
        ┌────────────────────────────────────────────────────────────────────────┐
        │  Google Cloud Load Balancer (HTTPS, regional + global SSL cert)        │
        │   ─ Serverless NEG → langfuse-web                                      │
        │   ─ Cloud Armor: rate-limit 1000 req/min/IP, geo EU+sede               │
        │   ─ Managed cert: langfuse.atlax360.ai                                │
        └────────────────────────────────────────────────────────────────────────┘
                                          │
                              ┌───────────┴───────────┐
                              │  europe-west1         │
                              ▼                       ▼
                  ┌─────────────────┐       ┌─────────────────┐
                  │  langfuse-web   │       │ langfuse-worker │   (Cloud Run gen2)
                  │  minScale=0     │       │ minScale=1      │   cpu-throttling=
                  │  port 3000      │       │ port 3030       │     true / false
                  └────────┬────────┘       └────────┬────────┘
                           │                         │
                           │   Direct VPC egress     │
                           │   (private-ranges-only) │
                           ▼                         ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  vpc-langfuse (10.20.0.0/16)                                 │
        │   ┌────────────────────┐   ┌────────────────────┐           │
        │   │ subnet-run-egress  │   │ subnet-data        │           │
        │   │ 10.20.0.0/24       │   │ 10.20.10.0/24      │           │
        │   │ (Direct VPC NIC)   │   │ Cloud SQL 10.20.10.5│          │
        │   │                    │   │ Memorystore 10.20.10.10        │
        │   │                    │   │ GCE ClickHouse 10.20.10.20     │
        │   └────────────────────┘   └────────────────────┘           │
        └─────────────────────────────────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────┐
        │ GCS:                                           │
        │  • atlax360-ai-langfuse-events       (S3-compat HMAC) │
        │  • atlax360-ai-langfuse-media        (uploads UI)     │
        │  • atlax360-ai-langfuse-clickhouse-backups            │
        │  • atlax360-ai-langfuse-pg-exports                    │
        │  Object Versioning ON · Lifecycle 30/90/365    │
        └────────────────────────────────────────────────┘

        Mantenimiento:
        ┌────────────────────────────────────────────┐
        │ Cloud Scheduler ─► Cloud Run Jobs          │
        │   atlax-clickhouse-backup-daily 02:30 UTC  │
        │   atlax-pg-export-daily 03:00 UTC          │
        │   atlax-restore-drill-quarterly            │
        └────────────────────────────────────────────┘

        FUERA DEL CLOUD (I-13):
        Cada laptop dev: hook + reconciler + detect-tier + browser-extension.
        Salida: HTTPS POST → langfuse.atlax360.ai
```

---

## 2. Coste mensual estimado (referencia, sin compromiso)

### 2.1 F1 Minimum viable (decisión 2026-05-09)

Sizing ajustado al uso real observado del docker-compose actual (90 traces, 22h up):

| Recurso                       | Configuración                                                    | $/mes estimado    |
| ----------------------------- | ---------------------------------------------------------------- | ----------------- |
| **GCE ClickHouse VM**         | e2-small (2 shared vCPU, 2 GB), 50 GB pd-ssd, 20 GB boot         | $30               |
| **Cloud SQL Postgres**        | db-custom-1-3840 (1 vCPU, 3.75 GB), 10 GB SSD auto-grow, PITR 7d | $50               |
| **Memorystore Redis**         | BASIC 1 GB (sin HA), AUTH+TLS                                    | $25               |
| **Cloud Run langfuse-web**    | minScale=0, 1 vCPU, 1 GiB, ~30k req/mes                          | $5-15             |
| **Cloud Run langfuse-worker** | minScale=1, cpu-throttling=false, 1 vCPU, 2 GiB                  | $30-50            |
| **GCS** (4 buckets)           | ~50 GB cumulative, mostly Coldline                               | $2-5              |
| **GCS snapshots ClickHouse**  | 50 GB pd-ssd, 3 snapshots incremental                            | $2                |
| **Secret Manager**            | 11 secrets, ~1k accesses/día                                     | $1                |
| **Cloud Logging/Monitoring**  | <50 GB/mes                                                       | $0 (free)         |
| **Total F1 minimum viable**   |                                                                  | **~$145-180/mes** |

**POSTPONED (provisionar cuando aplique):**

| Recurso                                          | Configuración                         | Cuándo                                      |
| ------------------------------------------------ | ------------------------------------- | ------------------------------------------- |
| Cloud Load Balancer + Cloud Armor + cert managed | 1 forwarding rule HTTPS + 10M req/mes | F4 (cuando hay ≥3 devs onboardados)         |
| Cloud NAT                                        | 1 gateway, ~10 GB egress/mes          | Activación LiteLLM gateway (POST-V1 PV1-A3) |
| Cloud Run Jobs (cron)                            | 5 min/día execution                   | Tras F1 (backups + drills)                  |

### 2.2 Target post-piloto (sizing completo)

Cuando piloto exitoso ≥3 devs × 2 semanas → upgrade incremental sin downtime:

| Recurso                   | Upgrade target                                | $/mes target      |
| ------------------------- | --------------------------------------------- | ----------------- |
| GCE ClickHouse VM         | e2-medium (4 GB) → e2-standard-2 (8 GB)       | $50-80            |
| Cloud SQL Postgres        | db-custom-2-7680 (2 vCPU, 7.5 GB) regional HA | $130              |
| Memorystore Redis         | STANDARD_HA 1 GB                              | $50               |
| Cloud Run langfuse-web    | 2 vCPU, 2 GiB                                 | $20-30            |
| Cloud Run langfuse-worker | 2 vCPU, 4 GiB                                 | $60-80            |
| Cloud LB + Cloud Armor    | activado en F4                                | $25-30            |
| Cloud NAT                 | activado al activar LiteLLM                   | $5-10             |
| **Total target completo** |                                               | **~$480-540/mes** |

> ⚠️ **No son precios oficiales**. Verificar con la calculadora oficial de GCP (`cloud.google.com/products/calculator/`) para `europe-west1` antes de comprometer presupuesto.

---

## 3. Pre-requisitos

Antes de empezar la F1:

| Pre-requisito                                                                                                                                                                  | Cómo verificar                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Proyecto GCP creado con billing habilitado                                                                                                                                     | `gcloud projects describe $GCP_PROJECT_ID`                                        |
| Usuario con `roles/owner` en el proyecto (sólo para provisioning inicial)                                                                                                      | `gcloud projects get-iam-policy $GCP_PROJECT_ID`                                  |
| APIs habilitadas: `compute`, `run`, `sql-admin`, `redis`, `secretmanager`, `cloudscheduler`, `vpcaccess`, `servicenetworking`, `storage`, `certificatemanager`, `compute` (LB) | `gcloud services list --enabled`                                                  |
| Dominio `atlax360.ai` con acceso DNS (panel DonDominio — `dns1.dondominio.com`/`dns2.dondominio.com`) para crear registro A `langfuse.atlax360.ai`                             | El operador conoce el provider DNS                                                |
| Backup actualizado de la instancia docker-compose actual                                                                                                                       | `bash scripts/backup-langfuse.sh` ejecutado <24h atrás                            |
| Credenciales Anthropic Admin API funcionando (verificadas en Paso 2)                                                                                                           | `~/.atlax-ai/reconcile.env` contiene `ANTHROPIC_ADMIN_API_KEY=sk-ant-admin01-...` |
| Cuenta de email para el primer admin de Langfuse                                                                                                                               | Decidido (típicamente `jgcalvo@atlax360.com`)                                     |

**Variables de entorno** que se asumen exportadas durante la ejecución del plan:

```bash
export GCP_PROJECT_ID="atlax360-ai-langfuse-pro"   # convención atlax360-ai-<purpose>-<env>
export GCP_PROJECT_NAME="Atlax 360 · AI · Langfuse · PRO"  # display name
export GCP_REGION="europe-west1"
export GCP_ZONE="europe-west1-b"
export DOMAIN="langfuse.atlax360.ai"
```

---

## 4. Fase 1 — Provisioning de infraestructura

**Objetivo**: tener todos los recursos GCP creados y conectables. **No** despliega Langfuse todavía.

**Tiempo estimado**: 2-3 horas (la mayoría es esperar a que GCP termine de crear instancias).

**Script ejecutable**: `infra/provision-pro.sh` (idempotente, soporta `--dry-run`).

### 4.1 VPC + subnets + firewall rules

```bash
# VPC custom-mode
gcloud compute networks create vpc-langfuse \
  --subnet-mode=custom \
  --bgp-routing-mode=regional

# Subnet para Direct VPC egress de Cloud Run
gcloud compute networks subnets create subnet-run-egress \
  --network=vpc-langfuse \
  --region=$GCP_REGION \
  --range=10.20.0.0/24 \
  --purpose=REGIONAL_MANAGED_PROXY \
  --role=ACTIVE

# Subnet para data backends (SQL, Redis, GCE ClickHouse)
gcloud compute networks subnets create subnet-data \
  --network=vpc-langfuse \
  --region=$GCP_REGION \
  --range=10.20.10.0/24

# Subnet para Cloud Run Jobs (backups, drills)
gcloud compute networks subnets create subnet-jobs \
  --network=vpc-langfuse \
  --region=$GCP_REGION \
  --range=10.20.20.0/24

# Private Services Access range para Cloud SQL (managed by Google)
gcloud compute addresses create google-managed-services-vpc-langfuse \
  --global \
  --purpose=VPC_PEERING \
  --addresses=10.20.100.0 \
  --prefix-length=20 \
  --network=vpc-langfuse

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-vpc-langfuse \
  --network=vpc-langfuse

# Cloud NAT (necesario para egress a Anthropic API desde worker)
gcloud compute routers create rt-langfuse \
  --network=vpc-langfuse \
  --region=$GCP_REGION

gcloud compute routers nats create nat-langfuse \
  --router=rt-langfuse \
  --region=$GCP_REGION \
  --auto-allocate-nat-external-ips \
  --nat-all-subnet-ip-ranges

# Firewall rules
gcloud compute firewall-rules create fw-allow-run-to-data \
  --network=vpc-langfuse \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:5432,tcp:6379,tcp:8123,tcp:9000 \
  --source-ranges=10.20.0.0/24,10.20.20.0/24 \
  --target-tags=langfuse-data
```

**Checkpoint**: `gcloud compute networks describe vpc-langfuse` retorna sin error.

### 4.2 Cloud SQL Postgres

```bash
gcloud sql instances create langfuse-pg \
  --database-version=POSTGRES_16 \
  --region=$GCP_REGION \
  --tier=db-custom-2-7680 \
  --storage-type=SSD \
  --storage-size=50 \
  --network=projects/$GCP_PROJECT_ID/global/networks/vpc-langfuse \
  --no-assign-ip \
  --backup \
  --backup-start-time=02:00 \
  --enable-point-in-time-recovery \
  --retained-backups-count=14 \
  --retained-transaction-log-days=7 \
  --availability-type=ZONAL \
  --root-password="$(openssl rand -base64 32)"

gcloud sql databases create langfuse --instance=langfuse-pg

gcloud sql users create langfuse \
  --instance=langfuse-pg \
  --password="$(openssl rand -base64 32)"
```

> Captura las dos passwords y guárdalas en Secret Manager (paso 4.6).

**Checkpoint**: `gcloud sql instances describe langfuse-pg --format='value(state)'` retorna `RUNNABLE`.

### 4.3 Memorystore Redis

```bash
gcloud redis instances create langfuse-redis \
  --tier=STANDARD_HA \
  --size=1 \
  --region=$GCP_REGION \
  --network=vpc-langfuse \
  --connect-mode=PRIVATE_SERVICE_ACCESS \
  --reserved-ip-range=google-managed-services-vpc-langfuse \
  --transit-encryption-mode=SERVER_AUTHENTICATION \
  --auth-enabled \
  --redis-version=redis_7_0
```

**Checkpoint**: `gcloud redis instances describe langfuse-redis --region=$GCP_REGION --format='value(host,port,authString)'` retorna IP, puerto, password.

### 4.4 GCS buckets

```bash
for bucket in events media clickhouse-backups pg-exports; do
  gcloud storage buckets create gs://atlax360-ai-langfuse-$bucket \
    --location=$GCP_REGION \
    --uniform-bucket-level-access \
    --public-access-prevention
done

# Versioning + lifecycle (events bucket)
cat > /tmp/lifecycle-events.json <<EOF
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
gcloud storage buckets update gs://atlax360-ai-langfuse-events \
  --versioning \
  --lifecycle-file=/tmp/lifecycle-events.json
```

**Checkpoint**: `gcloud storage buckets list | grep atlax360-ai-langfuse` muestra los 4 buckets.

### 4.5 GCE ClickHouse VM

```bash
# Reservar IP estática privada
gcloud compute addresses create ip-clickhouse \
  --region=$GCP_REGION \
  --subnet=subnet-data \
  --addresses=10.20.10.20

# Data disk pd-ssd (separado del boot disk para snapshots independientes)
gcloud compute disks create disk-clickhouse-data \
  --size=200GB \
  --type=pd-ssd \
  --zone=$GCP_ZONE

# VM
gcloud compute instances create clickhouse-vm \
  --zone=$GCP_ZONE \
  --machine-type=n2-highmem-4 \
  --network-interface="network=vpc-langfuse,subnet=subnet-data,private-network-ip=10.20.10.20,no-address" \
  --tags=langfuse-data \
  --image-family=cos-stable \
  --image-project=cos-cloud \
  --boot-disk-size=50GB \
  --boot-disk-type=pd-balanced \
  --disk="name=disk-clickhouse-data,device-name=clickhouse-data,mode=rw,boot=no" \
  --metadata=enable-oslogin=TRUE \
  --service-account=clickhouse-vm@$GCP_PROJECT_ID.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --shielded-secure-boot \
  --shielded-vtpm
```

**Configurar ClickHouse** (vía SSH):

```bash
gcloud compute ssh clickhouse-vm --zone=$GCP_ZONE --tunnel-through-iap

# Dentro de la VM:
sudo mkfs.ext4 -F /dev/disk/by-id/google-clickhouse-data
sudo mkdir -p /var/lib/clickhouse
sudo mount /dev/disk/by-id/google-clickhouse-data /var/lib/clickhouse
echo "/dev/disk/by-id/google-clickhouse-data /var/lib/clickhouse ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab

# Ejecutar ClickHouse vía Docker (COS ya trae Docker)
docker run -d --name clickhouse \
  --restart unless-stopped \
  -p 8123:8123 -p 9000:9000 \
  -v /var/lib/clickhouse:/var/lib/clickhouse \
  -e CLICKHOUSE_USER=default \
  -e CLICKHOUSE_PASSWORD="$(gcloud secrets versions access latest --secret=langfuse-clickhouse-password)" \
  -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
  -e TZ=UTC \
  --ulimit nofile=262144:262144 \
  clickhouse/clickhouse-server:24.12
```

**Snapshot schedule** del data disk:

```bash
gcloud compute resource-policies create snapshot-schedule sp-clickhouse-daily \
  --region=$GCP_REGION \
  --start-time=02:30 \
  --daily-schedule \
  --max-retention-days=7

gcloud compute disks add-resource-policies disk-clickhouse-data \
  --resource-policies=sp-clickhouse-daily \
  --zone=$GCP_ZONE
```

**Checkpoint**: desde la VM, `curl http://localhost:8123/ping` retorna `Ok.`. Desde otra VM en `subnet-run-egress`, `curl http://10.20.10.20:8123/ping` también retorna `Ok.`.

### 4.6 Service Accounts + IAM

```bash
# 4 SAs distintas (least privilege)
for sa in langfuse-web langfuse-worker langfuse-jobs langfuse-scheduler clickhouse-vm; do
  gcloud iam service-accounts create $sa \
    --display-name="Langfuse $sa"
done

# SA dedicada para HMAC keys de GCS (S3-compat para Langfuse)
gcloud iam service-accounts create langfuse-gcs-hmac \
  --display-name="Langfuse GCS HMAC owner (no other perms)"

gcloud storage buckets add-iam-policy-binding gs://atlax360-ai-langfuse-events \
  --member="serviceAccount:langfuse-gcs-hmac@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

gcloud storage buckets add-iam-policy-binding gs://atlax360-ai-langfuse-media \
  --member="serviceAccount:langfuse-gcs-hmac@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# HMAC key
gcloud storage hmac create \
  --service-account=langfuse-gcs-hmac@$GCP_PROJECT_ID.iam.gserviceaccount.com \
  > /tmp/hmac.json
HMAC_ID=$(jq -r '.metadata.accessId' /tmp/hmac.json)
HMAC_SECRET=$(jq -r '.secret' /tmp/hmac.json)
shred -u /tmp/hmac.json

# IAM bindings de cada SA
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
  --member="serviceAccount:langfuse-web@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"
# ... resto de bindings (ver provision-pro.sh)
```

### 4.7 Secret Manager (14 secretos)

```bash
# Helper function
create_secret() {
  local name=$1
  local value=$2
  echo -n "$value" | gcloud secrets create "$name" \
    --replication-policy=user-managed \
    --locations=$GCP_REGION \
    --data-file=-
}

create_secret langfuse-database-url "postgresql://langfuse:PASS@10.20.10.5:5432/langfuse?sslmode=require"
create_secret langfuse-redis-host "10.20.10.10"
create_secret langfuse-redis-auth "$REDIS_AUTH"
create_secret langfuse-clickhouse-url "http://10.20.10.20:8123"
create_secret langfuse-clickhouse-password "$(openssl rand -base64 32)"
create_secret langfuse-gcs-hmac-id "$HMAC_ID"
create_secret langfuse-gcs-hmac-secret "$HMAC_SECRET"
create_secret langfuse-nextauth-secret "$(openssl rand -base64 32)"
create_secret langfuse-salt "$(openssl rand -base64 32)"
create_secret langfuse-encryption-key "$(openssl rand -hex 32)"
create_secret langfuse-init-admin-password "$(openssl rand -base64 24)"
# litellm-* y anthropic-org-api-key sólo si M3 activo
```

**Checkpoint**: `gcloud secrets list | grep langfuse-` muestra los 11 secretos (14 si LiteLLM).

---

## 5. Fase 2 — Migración de datos desde docker-compose local

**Objetivo**: traspasar Postgres + ClickHouse desde la instancia local (PoC) al entorno PRO.

**Tiempo estimado**: 30-60 minutos.
**Downtime real**: ~15 minutos (desde el inicio del backup hasta validación post-restore).

### 5.1 Pre-flight: ejecutar backup local

```bash
cd ~/work/atlax-langfuse-bridge
bash scripts/backup-langfuse.sh
# Genera: ~/.atlax-ai/backups/2026-05-08/{pg.dump,clickhouse-backup/}
```

### 5.2 Postgres: dump → Cloud SQL

```bash
# Subir el dump a GCS para que Cloud SQL pueda importarlo
gcloud storage cp ~/.atlax-ai/backups/$(date +%Y-%m-%d)/pg.dump \
  gs://atlax360-ai-langfuse-pg-exports/migration-$(date +%Y%m%d).dump

# Importar a Cloud SQL
gcloud sql import sql langfuse-pg \
  gs://atlax360-ai-langfuse-pg-exports/migration-$(date +%Y%m%d).dump \
  --database=langfuse
```

**Validación**: `psql` desde una VM en `subnet-run-egress` y `SELECT count(*) FROM "Project";` retorna ≥1.

### 5.3 ClickHouse: BACKUP TO S3 → RESTORE

```sql
-- En la instancia local
BACKUP DATABASE default
TO S3(
  'https://storage.googleapis.com/atlax360-ai-langfuse-clickhouse-backups/migration-2026-05-08/',
  '${HMAC_ID}',
  '${HMAC_SECRET}'
)
SETTINGS support_batch_delete = false;

-- En la VM ClickHouse PRO (vía clickhouse-client desde otra VM IAP'd)
RESTORE DATABASE default
FROM S3(
  'https://storage.googleapis.com/atlax360-ai-langfuse-clickhouse-backups/migration-2026-05-08/',
  '${HMAC_ID}',
  '${HMAC_SECRET}'
)
SETTINGS support_batch_delete = false;
```

**Validación**: contar filas en cada tabla principal y comparar contra la instancia origen.

```sql
SELECT 'traces' AS table, count() FROM traces
UNION ALL SELECT 'observations', count() FROM observations
UNION ALL SELECT 'scores', count() FROM scores;
```

### 5.4 Smoke local→PRO con un trace nuevo

Antes de Fase 3, comprobar que la VM ClickHouse acepta inserciones desde una VM intermedia (no desde Cloud Run aún, que no existe):

```bash
gcloud compute ssh clickhouse-vm --zone=$GCP_ZONE
docker exec clickhouse clickhouse-client \
  --query "INSERT INTO traces (id, timestamp) VALUES ('smoke-$(date +%s)', now())"
docker exec clickhouse clickhouse-client \
  --query "SELECT id FROM traces WHERE id LIKE 'smoke-%' ORDER BY timestamp DESC LIMIT 1"
```

**Checkpoint**: la VM ClickHouse responde a queries y los datos migrados están presentes.

---

## 6. Fase 3 — Deploy Cloud Run (web + worker)

**Objetivo**: poner Langfuse v3 web + worker en Cloud Run apuntando a los backends PRO.

**Tiempo estimado**: 2-4h la primera vez (debugging de IAM, secret bindings, healthchecks).

### 6.1 Aplicar el manifest

```bash
# Renderizar variables del template
envsubst < infra/cloud-run.yaml > /tmp/cloud-run.rendered.yaml

# Deploy con --no-traffic (la nueva revisión recibe 0% del tráfico hasta promover)
gcloud run services replace /tmp/cloud-run.rendered.yaml \
  --region=$GCP_REGION
```

### 6.2 Verificar startup probes

Cloud Run tarda 60-150s en arrancar la primera vez (Prisma migrations + ClickHouse client init). Monitorizar logs:

```bash
gcloud run services logs tail langfuse-web --region=$GCP_REGION
```

**Esperar**: `INFO: Server listening on port 3000`. Si aparece `[startupProbe failed]` >5 veces, revisar:

- Que los secrets están bindados (cada env var tiene `valueFrom.secretKeyRef`)
- Que la SA tiene `roles/secretmanager.secretAccessor` sobre cada secreto
- Que la conexión privada al backend funciona (Postgres → `nc -zv 10.20.10.5 5432` desde una VM debug)

### 6.3 Promover tráfico (después de validar)

```bash
gcloud run services update-traffic langfuse-web \
  --to-revisions=LATEST=100 \
  --region=$GCP_REGION

gcloud run services update-traffic langfuse-worker \
  --to-revisions=LATEST=100 \
  --region=$GCP_REGION
```

### 6.4 Smoke E2E contra Cloud Run

```bash
LANGFUSE_HOST="$(gcloud run services describe langfuse-web --region=$GCP_REGION --format='value(status.url)')" \
LANGFUSE_PUBLIC_KEY=pk-test \
LANGFUSE_SECRET_KEY=sk-test \
bun run scripts/smoke-mcp-e2e.ts
```

**Checkpoint**: `*.run.app` URL responde a `/api/public/health` con HTTP 200.

---

## 7. Fase 4 — Custom domain + Cloud Armor

**Objetivo**: poner `langfuse.atlax360.ai` con TLS managed y rate-limit.

**Tiempo estimado**: 1-2 horas (la mayoría es esperar a que el cert SSL managed se aprovisione, ~30 min).

### 7.1 Reservar IP global + cert managed

```bash
gcloud compute addresses create ip-langfuse-lb --global

CERT_NAME="cert-langfuse"
gcloud certificate-manager certificates create $CERT_NAME \
  --domains="langfuse.atlax360.ai"
```

### 7.2 Apuntar DNS

En el provider DNS de `atlax360.com`, crear:

```
A  langfuse  →  $(gcloud compute addresses describe ip-langfuse-lb --global --format='value(address)')
```

> El cert managed valida ownership via DNS challenge. Tarda 15-30 min en pasar a `ACTIVE`.

### 7.3 Serverless NEG + URL map + LB

```bash
# NEG apuntando a Cloud Run
gcloud compute network-endpoint-groups create neg-langfuse-web \
  --region=$GCP_REGION \
  --network-endpoint-type=serverless \
  --cloud-run-service=langfuse-web

# Backend service
gcloud compute backend-services create bs-langfuse \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED \
  --protocol=HTTPS

gcloud compute backend-services add-backend bs-langfuse \
  --global \
  --network-endpoint-group=neg-langfuse-web \
  --network-endpoint-group-region=$GCP_REGION

# URL map
gcloud compute url-maps create urlmap-langfuse \
  --default-service=bs-langfuse

# HTTPS proxy + forwarding rule
gcloud compute target-https-proxies create proxy-langfuse \
  --url-map=urlmap-langfuse \
  --certificate-manager-certificates=$CERT_NAME

gcloud compute forwarding-rules create fr-langfuse \
  --global \
  --target-https-proxy=proxy-langfuse \
  --address=ip-langfuse-lb \
  --ports=443
```

### 7.4 Cloud Armor policy

```bash
gcloud compute security-policies create armor-langfuse \
  --description="rate-limit + geo EU"

# Rate limit: 1000 req/min/IP
gcloud compute security-policies rules create 100 \
  --security-policy=armor-langfuse \
  --action=throttle \
  --rate-limit-threshold-count=1000 \
  --rate-limit-threshold-interval-sec=60 \
  --conform-action=allow \
  --exceed-action=deny-429 \
  --enforce-on-key=IP \
  --src-ip-ranges='*'

# Geo-fence: allow EU + España (sede)
gcloud compute security-policies rules create 200 \
  --security-policy=armor-langfuse \
  --action=allow \
  --expression="origin.region_code in ['ES','FR','DE','PT','IT','NL','BE','SE','DK','FI','IE','AT']"

gcloud compute backend-services update bs-langfuse \
  --global \
  --security-policy=armor-langfuse
```

**Checkpoint**: `curl -I https://langfuse.atlax360.ai/api/public/health` retorna `HTTP/2 200`.

---

## 8. Fase 5 — Validación + cutover

**Objetivo**: confirmar que el bridge local de jgcalvo apunta al PRO y emite traces correctamente. Luego distribuir a 13 devs.

**Tiempo estimado**: 1h validación + comunicación a equipo.

### 8.1 Update local del operador

```bash
# Backup de la config actual (rollback rápido)
cp ~/.atlax-ai/reconcile.env ~/.atlax-ai/reconcile.env.bak.$(date +%Y%m%d)

# Apuntar al PRO
sed -i 's|LANGFUSE_HOST=.*|LANGFUSE_HOST=https://langfuse.atlax360.ai|' ~/.atlax-ai/reconcile.env

# Si las pk-lf/sk-lf nuevas son distintas (Langfuse PRO genera projects nuevos):
# 1. Login en https://langfuse.atlax360.ai con LANGFUSE_INIT_ADMIN_*
# 2. Crear proyecto "atlax-claude"
# 3. Copiar pk-lf-... y sk-lf-... a ~/.atlax-ai/reconcile.env

# Recargar cron del reconciler
systemctl --user restart atlax-langfuse-reconcile.timer
```

### 8.2 Smoke con sesión real

Cerrar una sesión Claude Code corta y verificar que aparece en `https://langfuse.atlax360.ai`:

```bash
# Esperar 1 min, luego:
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  https://langfuse.atlax360.ai/api/public/traces?limit=5 \
  | jq '.data[].name'
```

**Esperado**: aparece `claude-code-session` con timestamp reciente.

### 8.3 Validación intensiva (re-ejecutar Paso 2)

```bash
LANGFUSE_HOST=https://langfuse.atlax360.ai bun run /tmp/atlax-validation/validate-consistency.ts
```

**Esperado**: 0 issues críticos. TURNS_DRIFT en sesiones activas es esperado (2-layer consistency).

### 8.4 Distribuir a los 13 devs

Para cada dev del piloto:

```bash
# El dev ejecuta:
bash setup/setup.sh \
  "https://langfuse.atlax360.ai" \
  "<pk-lf-su-clave>" \
  "<sk-lf-su-clave>"
```

> Las claves pk-lf/sk-lf son **compartidas** dentro del proyecto Langfuse — el `userId` se distingue por `git config user.email`. Si Atlax quiere granularidad de proyecto Langfuse por dev, crear un Langfuse project distinto para cada dev (overhead de gestión, no recomendado para un piloto de 13).

### 8.5 Bridge-health monitoring 7 días

Durante la primera semana post-cutover, vigilar diariamente:

- Bridge-health trace en Langfuse (`status:ok` esperado)
- Logs Cloud Run para errores
- Cloud Monitoring: `request_count`, `error_rate`, `instance_count`
- Disk usage en `/var/lib/clickhouse` (no debería crecer >1 GB/semana)

---

## 9. Rollback plan

### Rollback Cloud Run revision

```bash
PREV=$(gcloud run revisions list --service=langfuse-web --region=$GCP_REGION --format='value(name)' --limit=2 | tail -1)
gcloud run services update-traffic langfuse-web \
  --to-revisions=$PREV=100 \
  --region=$GCP_REGION
```

> Tiempo de rollback: <2 minutos.

### Rollback completo a docker-compose local

Si el PRO falla irrecuperablemente durante F5:

```bash
sed -i 's|LANGFUSE_HOST=.*|LANGFUSE_HOST=http://localhost:3000|' ~/.atlax-ai/reconcile.env
systemctl --user restart atlax-langfuse-reconcile.timer
# Levantar docker-compose si estaba parado
cd docker && docker compose up -d
```

> Tiempo de rollback: <5 minutos. Las trazas ya en PRO se pierden hasta el próximo backup → restore.

---

## 10. Post-deploy: Cloud Scheduler + Cloud Run Jobs

Una vez la stack está operativa, automatizar el mantenimiento.

### 10.1 Backup ClickHouse diario

```bash
# Crear el Cloud Run Job
gcloud run jobs create atlax-clickhouse-backup \
  --region=$GCP_REGION \
  --image=gcr.io/google.com/cloudsdktool/cloud-sdk:slim \
  --service-account=langfuse-jobs@$GCP_PROJECT_ID.iam.gserviceaccount.com \
  --set-secrets="CLICKHOUSE_HOST=langfuse-clickhouse-url:latest,CLICKHOUSE_PASSWORD=langfuse-clickhouse-password:latest,HMAC_ID=langfuse-gcs-hmac-id:latest,HMAC_SECRET=langfuse-gcs-hmac-secret:latest" \
  --command=/bin/bash \
  --args="-c,curl -u default:\$CLICKHOUSE_PASSWORD -X POST \"\$CLICKHOUSE_HOST/?query=BACKUP+DATABASE+default+TO+S3('https://storage.googleapis.com/atlax360-ai-langfuse-clickhouse-backups/\$(date +%%Y-%%m-%%d)/','\$HMAC_ID','\$HMAC_SECRET')+SETTINGS+support_batch_delete%%3Dfalse\"" \
  --vpc-egress=private-ranges-only \
  --network=vpc-langfuse \
  --subnet=subnet-jobs

# Cloud Scheduler dispara el Job
gcloud scheduler jobs create http atlax-clickhouse-backup-daily \
  --location=$GCP_REGION \
  --schedule="30 2 * * *" \
  --time-zone=UTC \
  --uri="https://run.googleapis.com/v2/projects/$GCP_PROJECT_ID/locations/$GCP_REGION/jobs/atlax-clickhouse-backup:run" \
  --http-method=POST \
  --oauth-service-account-email=langfuse-scheduler@$GCP_PROJECT_ID.iam.gserviceaccount.com
```

### 10.2 Restore drill quarterly

```bash
gcloud scheduler jobs create http atlax-restore-drill \
  --location=$GCP_REGION \
  --schedule="0 4 1 */3 *" \  # Día 1 de cada trimestre
  --time-zone=UTC \
  --uri="https://run.googleapis.com/v2/projects/$GCP_PROJECT_ID/locations/$GCP_REGION/jobs/atlax-restore-drill:run" \
  --http-method=POST \
  --oauth-service-account-email=langfuse-scheduler@$GCP_PROJECT_ID.iam.gserviceaccount.com
```

> El drill ejecuta `RESTORE` en una VM ClickHouse paralela y compara conteos. Documentado en `infra/backup-story.md`.

---

## 11. Cambios al `cloud-run.yaml` actual (consolidados)

Los 9 cambios identificados en la auditoría de topología, aplicados:

| #      | Cambio                                                               | Razón                                                                    |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1      | `vpc-access-connector` → `network-interfaces` (Direct VPC egress)    | Connector es legacy; Direct VPC es GA, scales-to-zero                    |
| 2      | Eliminar `cloudsql-instances`                                        | Cambio a Private IP via Direct VPC (1ms latency, sin proxy)              |
| 3      | `livenessProbe.periodSeconds` web/worker → 60, `failureThreshold: 3` | UI hace SSE streams largos; evitar kills durante CPU spike               |
| 4      | `timeoutSeconds` web → 300 (de 60)                                   | Endpoints de export/eval >60s                                            |
| 5      | Añadir `LANGFUSE_S3_MEDIA_UPLOAD_*`                                  | Faltaban en el manifest, sí en docker-compose                            |
| 6      | `OTEL_SDK_DISABLED=true`                                             | Evitar OTel auto-export hasta decidir Cloud Trace                        |
| 7      | SAs verificadas sin `roles/owner` heredado                           | Least privilege                                                          |
| 8      | `run.googleapis.com/execution-environment: gen2` explícito           | Necesario para Direct VPC + healthcheck probes                           |
| 9      | `--no-traffic` en deploy + `update-traffic` en promote               | Permite probar staging antes de cutover                                  |
| **10** | **web: minScale=0 + cpu-throttling=true (default)**                  | **Decisión usuario 2026-05-08: cold start aceptado, ahorra ~$60-80/mes** |
| **11** | **worker: minScale=1 + cpu-throttling=false**                        | **Worker BullMQ necesita CPU continua para poll loop**                   |

---

## 12. Riesgos y mitigaciones (top 5)

| #   | Riesgo                                                          | Mitigación                                                                                                                                                                          |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cold start del web 30-60s afecta UX al primer acceso del día    | Aceptado por el usuario (trade-off de coste). Documentar en runbook. Si se vuelve molesto, subir a `minScale=1` solo en horario laboral via Cloud Scheduler (no implementado en F1) |
| 2   | Fallo total VM ClickHouse → 2-4h RTO                            | Snapshots diarios + backup GCS + drill quarterly. Documentado en ADR-012                                                                                                            |
| 3   | Direct VPC egress cold-start delay >150s                        | startupProbe ya tolera 150s. Si vemos timeouts, subir a 300s                                                                                                                        |
| 4   | NEXTAUTH_SECRET / SALT / ENCRYPTION_KEY rotación rompe Langfuse | Marcadas como **NUNCA rotar** en Secret Manager. Documentado en runbook                                                                                                             |
| 5   | Coste real >> estimado (idle billing inesperado)                | Alert "spend > €25/día" en Cloud Monitoring durante mes 1. Si se dispara, evaluar `minScale=0` también en worker (acepta latencia +2s al primer evento)                             |

---

## 13. Checklist final

Antes de declarar la migración completa:

- [ ] F1 — VPC + subnets + firewall + Cloud SQL + Memorystore + GCS + Secret Manager + GCE ClickHouse aprovisionados
- [ ] F1 — Healthcheck `curl http://localhost:8123/ping` desde la VM responde `Ok.`
- [ ] F2 — `pg_dump` y `BACKUP TO S3` ejecutados con éxito desde la instancia local
- [ ] F2 — `gcloud sql import sql` y `RESTORE FROM S3` completados sin errores
- [ ] F2 — Conteos de filas Postgres y ClickHouse coinciden entre local y PRO (±0)
- [ ] F3 — `gcloud run services replace` exit 0
- [ ] F3 — `*.run.app/api/public/health` retorna 200
- [ ] F3 — Smoke E2E (`scripts/smoke-mcp-e2e.ts`) exit 0
- [ ] F3 — Promoción `update-traffic LATEST=100` aplicada
- [ ] F4 — DNS `langfuse.atlax360.ai` resuelve a la IP del LB
- [ ] F4 — Cert managed en estado `ACTIVE`
- [ ] F4 — `https://langfuse.atlax360.ai/api/public/health` retorna 200
- [ ] F4 — Cloud Armor policy aplicada y verificada con un curl desde IP fuera de EU
- [ ] F5 — `~/.atlax-ai/reconcile.env` de jgcalvo apunta a PRO
- [ ] F5 — Sesión Claude Code reciente aparece en `langfuse.atlax360.ai`
- [ ] F5 — Validación Paso 2 ejecutada contra PRO con 0 issues críticos
- [ ] F5 — Cloud Scheduler jobs (backup, drill) creados
- [ ] F5 — Bridge-health trace `status:ok` durante 24h
- [ ] F5 — Comunicación a 13 devs con instrucciones de onboarding

---

## 14. Siguiente paso después del cutover

Una vez los 13 devs estén onboardados y el sistema lleve ≥7 días con `status:ok`:

1. **Re-ejecutar Paso 2** (validación intensiva de consistencia) contra PRO
2. **Cortar `[1.0.0]` en CHANGELOG**, taggear `v1.0.0`, actualizar `package.json` de `0.6.0-wip` → `1.0.0`
3. **Iniciar items POST-V1** del backlog (`docs/roadmap/post-v1-backlog.md`)

---

_Plan formal aprobado 2026-05-08. Ejecución bajo modo auto con checkpoints cuando se reinicie la sesión._
