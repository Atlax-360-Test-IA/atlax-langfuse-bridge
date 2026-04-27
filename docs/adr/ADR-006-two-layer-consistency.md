# ADR-006 · Eventual consistency con dos capas — hook síncrono + reconciler asíncrono

- **Status**: Accepted
- **Date**: 2026-04-01 (retroactiva)
- **Implements**: I-1 (hook siempre `exit 0`), I-5 (ventana reconciler ≥ 24h)

## Context

> _Sección a completar en Fase C: por qué un solo punto de captura no basta;
> qué fallos cubre el reconciler (crash, kill -9, reboot, máquina apagada)._

El hook `Stop` se dispara al cerrar sesión Claude Code. Modos de fallo donde
el hook NO ejecuta: kill -9 del proceso parent, crash del terminal, kill de
batería en portátil, reboot del sistema. Sin segunda capa, esos eventos
producen sesiones perdidas en el dashboard FinOps.

Adicionalmente: el hook tiene timeout 10s duro. Si Langfuse está caído o lento,
fallar duro contamina la UX de Claude Code (el dev ve un error al cerrar
sesión). Necesitamos best-effort + retry.

## Decision

> _Sección a completar en Fase C: detalle de las dos capas, política de
> consistency, ventana del reconciler._

**Capa síncrona** (`hooks/langfuse-sync.ts`): mejor esfuerzo. Cualquier error se
escribe a stderr como degradation log JSON y termina con `process.exit(0)` (I-1).
Timeout de fetch a Langfuse: 10s. Sin retries.

**Capa asíncrona** (`scripts/reconcile-traces.ts`): cron 15 min vía systemd
timer (Linux/WSL) o launchd (macOS). Escanea
`~/.claude/projects/**/sessions/*.jsonl` con mtime < `WINDOW_HOURS`. Para cada
sesión:

1. Fetch trace remoto vía `getTrace(cc-${sid})`
2. `classifyDrift()` retorna `OK | TURNS_DRIFT | COST_DRIFT | END_DRIFT | MISSING`
3. Si drift, re-ejecuta el hook con payload Stop sintético
4. El upsert idempotente de Langfuse (ADR-003) garantiza que re-ejecutar es seguro

`WINDOW_HOURS=24` por defecto (cap a 8760h = 1 año). Cubre fines de semana.

## Consequences

> _Sección a completar en Fase C: qué garantiza, latencia esperada de
> consistency, dependencia operativa del cron._

**Pros**:

- UX Claude Code intocable (I-1: hook nunca bloquea)
- Cobertura completa de modos de fallo del hook síncrono
- Latencia de consistency p99 ≤ 15 min (intervalo del cron)

**Contras**:

- Cada dev debe tener cron configurado (`docs/systemd/README.md`)
- Sesiones con duración > `WINDOW_HOURS` requieren amplificación manual del env var

**Implementa**: I-1 (UX intocable), I-5 (ventana ≥ 24h).
