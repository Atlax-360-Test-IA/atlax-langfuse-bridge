# PRO Env Vars Inventory — atlax-langfuse-bridge

- **Date**: 2026-05-09
- **Owner**: jgcalvo@atlax360.com
- **Target**: GCP project `atlax360-ai-langfuse-pro` (europe-west1)
- **Convención naming GCP**: `atlax360-ai-<purpose>-<env>` (D-009 Shared Platform v0.3)
- **Source-of-truth**: este archivo. `infra/cloud-run.yaml` y `docs/operations/cloud-run-deployment-plan.md` referencian aquí.

Inventario formal de env vars necesarias para el despliegue F1 PRO de Langfuse v3 server (categoría `server-only`, parte core del bridge). Este archivo cumple BG-01 del audit `docs/audits/shared-platform-validation-2026-05-09.md`.

> **Convenciones globales** (heredan de `~/.claude/rules/security.md`):
>
> - Secrets locales en `~/.atlax-ai/<project>.env` con `chmod 600` — NUNCA en `.env.local` commiteado
> - PRO: secretos en GCP Secret Manager del proyecto `atlax360-ai-langfuse-pro`
> - DEV (laptop): secretos en `~/.atlax-ai/atlax-langfuse-bridge.env`

## 1. Provisioning vars (consumidas por `infra/provision-pro.sh`)

| Variable              | Required-by      | PRO                                          | Development (local) | Notes                                                                         |
| --------------------- | ---------------- | -------------------------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`      | provision-pro.sh | `atlax360-ai-langfuse-pro`                   | n/a                 | Convención `atlax360-ai-<purpose>-<env>`. ID GCP no admite puntos.            |
| `GCP_PROJECT_NAME`    | provision-pro.sh | `Atlax 360 · AI · Langfuse · PRO`            | n/a                 | Display name. Opcional — fallback al ID si no se setea.                       |
| `GCP_REGION`          | provision-pro.sh | `europe-west1`                               | n/a                 | Multi-zone HA disponible (-b/-c/-d).                                          |
| `GCP_ZONE`            | provision-pro.sh | `europe-west1-b`                             | n/a                 | Zona para GCE ClickHouse.                                                     |
| `DOMAIN`              | provision-pro.sh | `langfuse.atlax360.ai`                       | n/a                 | Subdominio canónico (D-009 v0.3). DNS en DonDominio hasta migrar a Cloud DNS. |
| `GCP_BILLING_ACCOUNT` | provision-pro.sh | `01596F-DD220B-DCE2D3` (Atlax360 - Devoteam) | n/a                 | Solo necesario con `--create-project`.                                        |
| `GCP_FOLDER_ID`       | provision-pro.sh | `59888934980` (folder AI Suite)              | n/a                 | Opcional. Solo con `--create-project`.                                        |

## 2. Cloud Run web service env vars

### 2.1 Bootstrap / NEXTAUTH

| Variable            | Required-by  | PRO source                                 | DEV source              | Notes                                    |
| ------------------- | ------------ | ------------------------------------------ | ----------------------- | ---------------------------------------- |
| `NEXTAUTH_URL`      | langfuse-web | Plain: `https://langfuse.atlax360.ai`      | `http://localhost:3000` | URL pública del servicio.                |
| `NEXTAUTH_SECRET`   | langfuse-web | Secret Manager: `langfuse-nextauth-secret` | `~/.atlax-ai/...env`    | Generar con `openssl rand -base64 32`.   |
| `SALT`              | langfuse-web | Secret Manager: `langfuse-salt`            | `~/.atlax-ai/...env`    | Salt PII hashing.                        |
| `ENCRYPTION_KEY`    | langfuse-web | Secret Manager: `langfuse-encryption-key`  | `~/.atlax-ai/...env`    | 64 hex chars (`openssl rand -hex 32`).   |
| `TELEMETRY_ENABLED` | langfuse-web | Plain: `false`                             | `false`                 | No telemetría externa.                   |
| `OTEL_SDK_DISABLED` | langfuse-web | Plain: `true`                              | `true`                  | OTel desactivado (SDK no se inicializa). |

### 2.2 Postgres (Cloud SQL)

| Variable       | Required-by           | PRO source                                                                                                                        | DEV source           | Notes                                                                    |
| -------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL` | langfuse-web + worker | Secret Manager: `langfuse-database-url` (formato: `postgresql://USER:PASS@HOST:5432/langfuse?connection_limit=10&pgbouncer=true`) | docker-compose local | `connection_limit=10` para evitar pool exhaustion en `db-custom-1-3840`. |

### 2.3 ClickHouse (GCE self-hosted)

