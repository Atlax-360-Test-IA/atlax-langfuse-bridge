# Solicitud de despliegue — Langfuse v3 en GCP (piloto v0.6.x)

> **Destinatario**: José Manuel (administrador GCP Atlax360)
> **Solicitante**: Joserra (`jgcalvo@atlax360.com`) — owner `atlax-langfuse-bridge`
> **Fecha**: 2026-04-28
> **Urgencia**: alta — single point of failure activo (instancia hoy en máquina personal)
> **Contexto técnico completo**: [`ARCHITECTURE.md`](../../ARCHITECTURE.md) · [`ADR-002`](../adr/ADR-002-edge-core-split.md) · [`infra/cloud-run.yaml`](../../infra/cloud-run.yaml) · [`infra/backup-story.md`](../../infra/backup-story.md)

---

## 1. Qué necesito y por qué

### 1.1 Objetivo

Levantar el stack **Langfuse v3 self-hosted** del proyecto `atlax-langfuse-bridge` (torre FinOps de uso de Claude Code en Atlax360) en infraestructura GCP gestionada, fuera de mi máquina personal.

### 1.2 Por qué ahora

Razones, en orden de criticidad:

1. **Single point of failure activo**. Hoy Langfuse corre en docker-compose en mi WSL personal (Linux 6.6.87.2-microsoft-standard-WSL2). Si la máquina cae, se borra el disco, o el usuario reinstala WSL, los datos del bridge se pierden parcialmente.
2. **Incidente histórico documentado**. El 22 de abril de 2026 se ejecutó por error un `docker compose down -v` que borró ~3 semanas de trazas previas al 8-abr (anteriores a la ventana de retención del JSONL local). El reconciler recuperó las últimas ~30 días que quedaban en disco; **lo anterior es irrecuperable**. Con instancia productiva + backup off-host esto no debería volver a pasar.
3. **Acceso multi-stakeholder**. El piloto necesita que CTO + managers puedan acceder al dashboard sin VPN a mi máquina ni proxy raro. Cloud Run con IAM o autenticación nativa cubre esto.
4. **Habilita el piloto del bridge**. Hoy soy el único dev que reporta al bridge (84 traces en BD a fecha 28-abr de un único `userId`: el mío). Necesito sacarlo a un endpoint accesible para empezar a desplegar el hook a otros 3-5 devs como piloto controlado.

### 1.3 Qué NO se mueve a GCP

Por diseño (invariante I-13 del proyecto), **NUNCA se migran a Cloud Run**:

- `hooks/langfuse-sync.ts` (necesita filesystem local de cada dev)
- `scripts/reconcile-traces.ts` (escanea `~/.claude/projects/`)
- `scripts/detect-tier.ts` (lee `~/.atlax-ai/tier.json`)
- `browser-extension/` (corre en Chrome del dev)

Solo va a GCP el **stack Langfuse v3** (web UI + worker + sus dependencias de datos). Los devs siguen ejecutando hook + cron locales y POSTean a la URL pública de Langfuse en GCP.

---

## 2. Recursos GCP solicitados

### 2.1 Resumen de coste estimado

Estimación inicial mensual para piloto 3-10 devs (ajustable post-piloto):

| Recurso                                                                   | Tier        | Coste/mes (€) aprox |
| ------------------------------------------------------------------------- | ----------- | ------------------- |
| Cloud Run `langfuse-web` (min 1, max 5, 2 vCPU / 2 GiB)                   | regional    | 50–80               |
| Cloud Run `langfuse-worker` (min 1, max 3, 2 vCPU / 4 GiB)                | regional    | 60–100              |
| Cloud SQL Postgres 15 (`db-custom-2-7680`, PITR enabled)                  | HA opcional | 90–180              |
| Memorystore Redis Standard tier (1 GB, HA)                                | HA          | 50–70               |
| Compute Engine (ClickHouse self-hosted, `e2-standard-2`, disk SSD 100 GB) | sin HA      | 60–80               |
| GCS bucket `atlax-langfuse-events` (Object Versioning + lifecycle)        | regional    | 5–15                |
| VPC Connector                                                             | —           | 10                  |
| Cloud Logging + Monitoring                                                | —           | 5–10                |
| **Total estimado**                                                        |             | **330–545 €/mes**   |

> **Ratio coste/valor**: 330–545 €/mes = ~10–14 % del gasto Anthropic actual de Atlax (~3.900 €/mes). Si el bridge previene **una** anomalía de coste por trimestre detectada con +1 día de antelación, ya recupera la inversión.

### 2.2 Recursos individualizados

