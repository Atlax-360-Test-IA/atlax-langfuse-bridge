# ADR-008 · Límites de recuperabilidad de la eventual consistency — lección del incidente 22-Apr-2026

- **Status**: Accepted
- **Date**: 2026-04-28
- **Implements**: I-1, I-5
- **Supersedes**: —
- **Superseded by**: —
- **Related**: [ADR-006](./ADR-006-two-layer-consistency.md) (arquitectura de dos capas),
  [ADR-003](./ADR-003-langfuse-idempotent.md) (idempotencia upsert),
  [ADR-002](./ADR-002-edge-core-split.md) (edge/core split)

## Context

ADR-006 documenta la arquitectura de dos capas (hook síncrono + reconciler asíncrono)
y sus modos de fallo conocidos. Sin embargo, el ADR-006 **no documenta el límite duro
de recuperabilidad**: la capa 2 (reconciler) solo puede recuperar sesiones para las que
existe el JSONL fuente. Si el JSONL ha sido rotado o destruido, la sesión se pierde
permanentemente.

Este límite se materializó en producción el 22-Apr-2026.

### Incidente 22-Apr-2026

**Qué ocurrió**: un agente Claude Code ejecutó `docker compose down -v` sin confirmación
explícita del usuario. El flag `-v` borró todos los volúmenes Docker incluyendo el
volumen `postgres-data`, eliminando la BD de Langfuse con ~3 semanas de trazas.

**Por qué la 2-layer consistency no ayudó**:

1. El volumen perdido era la **BD destino** (Langfuse Postgres + ClickHouse), no la
   fuente (JSONLs en `~/.claude/projects/`).
2. Los JSONLs fuente seguían en disco, pero el parámetro de retención de Claude Code
   era `cleanupPeriodDays: 14` (heredado del PoC).
3. Las sesiones previas a la última semana de marzo (>14 días antes del incidente)
   ya habían sido rotadas automáticamente por Claude Code — no existían JSONLs para
   re-sincronizar esas sesiones aunque se hubiera recuperado la BD.
4. Solo las sesiones de los últimos ~14 días eran recuperables vía reconciler.
5. No existía backup off-host en ese momento.

**Cronología exacta**:

- Fecha del incidente: 23-Apr-2026, sesión `34816887`
- Causa raíz: instrucción de usuario ambigua → agente interpretó contexto como "destruir
  el stack completo" sin solicitar confirmación
- Datos irrecuperables: sesiones anteriores a ~9-Apr-2026 (boundary `cleanupPeriodDays: 14`)
- Datos recuperados: sesiones 9-Apr-2026 → 22-Apr-2026 (dentro de la ventana de retención)
- Mitigación activada: backup systemd diario (03:00 UTC, 7 diarios + 4 semanales)
  desde 24-Apr-2026, verificado con restore drill 28-Apr-2026

### El límite formal

La recuperabilidad de una sesión `S` sincronizada a Langfuse es:

```
recuperable(S) ←→
  existe(JSONL de S en disco) ∧
  mtime(JSONL de S) > now() - WINDOW_HOURS ∧
  BD Langfuse accesible
```

Si cualquiera de las tres condiciones falla, la sesión se pierde. El sistema de
dos capas solo cubre el fallo de la tercera condición (BD temporalmente inaccesible).
No cubre la pérdida del JSONL fuente ni la pérdida de la BD sin backup.

### Dependencias de retención no modeladas en ADR-006

ADR-006 modela `WINDOW_HOURS` como el único parámetro de consistencia. Hay tres
parámetros adicionales que acotan el sistema:

| Parámetro                         | Control                     | Valor PoC     | Valor PRO recomendado   |
| --------------------------------- | --------------------------- | ------------- | ----------------------- |
| `cleanupPeriodDays` (Claude Code) | `~/.claude/settings.json`   | 14 días       | 90 días                 |
| `WINDOW_HOURS` (reconciler)       | `~/.atlax-ai/reconcile.env` | 24h default   | 24h (no cambiar)        |
| Retención backup BD               | Fuera del código            | ninguna (PoC) | 7 diarios + 4 semanales |

La ventana de recuperabilidad efectiva es:

```
ventana_recuperable = min(cleanupPeriodDays × 24h, WINDOW_HOURS)
```

Con `cleanupPeriodDays: 14` y `WINDOW_HOURS: 24`, la cobertura del reconciler era
correcta (24h ≤ 14 días). El problema no era `WINDOW_HOURS` sino la ausencia de
backup de la BD destino.

## Decision

### 1. Elevar `cleanupPeriodDays` a 90 días en la configuración de referencia

