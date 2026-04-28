# ADR-006 · Eventual consistency con dos capas — hook síncrono + reconciler asíncrono

- **Status**: Accepted
- **Date**: 2026-04-01 (retroactiva)
- **Implements**: I-1 (hook siempre `exit 0`), I-5 (ventana reconciler ≥ 24h)
- **Supersedes**: —
- **Superseded by**: —
- **Related**: [ADR-003](./ADR-003-langfuse-idempotent.md) (idempotencia es prerrequisito de re-ejecución segura),
  [ADR-002](./ADR-002-edge-core-split.md) (cron vive en máquina dev)

## Context

El hook `Stop` se dispara al cerrar sesión Claude Code. Sin embargo, hay
**modos de fallo conocidos** donde el hook NO ejecuta:

1. **kill -9 del proceso parent** (terminal cerrado abruptamente, ssh
   desconectado, etc.)
2. **Crash del terminal** (xterm/Ghostty/iTerm crashea, OOM, etc.)
3. **Kill por batería** en portátil (sistema apaga procesos al hibernar)
4. **Reboot del sistema** mientras Claude Code está abierto
5. **`docker compose down` de Langfuse** mientras el hook intenta enviar
   (timeout 10s del hook → exit 0 sin reportar)

Sin segunda capa, esos eventos producen **sesiones perdidas** en el dashboard
FinOps. Para 38 devs, la frecuencia esperada es ~1-2 sesiones perdidas por
día acumuladas.

### Problema adicional: timeout duro del hook

Claude Code mata el hook si tarda >10s. Sin protección, esto fuerza a:

- **Fallar duro y propagar el error** → degrada UX (el dev ve un error al
  cerrar sesión, lo cual es disruptivo)
- **O silenciar errores y aceptar pérdida** → sin recuperación

Necesitamos best-effort + retry, pero sin bloquear nunca al dev.

### Alternativas consideradas

1. **Hook con retries síncronos** (ej. 3 intentos con backoff):
   - Pros: simple, sin cron
   - Contras: consume budget de 10s. Tres reintentos con backoff exponencial
     pueden exceder fácilmente. Y no cubre los modos de fallo donde el hook
     no ejecuta del todo.
   - **Descartado**: no resuelve el problema de fondo.

2. **Daemon persistente** que mantenga conexión a Langfuse:
   - Pros: latencia mínima
   - Contras: requiere systemd service complejo en cada máquina dev. Vector de
     ataque adicional. Memoria residente.
   - **Descartado**: sobre-ingeniería.

3. **Hook + cron asíncrono que repara** (eventual consistency):
   - Pros: hook simple (best-effort), cron robusto (autoritativo), separación
     clara de responsabilidades
   - Contras: requiere cron en cada máquina dev. Latencia de consistency
     ≤ intervalo del cron.
   - **Elegida**.

### Prerrequisito: idempotencia upstream

Esta arquitectura solo funciona si re-ejecutar el hook sobre una sesión ya
sincronizada es **seguro** (no produce duplicados). Eso lo garantiza
[ADR-003](./ADR-003-langfuse-idempotent.md) — Langfuse hace upsert por
`traceId` determinista.

## Decision

### Capa 1 — Hook síncrono best-effort

`hooks/langfuse-sync.ts`:

- **Timeout duro**: 10s (gestionado por Claude Code)
- **Política de errores**: cualquier error → degradation log JSON a stderr +
  `process.exit(0)` (I-1)
- **Sin retries síncronos**: si Langfuse no responde en 10s, el reconciler
  cubre la siguiente ventana
- **Fetch con timeout**: `AbortSignal.timeout(timeoutMs)` por defecto 10s

```typescript
// I-1: cualquier error → exit 0 (no bloquear UX)
try {
  await sendToLangfuse(payload);
} catch (err) {
  emitDegradation("sendToLangfuse", err);
  process.exit(0);
}
```

### Capa 2 — Reconciler cron asíncrono

`scripts/reconcile-traces.ts`:

- **Frecuencia**: cada 15 min vía systemd timer (Linux/WSL) o launchd (macOS)
- **Ventana**: `WINDOW_HOURS=24` por defecto (cap a 8760h = 1 año, para
  evitar runaway scans). Cubre fines de semana (I-5)