#### A. Proyecto GCP

- **Nombre sugerido**: `atlax-finops` (o `atlax-langfuse-prod` si prefieres separación estricta)
- **Region principal**: `europe-west1` (Bélgica) — coherente con resto stack Atlax y data residency UE
- **Billing account**: la de Atlax360
- **Labels**: `team=ai-engineering, owner=jgcalvo@atlax360.com, env=prod, project=atlax-langfuse-bridge`

#### B. Cloud SQL

```
Instancia:    langfuse-pg
Tier:         db-custom-2-7680 (2 vCPU / 7.68 GB RAM)
Versión:      PostgreSQL 15
Storage:      SSD, 30 GB inicial, auto-grow ON, max 200 GB
Backups:      Diario 02:00 UTC + PITR (retención 7 días)
HA:           Pendiente decisión Atlax (single-zone para piloto, regional para v1.0)
Connectivity: Private IP via VPC + Cloud SQL Auth Proxy
DB inicial:   `langfuse` (UTF8, owner `langfuse_user`)
```

> **Nota**: PITR (Point-In-Time Recovery) es **innegociable**. Es el único componente que cierra el riesgo del incidente de 22-abr de forma definitiva.

#### C. Memorystore Redis

```
Instancia:    langfuse-redis
Tier:         Standard (HA)
Capacity:     1 GB
Network:      private VPC (mismo VPC que Cloud SQL)
Auth:         AUTH habilitado
Persistencia: RDB snapshots cada 6h
```

#### D. Compute Engine VM (ClickHouse self-hosted)

```
VM:           clickhouse-langfuse
Machine type: e2-standard-2 (2 vCPU / 8 GB)
Boot disk:    Debian 12 + 50 GB pd-balanced
Data disk:    pd-ssd 100 GB montado en /var/lib/clickhouse
Network tag:  langfuse-internal (firewall: solo VPC privado)
Image:        ClickHouse 24.12 (matchea docker-compose actual)
Backups:      Snapshot diario disco persistente + dump SQL → GCS bucket
```

> **Por qué self-hosted y no ClickHouse Cloud**: para piloto el coste fijo de ClickHouse Cloud (~80–150 €/mes) no compensa frente a 60–80 €/mes en GCE con dump diario a GCS. Si el volumen crece > 5 M traces/mes, reevaluamos. Decisión revisable por Atlax si prefieres managed desde día 1.

#### E. Cloud Storage

```
Bucket:        atlax-langfuse-events
Location:      europe-west1
Storage class: Standard
Versioning:    ENABLED (anti-borrado accidental)
Lifecycle:     - 30d → Nearline
               - 90d → Coldline
               - 365d → Delete non-current versions
HMAC:          Generar par key/secret (Langfuse usa interfaz S3-compatible)
```

```
Bucket:        atlax-langfuse-backups
Location:      europe-west1
Storage class: Standard
Versioning:    ENABLED
Lifecycle:     90d → Coldline
```

> **Bucket de backups separado**: para que los dumps SQL diarios (Postgres + ClickHouse) tengan políticas de retención distintas a los eventos. Auditable separado de datos operativos.

#### F. VPC + conectividad

```
VPC:                atlax-finops-vpc (o reusar vpc Atlax existente si prefieres)
Subnet:             10.10.0.0/24 europe-west1
VPC Connector:      langfuse-vpc-connector (para Cloud Run → Cloud SQL/Redis privado)
Firewall:           - allow internal VPC
                    - deny all from internet a ClickHouse VM
                    - allow Cloud Run service identity → ClickHouse VM 8123
```

#### G. Secret Manager

Crear los siguientes secrets (todos generados aleatoriamente con `openssl rand`):

| Secret name                    | Cómo se genera                                                         | Notas                                     |
| ------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------- |
| `langfuse-database-url`        | manual: `postgresql://langfuse_user:PASS@/langfuse?host=/cloudsql/...` | Connection string Cloud SQL via socket    |
| `langfuse-redis-host`          | output del provisioning Memorystore                                    | IP privada                                |
| `langfuse-redis-auth`          | output del provisioning Memorystore                                    | AUTH password                             |
| `langfuse-clickhouse-url`      | manual: `http://clickhouse-vm-private-ip:8123`                         | URL VM privada                            |
| `langfuse-clickhouse-password` | `openssl rand -base64 32`                                              | Password user `default`                   |
| `langfuse-gcs-hmac-id`         | output `gsutil hmac create`                                            | Access Key ID HMAC                        |
| `langfuse-gcs-hmac-secret`     | output `gsutil hmac create`                                            | Secret Access Key HMAC                    |
| `langfuse-nextauth-secret`     | `openssl rand -base64 32`                                              | NextAuth.js JWT signing                   |
| `langfuse-salt`                | `openssl rand -base64 32`                                              | Hash salt                                 |
| `langfuse-encryption-key`      | `openssl rand -hex 32`                                                 | **64 hex chars exactos** — NO usar base64 |