Documentar en `docs/operations/runbook.md` que `cleanupPeriodDays` debe ser ≥ 90.
No es configurable vía este repo (es config de Claude Code del dev), pero se
documenta como prerequisito del sistema.

Razón: 90 días cubre trimestres completos. Un incidente de BD que tarde >24h en
detectarse (vacaciones, fines de semana extendidos) no debería causar pérdida de
datos si el backup está disponible. Si el backup falla también, los JSONLs con
`cleanupPeriodDays: 90` permiten reconciliar hasta 90 días atrás.

### 2. Formalizar el invariante de backup como parte del contrato de consistency

La 2-layer eventual consistency de ADR-006 garantiza RPO ≤ 15min **solo si** el
backup de la BD destino está activo y verificado. Sin backup, RPO es igual al
tiempo desde el último backup manual (típicamente infinito en el PoC).

Registro en `ARCHITECTURE.md §11` como lección aprendida.

### 3. Backup sistemático en PoC desde 24-Apr-2026

Systemd timer `atlax-langfuse-backup.timer` activo:

- **Frecuencia**: diario a las 03:00 hora local
- **Retención**: 7 diarios + 4 semanales
- **Destino**: directorio local `~/.atlax-ai/backups/` (mismo host — single point of failure)
- **Script**: `scripts/backup-langfuse.sh` con guard `K_SERVICE` (no ejecuta en Cloud Run)
- **Componentes**: `pg_dump` (Postgres) + `clickhouse-client` SELECT INTO (ClickHouse)
- **Verificación**: restore drill completado 28-Apr-2026 (Postgres OK, ClickHouse OK)

**Gap reconocido**: backup en el mismo host que los datos. Un fallo de disco o una
ejecución accidental de `rm -rf` destruiría tanto los datos como el backup. La
solución es off-host backup (GCS en PRO). Documentado como GAP-P02.

### 4. Restore drill trimestral

La existencia de un backup no garantiza su integridad. Establecer drill trimestral
siguiendo `infra/backup-story.md §Restore drill`.

Primer drill ejecutado: 28-Apr-2026 — Postgres OK, ClickHouse OK.

### 5. Guard explícito en herramientas agenticas para operaciones destructivas

El incidente fue posible porque ningún mecanismo bloqueó `docker compose down -v`.
PBI #3 (hook PreToolUse) implementa un guard que rechaza operaciones con `-v` flag
o `rm -rf` en directorios de datos de este repo.

## Consequences

### Lo que se gana

- **Visibilidad del límite real**: el equipo sabe que RPO depende de tres condiciones,
  no solo del intervalo del cron.

- **`cleanupPeriodDays: 90` como prerequisito**: documentado explícitamente. Los
  nuevos devs del piloto configurarán correctamente desde el primer día.

- **Backup diario verificado**: el drill del 28-Apr-2026 confirma que el procedimiento
  funciona. La siguiente verificación es Q3-2026.

- **Registro histórico del incidente**: los detalles del 22-Apr-2026 quedan
  formalizados en `docs/operations/runbook.md §Incidentes` (PBI #4).

### Lo que se pierde / restricciones

- **Backup sigue siendo local (GAP-P02)**: hasta PRO + Cloud SQL PITR, el backup
  sigue en el mismo host. Un fallo de disco o destrucción del host pierde datos y
  backups simultáneamente.

- **`cleanupPeriodDays` no es configurable desde este repo**: depende de cada dev.
  Solo puede documentarse como prerequisito. En PRO, Cloud SQL con PITR elimina
  esta dependencia de la config local del dev.

- **El incidente destruyó ~3 semanas irrecuperables**: las sesiones previas a
  ~9-Apr-2026 de `jgcalvo@atlax360.com` no pueden recuperarse. Asumido como
  deuda del PoC.

### Trade-off explícito

Aceptamos backup local (mismo host) como solución temporal, sabiendo que es un
single point of failure. El coste de implementar GCS backup en PoC es alto en
complejidad operativa. La migración a Cloud SQL PITR en PRO (documentada en
`infra/backup-story.md`) resuelve esto estructuralmente.

## References

- Incidente: sesión `34816887`, 23-Apr-2026
- Backup script: `scripts/backup-langfuse.sh`
- Backup story PRO: `infra/backup-story.md`
- Restore drill log: `infra/backup-story.md §Drill log`
- Test consistency: `tests/reconcile-replay.test.ts`
- Hook safety (PBI #3): `hooks/pre-tool-use-guard.ts` (pendiente)
- Runbook incidentes (PBI #4): `docs/operations/runbook.md §Incidentes` (pendiente)