| Variable                     | Required-by           | PRO source                                     | DEV source                    | Notes                                       |
| ---------------------------- | --------------------- | ---------------------------------------------- | ----------------------------- | ------------------------------------------- |
| `CLICKHOUSE_URL`             | langfuse-web + worker | Plain: `http://<gce-ip>:8123` (IP interna VPC) | `http://localhost:8123`       | Puerto HTTP de ClickHouse.                  |
| `CLICKHOUSE_MIGRATION_URL`   | langfuse-web (init)   | Plain: `clickhouse://<gce-ip>:9000`            | `clickhouse://localhost:9000` | Puerto native para migrations.              |
| `CLICKHOUSE_USER`            | langfuse-web + worker | Secret Manager: `langfuse-clickhouse-user`     | `default`                     | Usuario CH (default OK para single-tenant). |
| `CLICKHOUSE_PASSWORD`        | langfuse-web + worker | Secret Manager: `langfuse-clickhouse-password` | `~/.atlax-ai/...env`          | Password CH.                                |
| `CLICKHOUSE_CLUSTER_ENABLED` | langfuse-web + worker | Plain: `false`                                 | `false`                       | Single-node.                                |
| `CLICKHOUSE_MIGRATION_SSL`   | langfuse-web (init)   | Plain: `false`                                 | `false`                       | TLS no necesario en VPC interna.            |

### 2.4 Redis (Memorystore)

| Variable     | Required-by           | PRO source                              | DEV source           | Notes                                        |
| ------------ | --------------------- | --------------------------------------- | -------------------- | -------------------------------------------- |
| `REDIS_HOST` | langfuse-web + worker | Plain: `<memorystore-ip>` (interno VPC) | `localhost`          | Memorystore BASIC 1GB en F1.                 |
| `REDIS_PORT` | langfuse-web + worker | Plain: `6379`                           | `6379`               | Puerto estándar.                             |
| `REDIS_AUTH` | langfuse-web + worker | Secret Manager: `langfuse-redis-auth`   | `~/.atlax-ai/...env` | Auth string. Tier BASIC sin TLS por defecto. |

### 2.5 GCS event upload (S3-compat HMAC)

| Variable                                     | Required-by           | PRO source                                 | DEV source                | Notes                                                                      |
| -------------------------------------------- | --------------------- | ------------------------------------------ | ------------------------- | -------------------------------------------------------------------------- |
| `LANGFUSE_S3_EVENT_UPLOAD_BUCKET`            | langfuse-web + worker | Plain: `atlax360-ai-langfuse-events`       | `langfuse-events` (MinIO) | Bucket events ClickHouse async pipeline.                                   |
| `LANGFUSE_S3_EVENT_UPLOAD_REGION`            | langfuse-web + worker | Plain: `europe-west1`                      | `eu-central-1` (MinIO)    | GCS region.                                                                |
| `LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT`          | langfuse-web + worker | Plain: `https://storage.googleapis.com`    | `http://minio:9000`       | GCS S3-compat endpoint.                                                    |
| `LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE`  | langfuse-web + worker | Plain: `true`                              | `true`                    | GCS requires path-style.                                                   |
| `LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID`     | langfuse-web + worker | Secret Manager: `langfuse-gcs-hmac-id`     | `~/.atlax-ai/...env`      | HMAC ID generado para SA `langfuse-gcs@<project>.iam.gserviceaccount.com`. |
| `LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY` | langfuse-web + worker | Secret Manager: `langfuse-gcs-hmac-secret` | `~/.atlax-ai/...env`      | HMAC secret pareado.                                                       |

### 2.6 GCS media upload (UI uploads)

| Variable                                     | Required-by           | PRO source                                        | DEV source               | Notes                               |
| -------------------------------------------- | --------------------- | ------------------------------------------------- | ------------------------ | ----------------------------------- |
| `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET`            | langfuse-web + worker | Plain: `atlax360-ai-langfuse-media`               | `langfuse-media` (MinIO) | Avatares + exports manuales.        |
| `LANGFUSE_S3_MEDIA_UPLOAD_REGION`            | langfuse-web + worker | Plain: `europe-west1`                             | `eu-central-1`           |                                     |
| `LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT`          | langfuse-web + worker | Plain: `https://storage.googleapis.com`           | `http://minio:9000`      |                                     |
| `LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE`  | langfuse-web + worker | Plain: `true`                                     | `true`                   |                                     |
| `LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID`     | langfuse-web + worker | Secret Manager: `langfuse-gcs-hmac-id` (mismo SA) | `~/.atlax-ai/...env`     | Reutiliza HMAC del SA langfuse-gcs. |
| `LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY` | langfuse-web + worker | Secret Manager: `langfuse-gcs-hmac-secret`        | `~/.atlax-ai/...env`     |                                     |

## 3. Bridge edge-tooling env vars (laptop dev, NUNCA en Cloud Run)

> Estas vars consumen el reconciler/hook/scripts; viven solo en `~/.atlax-ai/atlax-langfuse-bridge.env` con `chmod 600`. Invariante I-13 del bridge: nunca migran a Cloud Run.