> **CRÍTICO — `langfuse-encryption-key` y `langfuse-salt`**: una vez Langfuse arranca con estos valores y comienza a cifrar datos en BD, **NUNCA pueden cambiarse**. Cambiarlos invalida toda la base de datos (los API keys cifrados dejan de poder descifrarse). Si necesitas rotación, requiere re-cifrado completo con downtime planificado.

#### H. Service Accounts

```
langfuse-web@PROJECT.iam.gserviceaccount.com
  - roles/cloudsql.client
  - roles/secretmanager.secretAccessor
  - roles/storage.objectAdmin (limitado a bucket atlax-langfuse-events)

langfuse-worker@PROJECT.iam.gserviceaccount.com
  - roles/cloudsql.client
  - roles/secretmanager.secretAccessor
  - roles/storage.objectAdmin (limitado a bucket atlax-langfuse-events)

langfuse-backup@PROJECT.iam.gserviceaccount.com
  - roles/cloudsql.viewer
  - roles/storage.objectCreator (limitado a atlax-langfuse-backups)
  - roles/compute.osLogin (para SSH a VM ClickHouse en cron de backup)
```

Principio least privilege estricto. Sin permisos de proyecto-wide.

#### I. Cloud Run services

Dos servicios coherentes con el manifest [`infra/cloud-run.yaml`](../../infra/cloud-run.yaml) ya existente en el repo:

```
langfuse-web
  Image:    langfuse/langfuse:3.171.0  (pinned, NO usar tag flotante :3)
  CPU:      2 vCPU
  Memory:   2 GiB
  Min:      1 (evitar cold starts)
  Max:      5
  Concurrency: 80
  Timeout:  60 s
  Ingress:  All (UI accesible)
  Auth:     IAM (CTO + managers + jgcalvo) + login Langfuse (email/password)

langfuse-worker
  Image:    langfuse/langfuse-worker:3.171.0  (pinned)
  CPU:      2 vCPU
  Memory:   4 GiB
  Min:      1
  Max:      3
  Concurrency: 1
  Timeout:  300 s
  Ingress:  Internal only
  Auth:     IAM SA (no acceso público)
```

> **Pinning a 3.171.0**: evitar tag flotante `:3` para que un upgrade futuro sea explícito en un PR (`chore(deps): bump langfuse 3.171.0 → 3.172.0`). Reproducibilidad de despliegue.

#### J. Dominio + TLS

```
Hostname:  langfuse.atlax360.com  (sugerido — confirmar con vosotros)
TLS:       Google-managed cert
Mapping:   custom domain → langfuse-web Cloud Run service
```

---

## 3. Pasos de provisioning sugeridos (orden)

Bloques independientes que pueden paralelizarse en parte. Tiempo estimado: **2-3 días de trabajo SRE** si todo va lineal, **1 semana** con holgura para validar y hand-off.

### Fase 1 · Preparar infraestructura (día 1)

1. Crear proyecto GCP `atlax-finops` (o nombre acordado)
2. Habilitar APIs: `run.googleapis.com`, `sqladmin.googleapis.com`, `redis.googleapis.com`, `compute.googleapis.com`, `secretmanager.googleapis.com`, `storage.googleapis.com`, `vpcaccess.googleapis.com`, `cloudbuild.googleapis.com`
3. Crear VPC + subnet + VPC connector
4. Crear los 3 service accounts con roles mínimos
5. Crear buckets GCS (`atlax-langfuse-events`, `atlax-langfuse-backups`)
6. Generar HMAC keys del SA `langfuse-web` para el bucket eventos

### Fase 2 · Datos persistentes (día 1-2)

7. Provisionar Cloud SQL Postgres 15 con PITR
8. Provisionar Memorystore Redis Standard
9. Levantar VM ClickHouse:
   - Instalar ClickHouse 24.12 (mismo tag que docker-compose actual)
   - Configurar `users.xml` con password del Secret Manager
   - Abrir 8123 (HTTP) y 9000 (TCP) **solo desde VPC privado**
   - Test conectividad desde VPC connector

### Fase 3 · Secrets (día 2)

