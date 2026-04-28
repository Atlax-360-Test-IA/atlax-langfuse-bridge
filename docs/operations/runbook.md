# Runbook Operativo — atlax-langfuse-bridge

> Procedimientos operativos del sistema. Para arquitectura, ver
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md). Para instalación inicial, ver
> [`README.md`](../../README.md).

## Índice

- [Validar integridad contra Langfuse](#validar-integridad-contra-langfuse)
- [Detectar y reparar drift](#detectar-y-reparar-drift)
- [Estado y diagnóstico del cron reconciler](#estado-y-diagnóstico-del-cron-reconciler)
- [Actualizar tier manualmente](#actualizar-tier-manualmente)
- [Rollback de Langfuse](#rollback-de-langfuse)
- [Diagnóstico de degradation logs](#diagnóstico-de-degradation-logs)
- [Triage por componente](#triage-por-componente)

---

## Validar integridad contra Langfuse

> _Sección a completar en Fase B con extracción de README + CLAUDE.md actuales._

```bash
bun run scripts/validate-traces.ts                # scan últimas 24h
bun run scripts/validate-traces.ts <path.jsonl>   # validar fichero específico
WINDOW_HOURS=72 bun run scripts/validate-traces.ts
```

Exit code `1` si hay drift. Útil en CI o como verificación post-deploy.
Requiere `LANGFUSE_PUBLIC_KEY` y `LANGFUSE_SECRET_KEY` en el entorno.

## Detectar y reparar drift

```bash
DRY_RUN=1 bun run scripts/reconcile-traces.ts     # detect-only, no escribe
bun run scripts/reconcile-traces.ts               # detect + repair
```

Categorías de drift (ver `shared/drift.ts`):

- **MISSING** — sesión local sin trace remoto
- **TURNS_DRIFT** — `local.turns ≠ remote.metadata.turns`
- **COST_DRIFT** — diferencia > `COST_EPSILON` (0.01 USD)
- **END_DRIFT** — timestamp de fin difiere

Para cada drift, el reconciler re-ejecuta el hook con un payload Stop sintético.
Idempotencia garantizada por `traceId = cc-${session_id}` (ver [ADR-003](../adr/ADR-003-langfuse-idempotent.md)).

## Estado y diagnóstico del cron reconciler

```bash
# Linux/WSL
systemctl --user status atlax-langfuse-reconcile.timer
journalctl --user -u atlax-langfuse-reconcile.service -n 50

# macOS
launchctl list | grep atlax
tail -n 50 ~/Library/Logs/atlax-langfuse-reconcile.log
```

> _Sección a completar en Fase B con tabla de errores comunes y mitigación._

## Actualizar tier manualmente

```bash
bun run scripts/detect-tier.ts
cat ~/.atlax-ai/tier.json
```

> _Sección a completar en Fase B con flowchart de detección._

## Rollback de Langfuse

> _Sección a completar en Fase B: docker compose down + restore desde backup,
> con referencia a `infra/backup-story.md`._

## Diagnóstico de degradation logs

```bash
journalctl --user -u atlax-langfuse-reconcile.service -n 200 \
  | grep '"type":"degradation"' \
  | jq .
```

> _Sección a completar en Fase B con tabla de fuentes (`source: ...`) y mitigación._

## Triage por componente

> _Sección a completar en Fase B con FSM de estados de cada componente._

| Componente             | Síntoma                    | Primera acción                                     |
| ---------------------- | -------------------------- | -------------------------------------------------- |
| Hook `Stop`            | Sesiones sin trace         | Verificar `~/.atlax-ai/reconcile.env`              |
| Reconciler             | Cron no dispara            | `systemctl --user status atlax-langfuse-reconcile` |
| Langfuse `(unhealthy)` | Healthcheck falla          | `docker compose logs langfuse-web`                 |
| MCP server             | Tool call falla con -32602 | Verificar `MCP_AGENT_TYPE` allowlist               |
| Browser extension      | No captura sesiones        | DevTools → service worker activo                   |
