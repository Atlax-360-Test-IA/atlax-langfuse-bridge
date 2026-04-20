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
Ver `hooks/langfuse-sync.ts` líneas 257 y 304. Previamente produjo tags
ruidosos (`project:jgcalvo` en vez de `project:owner/repo`).

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

`MODEL_PRICING` en `hooks/langfuse-sync.ts` líneas 63-71 es la única
fuente de verdad para costes estimados. Los scripts de `scripts/` DEBEN
duplicar el mismo objeto (no importar — son scripts standalone). Cuando
Anthropic ajusta precios, actualizar los 3 sitios en el mismo commit:
`hooks/langfuse-sync.ts`, `scripts/validate-traces.ts`,
`scripts/reconcile-traces.ts`.

### I-7 · Tier determinista en `~/.atlax-ai/tier.json`

Escrito por `scripts/detect-tier.ts` vía statusline. Leído por el hook. El
billing heurístico (`billing:*`) se mantiene por retrocompatibilidad pero
la fuente autoritativa son los tags `tier:*` y `tier-source:*`.

### I-8 · Nunca leer `~/.claude/.credentials.json`

Regla global heredada. `detect-tier.ts` comprueba existencia del archivo
pero NO parsea el contenido para extraer email (lo intentaba antes; se
quitó). `account` queda `null` en tier.json cuando la fuente es OAuth.

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