10. Generar y guardar los 10 secrets en Secret Manager con los valores definidos en §2.2.G
11. Verificar permisos `secretmanager.secretAccessor` para los SAs
12. **CRITICAL**: documentar en gestor de secrets de Atlax (Bitwarden / 1Password / lo que uséis) los valores de `langfuse-encryption-key` y `langfuse-salt` con marca "INMUTABLE — pérdida implica re-cifrado completo"

### Fase 4 · Despliegue Cloud Run (día 2-3)

13. Aplicar [`infra/cloud-run.yaml`](../../infra/cloud-run.yaml) (sustituir placeholders `PROJECT` por nombre real)

```bash
sed 's/PROJECT/atlax-finops/g' infra/cloud-run.yaml | gcloud run services replace --region europe-west1 -
```

14. Verificar healthcheck `/api/public/health` responde 200 en `langfuse-web`
15. Mapear dominio custom + cert managed
16. Crear primera org + workspace + user admin (vía UI Langfuse o `LANGFUSE_INIT_*` env vars)

### Fase 5 · Backup automatizado (día 3)

17. Crear Cloud Scheduler job diario 03:00 UTC que ejecuta backup de ClickHouse VM via SSH:

```bash
gcloud compute ssh clickhouse-langfuse --zone europe-west1-b -- \
  'clickhouse-client --query="BACKUP DATABASE default TO Disk('"'"'backup-disk'"'"', '"'"'$(date -I).tar'"'"')"' && \
gsutil cp /var/lib/clickhouse/backup/$(date -I).tar gs://atlax-langfuse-backups/clickhouse/
```

18. Cloud SQL backups ya son automáticos (PITR), solo verificar
19. Verificar restore drill desde GCS bucket → BD vacía

### Fase 6 · Validación + hand-off (día 3)

20. Test ingestion end-to-end:

- Yo configuro `LANGFUSE_HOST=https://langfuse.atlax360.com` en mi `.zshrc`
- Cierro una sesión Claude Code (dispara hook)
- Confirmo trace aparece en UI Langfuse Cloud Run

21. Hand-off a mí con:

- URL UI Langfuse + credenciales admin
- URL Cloud Run worker (privada)
- IDs de los recursos (Cloud SQL, Memorystore, VM ClickHouse, buckets)
- Acceso de lectura para mí en Cloud Logging del proyecto

---

## 4. Datos operativos para migración inicial

### 4.1 Datos a migrar de mi instancia local

| Componente                       | Tamaño actual     | Acción                                              |
| -------------------------------- | ----------------- | --------------------------------------------------- |
| Postgres dump                    | 100 KB comprimido | `pg_restore` directo en Cloud SQL una vez levantado |
| ClickHouse dump                  | 368 KB comprimido | Importar tras provisioning VM                       |
| GCS events                       | N/A               | Reset — eventos antiguos no migran                  |
| Configuración org/workspace/keys | Manual            | Recrear desde cero, tomar nuevas API keys           |

> **Nota**: el volumen actual es despreciable (84 traces totales, **un solo dev reportando**). No hay urgencia de migración perfecta — si los datos legacy se pierden no es desastre porque ya estamos en piloto pre-producción. Lo importante es no perder datos **a partir** del corte.

### 4.2 Plan de corte (cuando todo esté listo)

```
T-0   Provisioning completo, healthcheck verde en Cloud Run
T+1h  Dump final de mi instancia local → restore en Cloud SQL/CH GCP
T+1h  Generación de nuevas API keys en Langfuse PRO
T+2h  Yo actualizo LANGFUSE_HOST + claves en mi .zshrc + ~/.atlax-ai/reconcile.env
T+2h  Verifico que mi siguiente sesión Claude Code aparece en GCP (no en local)
T+1d  Apago docker-compose local
T+7d  Si todo estable, dejo de mantener docker-compose como fallback
T+30d Borrar instancia local y backups locales (dejar 1 mes por seguridad)
```

---

## 5. Acceso y RBAC del piloto

### Lista de acceso inicial (revisable post-piloto)

| Persona                          | Rol Langfuse                  | Rol GCP IAM                               |
| -------------------------------- | ----------------------------- | ----------------------------------------- |
| `jgcalvo@atlax360.com` (Joserra) | Owner workspace `claude-code` | Editor proyecto `atlax-finops`            |
| CTO Atlax (a confirmar email)    | Admin workspace               | Viewer proyecto                           |
| Manager(s) piloto (a confirmar)  | Member workspace              | —                                         |
| `jose-manuel@atlax360.com`       | (no necesita cuenta Langfuse) | Owner proyecto `atlax-finops` (admin SRE) |