- **Algoritmo**:
  1. `discoverRecentJsonls(WINDOW_HOURS)` → lista de JSONLs con mtime reciente
  2. Para cada JSONL:
     - `aggregate(p)` → tokens, cost, turns locales
     - `getTrace(cc-${sid})` → datos remotos
     - `classifyDrift(local, remote)` → `OK | TURNS_DRIFT | COST_DRIFT | END_DRIFT | MISSING`
  3. Si drift, re-ejecuta el hook con payload Stop sintético
- **Idempotencia**: garantizada por ADR-003 — re-ejecutar es seguro
- **Logging**: JSON estructurado a stdout (journalctl-friendly)
- **Subprocess timeout**: 30s para el hook child process (kill SIGTERM si
  excede)

### Política de ventana

`WINDOW_HOURS=24` es el default. Razones:

- **Cubre fines de semana**: si el dev no abre Claude Code el viernes noche,
  el sábado el reconciler aún ve sesiones del viernes
- **Cap a 8760h (1 año)**: evita scans accidentales de filesystem completo
  cuando alguien pone `WINDOW_HOURS=99999`
- **Sesiones largas (>24h)**: el dev debe ampliar manualmente en
  `~/.atlax-ai/reconcile.env` (I-5)

### Configuración por-dev

`~/.atlax-ai/reconcile.env`:

```bash
# Por defecto 24h. Ampliar para sesiones largas.
WINDOW_HOURS=24

# Excluir la sesión actual (la que aún no ha cerrado)
# EXCLUDE_SESSION=550e8400-e29b-41d4-a716-446655440000

# Dry-run (detect-only, no escribe)
# DRY_RUN=1
```

### Hook inscritos en CI

- `tests/langfuse-sync-http.test.ts` verifica I-1 (hook nunca exit ≠ 0)
- `tests/reconcile-replay.test.ts` verifica drift detection + idempotencia

## Consequences

### Lo que se gana

- **UX Claude Code intocable** (I-1): el hook nunca bloquea el cierre de
  sesión. El dev no ve errores aunque Langfuse esté caído.

- **Cobertura completa de modos de fallo** del hook síncrono: kill -9, crash,
  reboot, batería — todos cubiertos por el reconciler en la siguiente
  ventana.

- **Latencia de consistency p99 ≤ 15 min** (intervalo del cron). Para
  dashboards FinOps que se consultan diariamente, es indistinguible de
  consistency síncrona.

- **Diagnóstico claro**: degradation logs en stderr + JSON estructurado del
  reconciler en stdout permiten identificar cualquier sesión perdida y por qué.

- **Sin coordinación entre devs**: cada máquina opera independientemente. Si
  un dev tiene problema con su cron, no afecta a los otros 37.

### Lo que se pierde / restricciones

- **Cada dev debe tener cron configurado**: documentado en
  `docs/systemd/README.md`. Mitigación: `setup/setup.sh` lo automatiza en
  Linux/WSL. macOS launchd queda como GAP-P01 (manual hoy).

- **Sesiones con duración > `WINDOW_HOURS` requieren amplificación manual**:
  raro pero ocurre con sesiones de auditoría o análisis profundo. El dev
  ajusta `WINDOW_HOURS` y reinicia el timer.

- **Si el cron no corre durante días**: el reconciler eventualmente recoge
  sesiones viejas si están dentro de `WINDOW_HOURS`. Si superan la ventana,
  se pierden permanentemente.

- **Latencia variable durante outages**: si Langfuse está caído por 2h, el
  hook falla durante esas 2h. El reconciler las recupera cuando Langfuse
  vuelve. Latencia hasta 2h + intervalo del cron.

### Implementa I-1 + I-5

- I-1 (hook siempre exit 0): test en `tests/langfuse-sync-http.test.ts`
- I-5 (ventana ≥ 24h): test en `tests/reconcile-replay.test.ts:135`

### Trade-off explícito: complejidad operativa vs UX

Aceptamos que cada dev tenga que mantener un cron a cambio de UX intocable.
Para una user base de 38 devs con setups gestionados, el coste operativo es
bajo. Para escalas mayores (cientos+ de devs), reconsiderar.

## References

- Hook: `hooks/langfuse-sync.ts`
- Reconciler: `scripts/reconcile-traces.ts`
- Cron units: `docs/systemd/`
- Tests: `tests/langfuse-sync-http.test.ts`, `tests/reconcile-replay.test.ts`
- Sprint inicial PR #1
