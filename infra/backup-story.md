# PRO Backup Story — Langfuse v3 on Cloud Run

**Status (2026-05-10): F1-F4 IMPLEMENTED + first drill executed.** PRO activo en `https://langfuse.atlax360.ai`.

> 📖 Referencias cruzadas:
>
> - [`ARCHITECTURE.md §9`](../ARCHITECTURE.md#§9--seguridad) — secrets management en Cloud Run
> - [`ADR-002`](../docs/adr/ADR-002-edge-core-split.md) — qué migra a Cloud Run y qué se queda local (I-13)
> - [`infra/cloud-run.yaml`](./cloud-run.yaml) — manifest de referencia
> - [`scripts/clickhouse-backup-s3.sh`](../scripts/clickhouse-backup-s3.sh) — operación BACKUP TO S3
> - [`scripts/restore-drill.sh`](../scripts/restore-drill.sh) — drill no-destructivo trimestral

## Current state (2026-05-10)

Verificado contra GCP project `atlax360-ai-langfuse-pro`:

| Componente                                                                                      | Mecanismo                         | Estado                    | Retention                                            | RPO                    | RTO                                           |
| ----------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------- | ---------------------------------------------------- | ---------------------- | --------------------------------------------- |
| **Cloud SQL Postgres** (`langfuse-pg`, `db-custom-1-3840`, 10GB SSD)                            | PITR + WAL archive                | ✅ Activo                 | 7 días backups + 7 días WAL                          | ≤1 min                 | ~15 min (clone PITR)                          |
| **GCS bucket events** (`atlax360-ai-langfuse-events`)                                           | Object Versioning + lifecycle     | ✅ Activo                 | NEARLINE 30d → COLDLINE 90d → delete (non-live) 365d | 0                      | 0                                             |
| **GCS bucket media** (`atlax360-ai-langfuse-media`)                                             | Idem events                       | ✅ Activo                 | Idem events                                          | 0                      | 0                                             |
| **ClickHouse disk snapshot** (`disk-clickhouse-data`, schedule `sp-clickhouse-daily` 02:30 UTC) | gcloud snapshot-schedule          | ✅ Activo                 | 7 días                                               | 24h                    | ~30 min (crear disco desde snapshot + montar) |
| **ClickHouse `BACKUP TO S3`** (`gs://atlax360-ai-langfuse-clickhouse-backups`)                  | `scripts/clickhouse-backup-s3.sh` | ⚠️ Manual (no programado) | bucket sin lifecycle (TODO)                          | hasta última ejecución | ~10-30 min (RESTORE FROM S3)                  |
| **Memorystore Redis** (BASIC 1GB)                                                               | n/a                               | n/a                       | cache efímero                                        | n/a                    | reconstrucción rápida desde Postgres          |

Para detalles operativos por componente, ver las secciones siguientes.

## Goal

Achieve RPO ≤ 1 minute and RTO ≤ 15 minutes for the Langfuse v3 stack in
production, while keeping operational cost reasonable for ~38 active devs.

## Postgres — Cloud SQL PITR

Activado en F1 (PR #80). RPO ≤ 1 min para los últimos 7 días, retención de
WAL en 7 días. Configuración actual:

```bash
# Activar (ya hecho — comando idempotente):
gcloud sql instances patch langfuse-pg \
  --project=atlax360-ai-langfuse-pro \
  --backup-start-time=02:00 \
  --enable-point-in-time-recovery \
  --retained-backups-count=7 \
  --retained-transaction-log-days=7
```

Restore a point-in-time:

```bash
# Time en UTC, formato RFC 3339:
gcloud sql instances clone langfuse-pg langfuse-pg-restore-$(date +%Y%m%d) \
  --project=atlax360-ai-langfuse-pro \
  --point-in-time='2026-05-10T10:30:00.000Z'
```

Tiempo típico del clone: 5-15 minutos para datasets pequeños (PRO actual,
~10GB), hasta 30-60 minutos en datasets grandes. Es seguro dejarlo corriendo;
el coste es despreciable (~$0.07/h con `db-custom-1-3840`).

Por qué PITR vs daily dumps: un snapshot diario a las 02:00 UTC pierde hasta
24h en un incidente de martes por la mañana. Con PITR + WAL, la ventana
colapsa a la última transacción completada.

## ClickHouse — defensa en profundidad (snapshot + BACKUP TO S3)

Estrategia híbrida implementada el 2026-05-10:

### Capa 1: GCE persistent disk snapshot (rápido, mismo zone)

Schedule diario `sp-clickhouse-daily` a las 02:30 UTC con retención 7 días:

```bash
# Configuración (provision-pro.sh es idempotente):
gcloud compute resource-policies create snapshot-schedule sp-clickhouse-daily \
  --project=atlax360-ai-langfuse-pro \
  --region=europe-west1 \
  --start-time=02:30 \
  --daily-schedule \
  --max-retention-days=7 \
  --on-source-disk-delete=keep-auto-snapshots

gcloud compute disks add-resource-policies disk-clickhouse-data \
  --resource-policies=sp-clickhouse-daily \
  --zone=europe-west1-b \
  --project=atlax360-ai-langfuse-pro
```

⚠️ Para cambiar `--max-retention-days` GCP requiere **delete + recreate**;
`gcloud compute resource-policies update` no permite modificar este campo.

Restore: crear un disco nuevo desde el snapshot (no requiere downtime de la
VM source):

```bash
gcloud compute disks create disk-clickhouse-restored \
  --source-snapshot=<snapshot-name> \
  --zone=europe-west1-b \
  --project=atlax360-ai-langfuse-pro
# Luego attach a una VM nueva o sustituir el disk de clickhouse-vm.
```

### Capa 2: BACKUP TO S3 (lógico, cross-zone, vía `scripts/clickhouse-backup-s3.sh`)

Protege contra: zonal outage (los snapshots de disco son zonales en su
versión inicial), corrupción lógica que se snapshotea antes de detectarse,
o eliminación accidental de la VM `clickhouse-vm`.

Ejecutar manualmente (cadencia recomendada: semanal o antes de operaciones
destructivas):

```bash
bun run scripts/clickhouse-backup-s3.sh             # backup full
bun run scripts/clickhouse-backup-s3.sh --dry-run   # preview
```

El script:

1. Verifica que `clickhouse-vm` está RUNNING.
2. Lee credenciales HMAC de Secret Manager (`langfuse-gcs-hmac-id`,
   `langfuse-gcs-hmac-secret`, `langfuse-clickhouse-password`).
3. Ejecuta `BACKUP DATABASE default TO S3(...)` vía `gcloud compute ssh
--tunnel-through-iap` + `sudo docker exec` contra el contenedor.
4. Verifica los objetos en `gs://atlax360-ai-langfuse-clickhouse-backups`.

Path con timestamp para evitar colisión (ClickHouse falla con código 598
`BACKUP_ALREADY_EXISTS` si el path existe):

```
gs://atlax360-ai-langfuse-clickhouse-backups/default_2026-05-10_131809Z/
```

Restore desde S3:

```sql
RESTORE DATABASE default AS default_restored
FROM S3('https://storage.googleapis.com/atlax360-ai-langfuse-clickhouse-backups/<path>/',
         '<HMAC_ID>', '<HMAC_SECRET>');
```

### Pendiente (TODO, no bloqueante para piloto)

- Programar `clickhouse-backup-s3.sh` vía Cloud Scheduler + Cloud Run Job
  (semanal). Mientras no esté, el backup es manual antes de operaciones
  destructivas y como parte del drill trimestral.
- Lifecycle policy para `gs://atlax360-ai-langfuse-clickhouse-backups`:
  promover a NEARLINE/COLDLINE como ya está configurado en los buckets de
  events/media.

## GCS bucket policy (MinIO replacement)

```yaml
# gcs-bucket-lifecycle.json
{
  "lifecycle":
    {
      "rule":
        [
          {
            "action": { "type": "SetStorageClass", "storageClass": "NEARLINE" },
            "condition": { "age": 30 },
          },
          {
            "action": { "type": "SetStorageClass", "storageClass": "COLDLINE" },
            "condition": { "age": 90 },
          },
          {
            "action": { "type": "Delete" },
            "condition": { "age": 365, "isLive": false },
          },
        ],
    },
  "versioning": { "enabled": true },
}
```

Versioning protects against accidental deletes (the same bug that ate the PoC's
Postgres volume). The lifecycle rule deletes non-live versions older than 1 year
to bound storage cost.

## Restore drill (cadencia trimestral)

Un backup que nunca se ha probado no existe — es un fichero opaco con
esperanza dentro. Cada trimestre se ejecuta un drill no-destructivo
automatizado vía `scripts/restore-drill.sh`.

```bash
# Drill completo con tear-down:
bun run scripts/restore-drill.sh

# Preview de comandos (no toca nada):
bun run scripts/restore-drill.sh --dry-run

# Dejar recursos para inspección manual (luego limpiar):
bun run scripts/restore-drill.sh --no-teardown
```

El script verifica los tres mecanismos en paralelo:

1. **Postgres PITR** — `gcloud sql instances clone` con `--point-in-time` =
   ahora-1h, polling hasta `state=RUNNABLE`.
2. **ClickHouse disk snapshot** — busca el snapshot más reciente y crea un
   disco temporal desde él.
3. **ClickHouse `BACKUP TO S3`** — lista los objetos del último backup y
   verifica que tiene archivos (no es bucket vacío).

Coste por ejecución (con tear-down): ~$0.10. El bloqueante es el clone PITR,
que tarda 5-15 min para el dataset actual y hasta 60 min en datasets grandes.

Cada drill **DEBE quedar registrado en "Drill log" con outcome real** —
es lo que da evidencia de que los backups funcionan.

## Drill log

### 2026-05-10 — primer drill PRO

- **Operador**: jgcalvo@atlax360.com
- **Drill ID**: `2026-05-10-1320`
- **Estado**: ✅ todos los checks pasaron (ver detalle abajo)
- **Tear-down**: parcialmente fallido en primer intento (HTTP 409 — Cloud
  SQL aún tenía un `BACKUP_VOLUME` automático corriendo tras el clone).
  Resuelto manualmente + integrado al script: ahora espera a que las
  operaciones RUNNING del clone terminen antes de borrar.
- **Coste real**: ~$0.10 (clone PITR ~7 min + disk snapshot creation ~30s)

Outcome por check:

| Check                               | Resultado              | Notas                                                                                                                                                         |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Cloud SQL PITR clone            | ✅ RUNNABLE en ~7 min  | clone `langfuse-pg-drill-2026-05-10-1320` con `--point-in-time=2026-05-10T12:20:18Z`. Borrado al final.                                                       |
| 2 — ClickHouse disk snapshot → disk | ✅ disco creado        | snapshot fuente: `disk-clickhouse-dat-europe-west1-b-20260510023557-dbwkembz`. Disco `disk-clickhouse-drill-2026-05-10-1320` (200GB pd-ssd) creado y borrado. |
| 3 — ClickHouse BACKUP TO S3         | ✅ 179 archivos en GCS | backup ejecutado el mismo día (`default_2026-05-10_131809Z/`, 1.8 MB). Listable y consistente.                                                                |

**Aprendizajes integrados al script `clickhouse-backup-s3.sh`**:

- El usuario SSH en `clickhouse-vm` no está en el grupo `docker`. Usar
  `sudo docker exec` (no `docker exec` directo) — sin sudo: "permission
  denied while trying to connect to the Docker daemon socket".
- Pasar el SQL via stdin (`echo "$SQL" | gcloud compute ssh ... --command=`)
  evita que el HMAC_SECRET aparezca en `ps`.
- `BACKUP TO S3` es síncrono por defecto y devuelve la fila
  `<backup_id>\tBACKUP_CREATED` cuando completa — útil para confirmar éxito
  sin polling de `system.backups`.

**Aprendizaje integrado al script `restore-drill.sh`**:

- Tras `gcloud sql instances clone` alcanzar `RUNNABLE`, Cloud SQL lanza
  automáticamente un `BACKUP_VOLUME`. Intentar `instances delete` mientras
  corre devuelve HTTP 409. El tear-down ahora hace polling de
  `gcloud sql operations list --filter="status=RUNNING"` y espera (max 10 min)
  antes de borrar.

**Próximo drill programado**: 2026-08-10 (trimestral).
