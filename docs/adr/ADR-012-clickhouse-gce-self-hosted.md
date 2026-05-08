# ADR-012 · ClickHouse self-hosted en GCE para PRO

- **Status**: Accepted
- **Date**: 2026-05-08
- **Implements**: — (decisión arquitectónica de PRO, no liga directamente con I-N)
- **Scope**: `atlax-langfuse-bridge`
- **Supersedes**: ninguno
- **Related**: [ADR-002](./ADR-002-edge-core-split.md) (I-13: edge/core split), [`infra/cloud-run.yaml`](../../infra/cloud-run.yaml), [`infra/backup-story.md`](../../infra/backup-story.md), [`docs/operations/cloud-run-deployment-plan.md`](../operations/cloud-run-deployment-plan.md)

## Context

El despliegue PRO de Langfuse v3 requiere alojar ClickHouse fuera de docker-compose local. Cuatro opciones reales fueron evaluadas el 2026-05-08 mediante una investigación exhaustiva con dos agentes paralelos (research + cloud-architect) contra fuentes oficiales:

| Opción                      | Región                      | Conexión Cloud Run                  | Coste mensual                        | Overhead     |
| --------------------------- | --------------------------- | ----------------------------------- | ------------------------------------ | ------------ |
| A: ClickHouse Cloud         | europe-west4 (cross-region) | PSC con Global Access (Scale tier+) | $120-180 con idling                  | 0h/mes       |
| B: Aiven for ClickHouse     | europe-west1                | VPC Peering nativo                  | $250-500 (estimado, no transparente) | 0h/mes       |
| **C: Self-hosted GCE VM**   | **europe-west1**            | **Private IP en mismo VPC**         | **~$180/mes con CUD 1y**             | **3-5h/mes** |
| D: GCE + tiered storage GCS | europe-west1                | idem C                              | $200-220                             | 4-5h/mes     |

### Restricción crítica: la policy de seguridad ya aprobada