| Variable                         | Required-by                      | DEV source                             | Notes                                              |
| -------------------------------- | -------------------------------- | -------------------------------------- | -------------------------------------------------- | ------------- | ------------------ |
| `LANGFUSE_HOST`                  | hook + reconciler + scripts      | `https://langfuse.atlax360.ai`         | Endpoint del bridge tras F1 PRO.                   |
| `LANGFUSE_PUBLIC_KEY`            | hook + reconciler                | `~/.atlax-ai/...env`                   | PK del project en Langfuse UI.                     |
| `LANGFUSE_SECRET_KEY`            | hook + reconciler                | `~/.atlax-ai/...env`                   | SK del project.                                    |
| `ANTHROPIC_ADMIN_KEY`            | reconciler (cost reconciliation) | `~/.atlax-ai/...env`                   | Admin API key (`sk-ant-admin-*`), NO consumer key. |
| `LITELLM_HOST`                   | smoke-litellm-langfuse.ts        | `http://localhost:4001`                | Solo si gateway opt-in (ADR-007).                  |
| `LITELLM_MASTER_KEY`             | smoke-litellm                    | `~/.atlax-ai/...env`                   | Solo opt-in.                                       |
| `MCP_AGENT_TYPE`                 | mcp-server                       | `coordinator`                          | Allowlist: `coordinator                            | trace-analyst | annotator` (I-10). |
| `WINDOW_HOURS`                   | reconciler                       | `24` default, ampliar si sesiones >24h | I-5: ventana mínima 24h, no bajar.                 |
| `ATLAX_TRANSCRIPT_ROOT_OVERRIDE` | hook (testing only)              | unset en runtime real                  | Solo tests. Default: `~/.claude/projects/`.        |
| `ATLAX_DATA_HOME`                | bridge                           | `~/.atlax-ai`                          | Override del data home (poco común).               |

## 4. CI/CD env vars (GitHub Actions)

| Variable              | Source        | Notes                                         |
| --------------------- | ------------- | --------------------------------------------- |
| `LANGFUSE_HOST`       | GitHub Secret | Para smoke E2E. Skip-graceful si no presente. |
| `LANGFUSE_PUBLIC_KEY` | GitHub Secret |                                               |
| `LANGFUSE_SECRET_KEY` | GitHub Secret |                                               |
| `LITELLM_HOST`        | GitHub Secret | Smoke LiteLLM (opcional).                     |
| `LITELLM_MASTER_KEY`  | GitHub Secret |                                               |

## 5. Naming Secret Manager (PRO)

Convención: `langfuse-<purpose>` en el proyecto `atlax360-ai-langfuse-pro`. Lista canónica:

```
langfuse-database-url
langfuse-nextauth-secret
langfuse-salt
langfuse-encryption-key
langfuse-clickhouse-user
langfuse-clickhouse-password
langfuse-redis-auth
langfuse-gcs-hmac-id
langfuse-gcs-hmac-secret
```

Acceso vía Cloud Run: SA `langfuse-cloudrun@atlax360-ai-langfuse-pro.iam.gserviceaccount.com` con `roles/secretmanager.secretAccessor` granular por secret.

## 6. Rotación

| Secret                                     | Rotación recomendada | Mecanismo                                                                                         |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| `NEXTAUTH_SECRET`                          | 90 días              | Generar nuevo + hot-swap en Secret Manager (Cloud Run lee al rolling restart).                    |
| `SALT`                                     | Nunca                | Cambiar invalida hashes existentes — solo en compromiso confirmado.                               |
| `ENCRYPTION_KEY`                           | Nunca                | Cambiar invalida datos cifrados existentes — solo en compromiso confirmado, con migration script. |
| `CLICKHOUSE_PASSWORD`                      | 180 días             | `ALTER USER` en CH + Secret Manager + restart Cloud Run.                                          |
| `REDIS_AUTH`                               | 180 días             | `gcloud redis instances update --auth-string-rotation` + Secret Manager.                          |
| `GCS HMAC` (id + secret)                   | 90 días              | Rotar HMAC del SA `langfuse-gcs` + Secret Manager.                                                |
| `LANGFUSE_PUBLIC_KEY/SECRET_KEY` (per dev) | 365 días             | Cada dev en piloto rota su par desde Langfuse UI; bridge edge re-lee `~/.atlax-ai/...env`.        |

## 7. Validación pre-deploy

Antes de ejecutar F1 PRO real, verificar:

```bash
# Todas las vars de §1 están seteadas
env | grep -E '^(GCP_PROJECT_ID|GCP_REGION|GCP_ZONE|DOMAIN)='

# Naming canónico
[[ "$GCP_PROJECT_ID" == atlax360-ai-* ]] || echo "ERROR: project ID no sigue convención"

# Secrets locales con chmod 600
stat -c '%a' ~/.atlax-ai/atlax-langfuse-bridge.env  # debe ser 600
```

---

**Mantenimiento**: este archivo se actualiza cuando:

1. Se añade/elimina env var en `infra/cloud-run.yaml`
2. Se introduce nuevo Secret en Secret Manager
3. Se rota la convención naming GCP (eventual migración a `atlax-platform`)
4. Se cambia la zona DNS canónica (eventual migración a Cloud DNS)
