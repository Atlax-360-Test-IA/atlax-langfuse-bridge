# ADR-003 · Langfuse ingestion API con upsert idempotente por traceId

- **Status**: Accepted
- **Date**: 2026-04-01 (retroactiva)
- **Implements**: I-2 (idempotencia por traceId), I-4 (UNION de tags)

## Context

> _Sección a completar en Fase C: el reconciler puede re-ejecutar el hook
> sobre sesiones ya sincronizadas. Sin idempotencia, esto produce duplicados._

El reconciler corre cada 15 min y re-ejecuta el hook con un payload Stop
sintético sobre cada sesión con drift detectado. Sin idempotencia garantizada,
esto produciría trazas duplicadas en Langfuse, contaminando los dashboards FinOps.

## Decision

> _Sección a completar en Fase C: detalle del esquema de IDs deterministas,
> generación de IDs por turn._

`traceId = cc-${session_id}` donde `session_id` viene del JSONL. La API de
Langfuse hace upsert por `id`: re-ejecutar la misma sesión actualiza la traza
existente en lugar de crear una nueva. Los IDs de generation (sub-spans) son
también deterministas: `${traceId}-${safeModelId}` (donde `safeModelId` es el
modelo con caracteres no `[a-z0-9-]` reemplazados por `-`).

Los **tags** son UNION en upsert (no replacement): si un bug genera un tag malo,
los traces históricos retienen ambos tags. No hay PATCH/DELETE de tags vía API
pública (devuelve 405) — solo UI o `ALTER TABLE` en ClickHouse.

## Consequences

> _Sección a completar en Fase C: qué garantiza esto vs alternativas (BD local,
> log de hooks ejecutados, etc.)._

**Pros**:

- Reconciler trivialmente correcto: re-ejecutar es seguro
- Sin BD local de audit (Langfuse es la SSoT)
- Cero coordinación entre máquinas de devs

**Contras**:

- Bugs en generación de tags persisten en histórico (mitigado: allowlist en `aggregateLines()`)
- Cambios de schema de metadata requieren migración manual en ClickHouse

**Implementa**: I-2 (upsert idempotente), I-4 (UNION tags).