> **CFO Atlax**: NO se le da acceso directo a Langfuse. Recibirá reports desagregados solo financieros (formato a definir, probablemente PDF mensual). Decisión documentada para v0.7.0.

---

## 6. Riesgos conocidos y mitigaciones

| Riesgo                                                     | Probabilidad | Impacto | Mitigación                                                                          |
| ---------------------------------------------------------- | ------------ | ------- | ----------------------------------------------------------------------------------- |
| `langfuse-encryption-key` cambiada por error → BD ilegible | baja         | crítico | Documentar en gestor secrets como inmutable + Cloud Audit Logs sobre Secret Manager |
| ClickHouse VM se cae sin replicación                       | media        | medio   | Snapshot diario + dump diario a GCS. RTO ~1h, RPO 24h. Aceptable en piloto.         |
| Cloud Run cold-start lento                                 | baja         | bajo    | `minScale: 1` evita cold starts                                                     |
| Coste GCP supera estimación                                | media        | medio   | Budget alerts en GCP a 80 % y 100 % del estimado mensual                            |
| Dev del piloto reporta a la URL antigua tras corte         | media        | bajo    | Setup script `setup/setup.sh` actualizado + email a piloto                          |
| Pérdida del SA `langfuse-backup`                           | baja         | medio   | Cloud KMS sobre Secret Manager + auditoría regular                                  |

---

## 7. Lo que necesito de ti (José Manuel)

Para arrancar:

1. **Confirmación del proyecto + region**: ¿`atlax-finops` en `europe-west1` te encaja, o tenéis convención distinta?
2. **Confirmación del dominio**: ¿`langfuse.atlax360.com` libre? ¿Otro patrón?
3. **Política de HA**: ¿Cloud SQL en single-zone (más barato, downtime ~horas en zone failure) o regional HA desde día 1 (~+50 % coste)? Mi recomendación para piloto: single-zone, escalar a regional cuando salgamos del piloto.
4. **Política HMAC vs Workload Identity**: el manifest actual usa HMAC keys para que Langfuse hable con GCS via S3-compatible. ¿Vuestra política Atlax permite HMAC, o exigís Workload Identity? (Workload Identity sería custom integration porque Langfuse no lo soporta natively).
5. **Acceso a Cloud Logging**: ¿me das `roles/logging.viewer` para poder debuggear yo mismo sin pedirte SSH cada vez?
6. **Calendario**: ¿qué semana podéis bloquear los 2-3 días de trabajo? Para mí cuanto antes mejor (single point of failure activo), pero respeto vuestras prioridades.

---

## 8. Anexos

### 8.1 Manifest Cloud Run de referencia

[`infra/cloud-run.yaml`](../../infra/cloud-run.yaml) — manifest knative completo, listo para `gcloud run services replace` tras sustituir placeholders `PROJECT`.

### 8.2 Backup story documentada

[`infra/backup-story.md`](../../infra/backup-story.md) — RPO ≤ 1 min objetivo, drill quarterly, GCS lifecycle policy.

### 8.3 ADR-002 — qué migra y qué no

[`docs/adr/ADR-002-edge-core-split.md`](../adr/ADR-002-edge-core-split.md) — invariante I-13 explicado: hook + reconciler + discovery permanecen edge (en cada máquina dev), solo el stack Langfuse v3 va a Cloud Run.

### 8.4 Estado actual de la instancia local (28-abr-2026)

```
Versión:           langfuse/langfuse:3 → 3.167.4 (build 2026-04-10, 1bd069f)
                   (recomendado actualizar a 3.171.0 antes de migrar — security fixes)
Volumen Postgres:  ~100 KB comprimido (84 traces, 1 user, 1 project)
Volumen ClickHouse: ~368 KB comprimido (9 tablas)
Backup local:      activo desde 24-abr-2026 (systemd timer 03:00 diario)
                   Ubicación: ~/.atlax-ai/backups/{daily,weekly}/
                   Retención: 7 daily + 4 weekly (rotación automática)
                   Restore drill: verificado OK 28-abr (Postgres y ClickHouse válidos)
Backup off-host:   ❌ NO EXISTE — todo en filesystem máquina personal
```

### 8.5 Contacto

- **Joserra** — `jgcalvo@atlax360.com` — disponible para sync rápido en cualquier momento
- **Slack/Google Chat**: el que sea más cómodo para vuestro equipo SRE
- **Repo**: https://github.com/Atlax-360-Test-IA/atlax-langfuse-bridge

---

> **Versión del documento**: 1.0 (28-abr-2026)
> **Próxima revisión**: post-confirmación de José Manuel sobre §7
