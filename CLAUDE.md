# CLAUDE.md — atlax-langfuse-bridge

Project-specific rules for Claude Code when working on this repo. Extends the
global `~/.claude/CLAUDE.md`.

## What this project is

Torre de observabilidad FinOps para el uso de Claude Code en Atlax360. Tres
piezas coordinadas:

1. **Hook `Stop`** (`hooks/langfuse-sync.ts`) — síncrono, corre al cerrar
   sesión, agrega usage del JSONL y lo envía a Langfuse vía ingestion API.
2. **Reconciler cron** (`scripts/reconcile-traces.ts`) — asíncrono, corre
   cada 15 min vía systemd/launchd, detecta drift y re-ejecuta el hook.
3. **Stack Langfuse v3 self-hosted** (`docker/`) — destino de todas las trazas.

## Invariantes no negociables

### I-1 · Hook siempre `exit 0`

El hook NUNCA bloquea Claude Code. Cualquier error se escribe a stderr y
termina con `process.exit(0)`. Romper esto degrada UX de 38 devs.

### I-2 · Idempotencia por traceId

`traceId = cc-${session_id}`. Langfuse hace upsert por ID. El reconciler
depende de esto: re-ejecutar el hook sobre una sesión ya sincronizada NO
debe crear duplicados, solo actualizar turns/cost/timestamps.

### I-3 · cwd del primer JSONL entry, nunca del evento Stop

El payload Stop trae un `cwd` que a veces no coincide con dónde arrancó la
sesión (happy wrapper, subshells, etc.). Esto contamina tags de proyecto.
**Regla**: `sessionCwd = primer entry con .cwd` (fallback al Stop event).
Implementado vía `aggregateLines()` en `shared/aggregate.ts` — el campo `cwd`
se extrae en el primer pass del JSONL. Previamente produjo tags ruidosos
(`project:jgcalvo` en vez de `project:owner/repo`).

### I-4 · Tags son UNION en upsert (no replacement)

Langfuse hace UNION de tags al upsertar un trace existente. Si corriges un
bug que genera un tag malo, los traces históricos retienen AMBOS tags. No
hay PATCH/DELETE de tags vía API pública (devuelve 405). Sólo UI o
`ALTER TABLE` en ClickHouse.

### I-5 · Ventana de reparación ≥ 24h

El reconciler usa `WINDOW_HOURS=24` por defecto. Si una sesión dura >24h,
AMPLIAR la variable en `~/.atlax-ai/reconcile.env` (típicamente a 72h o
168h). No bajar de 24h — pierdes sesiones de fin de semana.

### I-6 · Modelo de pricing central

`MODEL_PRICING` vive en `shared/model-pricing.ts`. Es la **única fuente de
verdad** para costes estimados — todos los consumidores importan de ahí.
Cuando Anthropic ajusta precios, cambiar únicamente `shared/model-pricing.ts`.
No duplicar el objeto en ningún otro fichero del repo.

### I-7 · Tier determinista en `~/.atlax-ai/tier.json`

Escrito por `scripts/detect-tier.ts` vía statusline. Leído por el hook. El
billing heurístico (`billing:*`) se mantiene por retrocompatibilidad pero
la fuente autoritativa son los tags `tier:*` y `tier-source:*`.

### I-8 · Nunca parsear `~/.claude/.credentials.json`

`detect-tier.ts` puede comprobar la **existencia** del archivo (para inferir
tier `seat-team` en OAuth) pero NUNCA parsea su contenido ni extrae email.
El motivo: el archivo contiene tokens de sesión Anthropic. `account` queda
`null` en tier.json cuando la fuente es OAuth — esto es intencional.

### I-9 · Generación IDs deterministas — usar timestamp del turn, no Date.now()

Los IDs de generation en el batch Langfuse deben ser deterministas para
que el reconciler sea idempotente. Usar `turn.timestamp` (del JSONL), nunca
`Date.now()` ni `new Date().toISOString()` en el cuerpo del evento de
generación. `Date.now()` produce un ID diferente en cada re-ejecución,
rompiendo la deduplicación de Langfuse.

### I-10 · MCP_AGENT_TYPE validado contra allowlist