`infra/cloud-run.yaml` ya tiene `vpc-access-egress: private-ranges-only` (decisión previa de seguridad — auditoría 360º PR #65 confirma bind 127.0.0.1 + restricción de egress). Esta policy:

- **Bloquea internet egress por defecto** desde Cloud Run
- Es coherente con la arquitectura "tooling interno, todo privado" del bridge
- Su modificación requeriría justificación + ADR adicional + revisión de seguridad

ClickHouse Cloud (Opción A) está en `europe-west4` (no `europe-west1`). Para conectarse desde Cloud Run en `europe-west1` con la policy actual, hay dos caminos:

1. **PSC con Global Access**: requiere Scale tier (más caro), DNS privada custom, configuración de endpoint allowlist por servicio. Complejidad operativa significativa.
2. **Cambiar `vpc-access-egress` a `all`**: rompe la policy de seguridad para permitir TLS público hacia ClickHouse Cloud. Reduce blast-radius defenses por $-30/mes de ahorro.

Aiven (Opción B) resuelve la restricción técnica (mismo region + VPC peering) pero añade fricción comercial (precio no público, requiere quote, lock-in de proveedor menos integrado con Langfuse).

GCE self-hosted (Opción C) **no toca ninguna policy**. La VM vive en el mismo VPC que el VPC connector de Cloud Run, con IP privada en `subnet-data`. El Cloud Run alcanza ClickHouse via `http://10.20.10.20:8123` con sub-ms latency.

### Volumen y workload realista

- 38 devs Atlax360 con consumo Claude Code (~50-200k traces/mes)
- 5-20 GB datos actuales, 50-100 GB tras 12 meses con `cleanupPeriodDays:90`
- ClickHouse no es data-warehouse analytics: es TSDB derivado. La fuente de verdad real son los JSONLs locales y los seats Anthropic (RPO de ClickHouse aceptable: 24h)
- Workload write-heavy (ingestion de traces vía worker), poca query analítica concurrente
- Disponibilidad target: 99.5% es suficiente para tooling interno (no es producto de cara a cliente)

A este volumen, la diferencia de coste entre las opciones es marginal (~$50-100/mes). El factor decisivo no es coste sino fricción operativa y arquitectónica.

### Compatibilidad Langfuse

Langfuse v3 documenta soporte para ClickHouse `>= 24.3` ([self-hosting docs](https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse)). Tu stack actual usa `clickhouse:24.12-alpine` — exactamente la misma imagen que el target self-hosted. Migración trivial via `BACKUP TO S3` (mismo formato).

## Decision

**ClickHouse se despliega self-hosted en una Compute Engine VM dedicada en `europe-west1`.**

Spec mínimo:

- VM: `n2-highmem-4` (4 vCPU, 32 GB RAM) — ratio 4:1 RAM:datos según [recomendaciones oficiales](https://clickhouse.com/docs/guides/sizing-and-hardware-recommendations) cubre hasta ~50 GB datos confortablemente
- Boot disk: `pd-balanced` 50 GB
- Data disk: `pd-ssd` 200 GB montado en `/var/lib/clickhouse`
- Imagen Docker: `clickhouse/clickhouse-server:24.12` (idéntica a docker-compose)
- IP privada: `10.20.10.20` en `subnet-data`
- Firewall: TCP 8123 (HTTP) + 9000 (native) ingress sólo desde la subnet del VPC connector
- Sin IP pública

Mecánicas operativas:

- **Snapshots automáticos** del data disk: Cloud Scheduler diario 02:30 UTC, retención 7 snapshots (~$5/mes)
- **Backups nativos** ClickHouse: `BACKUP DATABASE default TO S3('gs://atlax-langfuse-clickhouse-backups/...')` diario via Cloud Run Job (~$2/mes GCS)
- **Drill restore quarterly** documentado en runbook
- **Updates**: manual con ventana planificada (image bump + restart, ~5 min downtime)
- **Monitoring**: Cloud Monitoring con métricas de CPU, RAM, disk usage. Alert si disk > 80% lleno

Coste mensual estimado: **~$180/mes con CUD 1 año** (~$258/mes on-demand sin compromiso). Desglose en `docs/operations/cloud-run-deployment-plan.md`.

## Consequences

### Positivas

- **Cero modificaciones a la policy de seguridad de Cloud Run** — `vpc-access-egress: private-ranges-only` se mantiene
- **Sub-milisegundo de latencia** Cloud Run → ClickHouse (mismo VPC + región)
- **Versión Docker idéntica** a la que ya está validada en docker-compose (24.12) — no riesgo de breaking change por upgrade automático
- **Migración trivial**: `BACKUP TO S3` exporta desde la instancia local actual y `RESTORE FROM S3` importa en GCE. ~15 min downtime
- **Sin lock-in** de proveedor managed — datos son derivados, los JSONLs locales son la fuente de verdad
- **Coste predecible**: sin egress fees variables, sin cambios de pricing del proveedor (riesgo real con ClickHouse Cloud que subió 30% en enero 2025)
- **Permite colocation de LiteLLM** futura si crece el piloto (cohabitar en la misma VM con cgroups separados — Opción explorada en cloud-run topology design)

### Negativas

- **Overhead operativo de 3-5 h/mes**: apt upgrades de Docker host, monitoring de disk usage, gestión de snapshots, drill quarterly. Aceptable para 38 devs con un único SRE part-time
- **Single point of failure**: una sola VM, sin HA por defecto. Mitigación: snapshots diarios + backups GCS. **RTO ~2-4 h** en caso de fallo total de disco
- **Scaling vertical requiere downtime**: para upgrade de `n2-highmem-4` → `n2-highmem-8` hay que parar la VM. Ventana planificada cuando el volumen lo requiera (proyectado >12 meses)
- **Responsabilidad de seguridad del OS**: patches del kernel, firewall rules, IAM SA bindings. Cubierto por Cloud Operations + Security Command Center alerts
- **Sin SLA formal**: dependemos del SLA de Compute Engine (~99.5% single-zone). Para tooling interno aceptable. Para v1 público sería insuficiente

### Riesgos y mitigaciones

| Riesgo                                                 | Severidad | Mitigación                                                                              |
| ------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------- |
| Fallo de disco data → pérdida de datos si backup falló | ALTA      | Validación diaria del backup vía Cloud Monitoring alert. Drill quarterly de restore     |
| Upgrade ClickHouse manual queda atrás en seguridad     | MEDIA     | Subscribirse a ClickHouse security advisories. Política de upgrade trimestral mínimo    |
| Volumen >100 GB comprimidos en 12 meses → resize       | BAJA      | Plan de capacidad documentado. Resize de pd-ssd no requiere downtime (online)           |
| HMAC keys para backups GCS comprometidas               | MEDIA     | Rotación 90 días via Secret Manager. Workload Identity Federation explorada para fase 2 |
| Disponibilidad single-zone                             | BAJA      | RTO 2-4 h aceptable para tooling interno (ADR documenta este trade-off)                 |

## Alternativas descartadas

### Opción A — ClickHouse Cloud (europe-west4)

Descartada por:

1. Cross-region penalty (10-20 ms latencia adicional)
2. Requiere romper `vpc-access-egress: private-ranges-only` O configurar PSC con Global Access (complejidad)
3. PSC solo en Scale tier (eleva coste)
4. Pricing subió 30% en enero 2025; egress fees nuevos
5. SLA garantizado solo con committed spend anual

Reconsiderar si: (a) se acepta degradar la policy de egress, (b) volumen crece a >500 GB y autoscaling se vuelve crítico, (c) se quiere SLA formal con contrato.

### Opción B — Aiven for ClickHouse (europe-west1)

Descartada por:

1. Precio no transparente (estimado $250-500/mes vs $180-258 en self-hosted)
2. ClickHouse no es la oferta principal de Aiven — versión puede ser conservadora
3. No mencionada explícitamente en docs Langfuse (compatibilidad menos validada en producción)
4. Lock-in equivalente al de ClickHouse Cloud sin ventaja de pricing

Reconsiderar si: Atlax360 ya tiene contrato Aiven activo y descuento por volumen.

### Opción D — GCE + tiered storage GCS

Descartada por:

1. Ahorro marginal (~$24/mes) vs complejidad de configuración (storage_configuration XML, mover datos entre tiers)
2. Para volumen actual (5-20 GB) no aplica — la primera tier ya cubre todo

Reconsiderar si: volumen llega a >200 GB comprimidos.

## References

- Investigación de opciones (2026-05-08): hallazgos consolidados en sesión post-validación Paso 2
- ClickHouse Cloud GCP GA: https://clickhouse.com/blog/clickhouse-cloud-on-google-cloud-platform-gcp-is-generally-available
- Langfuse self-hosting ClickHouse: https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse
- ClickHouse sizing: https://clickhouse.com/docs/guides/sizing-and-hardware-recommendations
- ClickHouse backup to GCS: https://clickhouse.com/integrations/gcs
- ClickHouse pricing 2025 changes: https://quesma.com/blog/clickhouse-pricing/
- Plan de despliegue: `docs/operations/cloud-run-deployment-plan.md`
