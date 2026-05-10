# ADR-015 · Política formal de backups PRO con drill trimestral

- **Status**: Accepted
- **Date**: 2026-05-10
- **Implements**: I-5 (ventana de reparación ≥24h depende de backups vivos)
- **Scope**: applicable (proyectos Atlax con datos persistentes en PRO)

## Context

Tras F1+F2+F3 PRO Langfuse (provisioning + migración + Cloud Run deploy) y el hardening de
backups (PR #86, 2026-05-10), había varios mecanismos de backup activos sin política unificada:

- Cloud SQL Postgres con PITR habilitado (default GCP)
- ClickHouse disk snapshot con `gcloud compute resource-policies` (3 días retention al
  arrancar)
- GCS buckets con versioning
- `BACKUP TO S3` ClickHouse manual sin schedule

[ADR-008](./ADR-008-consistency-bounds.md) ya formalizó que la consistency 2-layer del bridge
solo garantiza RPO ≤ 15min **si los backups están vivos**. Sin backups, RPO = ∞ — el
reconciler puede recuperar drift dentro de la ventana de retención del JSONL local del dev,
pero no puede reconstruir Langfuse a un punto en el tiempo. Eso requiere backups del backend.

El primer drill PRO (2026-05-10) reveló dos issues operativos:

1. La retention de 3 días en el snapshot ClickHouse era insuficiente: si un drift se detectaba
   un lunes pero el problema empezó el viernes anterior (>72h), no había snapshot que cubrir.
2. `gcloud compute resource-policies update` no permite cambiar `maxRetentionDays` — hay que
   delete + recreate con `--on-source-disk-delete=keep-auto-snapshots` para no perder los
   snapshots históricos.

## Decision

Adoptamos una política formal de backups con tres principios:

### 1. Tabla canónica de RPO/RTO por componente

| Componente                  | Mecanismo                                                          | Retention                   | RPO                    | RTO                           |
| --------------------------- | ------------------------------------------------------------------ | --------------------------- | ---------------------- | ----------------------------- |
| Cloud SQL Postgres          | PITR + WAL archive                                                 | 7 días backups + 7 días WAL | ≤1 min                 | ~15 min                       |
| GCS buckets (events, media) | Versioning + lifecycle (NEARLINE 30d → COLDLINE 90d → delete 365d) | n/a                         | 0                      | 0                             |
| ClickHouse disk snapshot    | `gcloud snapshot-schedule` (02:30 UTC daily)                       | 7 días                      | 24h                    | ~30 min                       |
| ClickHouse `BACKUP TO S3`   | `scripts/clickhouse-backup-s3.sh` manual                           | sin lifecycle (TODO)        | hasta última ejecución | ~10-30 min                    |
| Memorystore Redis           | n/a (cache efímero)                                                | n/a                         | n/a                    | reconstrucción desde Postgres |

La retention mínima para datos no-cache es **7 días** en PRO. Más corto fuerza recuperación
en hot-time y deja sin red de seguridad operaciones de fin de semana.

### 2. Drill trimestral obligatorio

Restore drill ejecutable mediante `scripts/restore-drill.sh` (no destructivo, ~$0.10
por ejecución). Cadencia mínima: **trimestral**. Cada drill se registra con fecha, operador,
resultado y aprendizajes en `project_backups_pro_state.md` (memoria) y en el ADR del
componente afectado si surgen decisiones nuevas.

Próximo drill calendarizado: **2026-08-10**.

El drill cubre tres checks paralelos en cada ejecución:

1. **Postgres PITR clone** a un punto en el tiempo, verifica que el clone alcanza
   `RUNNABLE` y que las tablas core (`traces`, `users`, `projects`) son consultables.
2. **ClickHouse disk snapshot restore** a un disco temporal, verifica que el filesystem
   monta y que ClickHouse arranca con los datos.
3. **GCS object restore** desde versionado, verifica que un objeto borrado se recupera de la
   versión anterior.

Tear-down idempotente con `trap` para garantizar limpieza de recursos aunque el drill falle
por la mitad.

### 3. Cambios de retention requieren delete + recreate

Para cualquier `gcloud compute resource-policies` que necesite cambiar retention,
schedule o start-time, el patrón obligatorio es:

```bash
# 1. Detach del disco (idempotente, ignora si no estaba attached)
gcloud compute disks remove-resource-policies <disk> \
  --resource-policies=<policy> --zone=<zone> 2>/dev/null || true

# 2. Borrar policy si existe
gcloud compute resource-policies delete <policy> --region=<region> --quiet || true

# 3. Recrear con nuevos params — CRÍTICO el flag keep-auto-snapshots
gcloud compute resource-policies create snapshot-schedule <policy> \
  --max-retention-days=<NEW_VALUE> \
  --on-source-disk-delete=keep-auto-snapshots \
  ...

# 4. Re-attach
gcloud compute disks add-resource-policies <disk> \
  --resource-policies=<policy> --zone=<zone>
```

El flag `--on-source-disk-delete=keep-auto-snapshots` preserva los snapshots históricos
durante el delete+recreate. Sin él, todos los snapshots existentes se borran al destruir el
policy — pérdida de la red de seguridad sin posibilidad de recuperación.

## Consequences

**Lo que ganamos:**

- Política unificada que mapea cada dato persistente a un mecanismo de backup con RPO/RTO
  explícitos. La auditoría 2026-05-09 identificó esto como bloqueante para PRO; ahora cerrado.
- Drill trimestral convierte el backup story en algo verificado, no aspiracional. El primer
  drill (2026-05-10) detectó el límite del API `resource-policies update` antes de que un
  incidente real lo expusiera.
- Patrón delete+recreate documentado evita la pérdida silenciosa de snapshots cuando se ajusta
  retention — error fácil de cometer con la primera lectura del API.

**Lo que perdemos:**

- Cadencia trimestral implica que un cambio en el stack PRO (nueva tabla, nueva BD, cambio de
  schema en Langfuse) puede pasar 3 meses sin verificación de restore. Mitigación: cualquier
  cambio significativo del stack PRO añade un drill ad-hoc al PR — no esperar al trimestral.
- `BACKUP TO S3` de ClickHouse sigue siendo manual sin lifecycle policy. Pendiente:
  Cloud Scheduler + Cloud Run Job que lo automatice semanalmente (no bloqueante para
  operación normal — el snapshot diario cubre el RPO objetivo).

**Pendientes no bloqueantes (capturados aquí para no perderlos):**

- Cloud Scheduler + Cloud Run Job que automatice `clickhouse-backup-s3.sh` semanal.
- Lifecycle policy para `gs://atlax360-ai-langfuse-clickhouse-backups`
  (NEARLINE→COLDLINE→delete equivalente al de events/media).
- Cloud Monitoring alert si snapshot diario falla 3 días consecutivos.

## How to apply to other projects

Cualquier proyecto Atlax con datos persistentes en PRO redacta una sección equivalente en
su ADR de backups con:

1. Tabla RPO/RTO por componente (sin huecos — todos los datos persistentes deben aparecer).
2. Script `scripts/restore-drill.sh` ejecutable y no-destructivo.
3. Cadencia trimestral mínima documentada en el ADR + recordatorio en Google Calendar
   (similar al patrón Atlax Scope Review mensual).
4. Patrón delete+recreate para cualquier resource-policy que se vaya a modificar.

Si el proyecto no tiene ningún dato persistente (ej. edge-tooling puro como el lado
hook+reconciler de este mismo bridge — ver [ADR-002](./ADR-002-edge-core-split.md)), este ADR
no aplica.

## References

- F1 PRO Langfuse (2026-05-09) — provisioning con backups iniciales
- PR #86 (2026-05-10) — hardening: 3d→7d retention + BACKUP TO S3 + restore drill
- Drill ejecutado 2026-05-10 — 3/3 checks ✅, aprendizaje sobre BACKUP_VOLUME post-clone
- [ADR-008](./ADR-008-consistency-bounds.md) — bounds de recuperabilidad del bridge
- [ADR-012](./ADR-012-clickhouse-gce-self-hosted.md) — decisión arquitectónica del backend que
  este ADR protege
- `scripts/restore-drill.sh` — implementación del drill
- `scripts/clickhouse-backup-s3.sh` — backup manual ClickHouse a GCS
- `infra/backup-story.md` — runbook operativo (este ADR es la decisión, ese fichero es el
  procedimiento)