El env var `MCP_AGENT_TYPE` acepta solo los valores definidos en `AgentType`:
`"coordinator" | "trace-analyst" | "annotator"`. Un valor desconocido loguea
un warning a stderr y usa `"coordinator"` como fallback. No castear a
`AgentType` sin validación previa.

### I-11 · classifyDrift vive en shared/drift.ts (única fuente de verdad)

La función `classifyDrift()` y el tipo `DriftStatus` viven en
`shared/drift.ts`. No duplicar la lógica en scripts o tests. El reconciler
importa desde ahí, los tests también.

### I-12 · process.env restore en tests: guardar/restaurar keys específicas

No usar `process.env = { ...origEnv }` para restaurar env en tests — asignar
al proxy `process.env` puede no funcionar correctamente. Patrón correcto:

```typescript
const saved = process.env["MY_VAR"];
afterEach(() => {
  if (saved !== undefined) process.env["MY_VAR"] = saved;
  else delete process.env["MY_VAR"];
});
```

## Comandos de operación

```bash
# Validar integridad contra Langfuse
bun run scripts/validate-traces.ts

# Detectar drift y reparar
bun run scripts/reconcile-traces.ts

# Estado del cron
systemctl --user status atlax-langfuse-reconcile.timer
journalctl --user -u atlax-langfuse-reconcile.service -n 50

# Actualizar tier manualmente
bun run scripts/detect-tier.ts
```

## Stack

- Runtime: **Bun** (hook + scripts, cero deps runtime)
- Stack observabilidad: Langfuse v3 (postgres + clickhouse + redis + minio)
- Deployment actual: docker-compose local (PoC)
- Deployment futuro: Cloud Run + Cloud SQL + Memorystore + GCS (post-PoC)

## Anti-patterns a evitar

- **No añadir dependencias npm al hook**: aumenta latencia de cierre de
  sesión y riesgo de supply chain. Todo con APIs built-in de Bun/Node.
- **No usar `console.log` en el hook**: stdout puede interferir con otros
  hooks downstream. Usar `process.stderr.write()` para errores.
- **No hacer retries síncronos en el hook**: timeout es 10s duro. Si falla,
  el reconciler lo recoge en la siguiente ventana.
- **No leer el JSONL en streaming**: `readFileSync` + `split("\n")` es más
  rápido para tamaños típicos (<50MB) y más simple que streaming.

## Histórico de bugs relevantes

| Fecha      | Bug                                           | Fix                                                                                      |
| ---------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 2026-04-21 | cwd del Stop event contamina tags de proyecto | Extraer cwd del primer JSONL entry con `.cwd`                                            |
| 2026-04-20 | langfuse-web marcado (unhealthy)              | Healthcheck con `$(hostname -i)` porque Next.js bindea a IP del contenedor, no localhost |

## Backlog — decisiones de cierre

### Partial index `trace_id` — NO APLICA (2026-04-24)

El item #5 del backlog (extraído de `atlax-observatorios/projects/orvian/BACKLOG.md`) refería
a `CREATE UNIQUE INDEX ... WHERE trace_id IS NOT NULL` para una tabla SQL local de audit.
**Este proyecto no tiene BD local.** Todo el almacenamiento de traces va directamente a Langfuse
vía API REST (`/api/public/ingestion`). La deduplicación la gestiona Langfuse por `id` de trace
(upsert idempotente, I-2). El índice es responsabilidad del stack Langfuse, no de este repo.

Si en el futuro se añade una BD local de audit (e.g., SQLite para caché offline o estadísticas
locales), revisar este ítem.

### Audit table partitioning — NO APLICA (2026-04-24)

El item #6 del backlog referería a particionado diario/mensual de una tabla de audit
de hooks. **Este proyecto no tiene tabla de audit local.** Los hooks emiten directamente
a Langfuse y no persisten nada localmente (excepto `~/.atlax-ai/tier.json`, que es un
fichero JSON simple, no una tabla relacional).

El particionado aplica al stack Langfuse v3:

- **Postgres**: almacena traces/observations metadata. Langfuse 3.x gestiona su propio
  schema — si el volumen crece, el equipo de Langfuse publicará migraciones de particionado.
- **ClickHouse**: ya particiona por defecto (es su modelo nativo de engines MergeTree). No
  necesita intervención.

Si en el futuro se añade una tabla de audit local (improbable — el valor de observabilidad
lo proporciona Langfuse), revisar este ítem.
