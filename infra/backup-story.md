# PRO Backup Story — Langfuse v3 on Cloud Run

**Status: PLANNED — not yet implemented.** Reference for migration post-PoC.

> 📖 Referencias cruzadas:
>
> - [`ARCHITECTURE.md §9`](../ARCHITECTURE.md#§9--seguridad) — secrets management en Cloud Run
> - [`ADR-002`](../docs/adr/ADR-002-edge-core-split.md) — qué migra a Cloud Run y qué se queda local (I-13)
> - [`infra/cloud-run.yaml`](./cloud-run.yaml) — manifest de referencia

## Goal

Achieve RPO ≤ 1 minute and RTO ≤ 15 minutes for the Langfuse v3 stack in
production, while keeping operational cost reasonable for ~38 active devs.

## Backup matrix

| Component  | PoC (current)                            | PRO (target)                                                    |
| ---------- | ---------------------------------------- | --------------------------------------------------------------- |
| Postgres   | `pg_dump` daily via `backup-langfuse.sh` | **Cloud SQL with PITR** — 7-day automatic backups + WAL archive |
| ClickHouse | `clickhouse-client` SELECT dump          | **ClickHouse Cloud automatic backups** OR `BACKUP TO S3` daily  |
| MinIO/S3   | not backed up                            | **GCS bucket** with Object Versioning + 90-day lifecycle        |
| Redis      | not backed up (cache, ephemeral)         | Memorystore Standard tier (HA replication, no backup needed)    |

## Postgres → Cloud SQL PITR

Enable Point-In-Time Recovery on the Cloud SQL instance:

```bash
gcloud sql instances patch langfuse-pg \
  --backup-start-time=02:00 \
  --enable-point-in-time-recovery \
  --retained-backups-count=7 \
  --retained-transaction-log-days=7
```

This gives RPO ≤ 1 min for the last 7 days. To restore to a point in time:

```bash
gcloud sql instances clone langfuse-pg langfuse-pg-restore-2026-04-27 \
  --point-in-time='2026-04-27T10:30:00.000Z'
```

Why PITR vs daily dumps: a daily snapshot at 02:00 UTC means losing up to 24h
of trace data on a Tuesday morning incident. With PITR + WAL archive, the
recovery window collapses to the last completed transaction.

## ClickHouse — two options

### Option A: ClickHouse Cloud (recommended)

Managed service — daily automatic backups with restore-to-time. No operational
work, costs ~€80–150/mo for the volumes we expect (≤50M traces/year for 38 devs
× ~30 sessions/day).

### Option B: Self-hosted on GKE + BACKUP TO S3

If we keep ClickHouse self-hosted (cheaper at scale, more control):

```sql
BACKUP DATABASE default TO S3('https://storage.googleapis.com/atlax-clickhouse-backups/{date}/', '{HMAC_ID}', '{HMAC_SECRET}');
```

Schedule via Cloud Scheduler → Cloud Run job daily at 02:30 UTC. Retain 30 days
in standard storage, archive to Coldline after 90 days.

Restore:

```sql
RESTORE DATABASE default AS default_restore FROM S3('...');
```

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

## Restore drill (run quarterly)

A backup that is never tested doesn't exist. Schedule a quarterly drill:

1. Clone Cloud SQL to a `langfuse-pg-drill-{date}` instance.
2. Restore ClickHouse to a sandbox cluster.
3. Restore the GCS bucket events folder by listing previous versions.
4. Boot a `langfuse-web` revision pointing at the restored stack.
5. Verify a recent trace ID exists and renders correctly.
6. Tear down the drill resources.

Document each drill outcome in this file under "Drill log" so we have evidence
of working restore paths.

## Drill log

_Empty — first drill scheduled for Q1 PRO post-launch._
