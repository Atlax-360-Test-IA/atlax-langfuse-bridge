# ADR-003 · Langfuse ingestion API con upsert idempotente por traceId

- **Status**: Accepted
- **Date**: 2026-04-01 (retroactiva)
- **Implements**: I-2 (idempotencia por traceId), I-4 (UNION de tags)
- **Supersedes**: —
- **Superseded by**: —
- **Related**: [ADR-006](./ADR-006-two-layer-consistency.md) (consumer principal de la idempotencia)

## Context

El bridge tiene dos capas que pueden enviar la misma sesión a Langfuse:

1. **Hook síncrono** (`hooks/langfuse-sync.ts`) — al cerrar sesión Claude Code
2. **Reconciler cron** (`scripts/reconcile-traces.ts`) — cada 15 min, repara drift

El reconciler **debe poder re-ejecutar el hook** sobre sesiones ya sincronizadas
sin crear duplicados. Sin idempotencia garantizada en el endpoint:

- Cada re-ejecución sumaría duplicados al dashboard FinOps
- Las métricas de coste serían infladas O(N) donde N = ejecuciones del reconciler
- Los devs verían sesiones repetidas en su lista de Langfuse

### Alternativas consideradas

1. **BD local de "hooks ejecutados"**:
   - Pros: control total, audit trail explícito
   - Contras: requiere BD (SQLite o similar) en cada máquina dev. Vulnerable a
     pérdida si el dev borra `~/.atlax-ai/`. Cada dev tendría su propia tabla
     desincronizada.
   - **Descartado**: I-13 (edge no migra) implica que la BD vive en cada dev →
     fragmentación. Y Langfuse ya gestiona dedup nativamente.

2. **Lock distribuido en reconciler**:
   - Pros: previene re-ejecución concurrente
   - Contras: requiere coordination service (Redis lock, Cloud Run job lock).
     No resuelve el problema de fondo (re-ejecutar es válido en muchos casos —
     ej. cuando el hook falló parcialmente).
   - **Descartado**: sobre-ingeniería para un caso que el endpoint puede
     resolver trivialmente.

3. **Endpoint Langfuse con upsert por ID**:
   - Pros: trivialmente correcto, cero coordinación, cero estado local
   - Contras: requiere convención de IDs deterministas
   - **Elegida**.

### Comportamiento de Langfuse Ingestion API

Langfuse `/api/public/ingestion` recibe un batch de eventos. Para cada evento
con `type: "trace-create"` o `"generation-create"`, hace **upsert por `body.id`**:

- Si el ID no existe → crea
- Si el ID existe → actualiza campos provistos (turns, cost, timestamps, metadata)
- **Tags**: UNION (no replacement). Si el evento entrante tiene `tags: ["a", "b"]`
  y el remoto ya tiene `["b", "c"]`, el resultado es `["a", "b", "c"]`.

Este comportamiento es documentado por Langfuse y testado por nosotros en
`tests/reconcile-replay.test.ts` (re-ejecución produce mismo trace ID).

## Decision

### IDs deterministas

- **Trace ID**: `traceId = cc-${session_id}` donde `session_id` viene del JSONL
  (es un UUID generado por Claude Code, único por sesión)
- **Generation ID**: `${traceId}-${safeModelId}` donde `safeModelId` es el modelo
  con caracteres no `[a-z0-9-]` reemplazados por `-`
- Ejemplo: `traceId = "cc-550e8400-e29b-41d4-a716-446655440000"`,
  `generationId = "cc-550e8400-...-claude-sonnet-4-6"`

### Garantía de upsert

- El hook hace `POST /api/public/ingestion` con el batch
- El reconciler re-ejecuta el hook (no llama directamente al endpoint)
- Re-ejecutar es siempre seguro porque el ID es determinista

### Tags como UNION

Aceptamos que tags son UNION en upsert (I-4). Implicación:

- **Si un bug genera un tag malo**, los traces históricos retienen ambos tags
- **No hay PATCH/DELETE de tags vía API pública** (devuelve 405)
- **Para limpiar tags malos**: solo via UI de Langfuse (manual) o `ALTER TABLE`
  en ClickHouse (operación de DBA)

Mitigación preventiva: `shared/aggregate.ts` aplica una **allowlist de tags**
en `aggregateLines()` — solo tags conocidos pueden llegar al payload. Esto
previene que un campo del JSONL contamine los tags si su contenido es inesperado.

## Consequences

### Lo que se gana

- **Reconciler trivialmente correcto**: re-ejecutar es seguro. El código del
  reconciler no necesita track de "hecho vs no hecho" — solo detecta drift y
  re-ejecuta.

- **Sin BD local de audit**: Langfuse es la SSoT. Si el reconciler falla o
  pierde estado, la próxima ejecución vuelve a detectar y reparar el drift.

- **Cero coordinación entre máquinas de devs**: dos devs pueden tener la misma
  `session_id` (improbable pero posible si comparten setups) y los upserts
  no chocan — solo el último gana en cada campo.

- **Idempotencia preserva metadata**: si el hook envió `turns: 5, cost: 0.1`
  inicialmente y el reconciler envía `turns: 7, cost: 0.15` (porque la sesión
  continuó después del primer Stop), el upsert actualiza ambos campos. No hay
  pérdida de información.

### Lo que se pierde / restricciones

- **No podemos "deshacer" un envío malo**: si un bug genera un trace con datos
  incorrectos, hay que enviar de nuevo con datos correctos. Los datos viejos
  son sobreescritos en upsert (excepto tags, que son UNION).

- **Bugs en tags persisten en histórico**: I-4 es una consecuencia inevitable.
  Mitigación: allowlist en `aggregateLines()`.

- **Cambios de schema de metadata requieren migración manual** en ClickHouse
  cuando Langfuse no provee herramienta. Documentado en `infra/backup-story.md`.

- **No hay garantía de orden** entre hook y reconciler: si ambos se ejecutan
  casi simultáneamente, el último gana. En la práctica, el hook se ejecuta
  primero (al cerrar sesión) y el reconciler nunca llega antes que el hook.

### Implementa I-2

I-2 (idempotencia por traceId) está formalizada en CLAUDE.md y tiene cobertura
explícita en `tests/e2e-pipeline.test.ts:121` (`trace body.timestamp matches
envelope timestamp (I-2 idempotency)`).

### Implementa I-4

I-4 (tags UNION) está formalizada en CLAUDE.md y comentada en
`shared/aggregate.ts:46` (allowlist preventiva).

### Implicación para futuras decisiones

Si en el futuro se necesita "patch parcial" (ej. corregir un campo sin
reescribir todo el trace), la API de Langfuse no lo soporta vía ingestion API
pública. Habría que:

- Usar la API privada (no documentada, breaking entre versiones)
- O reenviar el trace completo con el campo corregido (estrategia actual)
- O usar `ALTER TABLE` en ClickHouse (no recomendado)

Esta limitación es aceptable para el caso de uso actual.

## References

- Tests de idempotencia: `tests/e2e-pipeline.test.ts:121`, `tests/reconcile-replay.test.ts`
- Allowlist de tags: `shared/aggregate.ts:46`
- Documentación Langfuse Ingestion API: https://langfuse.com/docs/api
- Sprint inicial PR #1
