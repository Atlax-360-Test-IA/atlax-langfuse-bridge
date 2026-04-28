# ADR-002 · Topología edge/core — el hook y el reconciler nunca migran a Cloud Run

- **Status**: Accepted
- **Date**: 2026-04-26 (formalizado en Sprint 15, retroactivo al diseño inicial)
- **Implements**: I-13

## Context

> _Sección a completar en Fase C: presión por centralizar todo en Cloud Run
> en PRO; análisis de qué componentes pueden centralizarse vs cuáles dependen
> del filesystem local del developer._

Al planificar la migración a PRO (Cloud Run), surgió la pregunta natural: ¿se
puede centralizar el hook y el reconciler en un servicio Cloud Run para
simplificar el despliegue? Análisis: los JSONLs viven en
`~/.claude/projects/**/sessions/*.jsonl`, escritos por Claude Code en cada turno.
Centralizar requeriría endpoint custom de upload (vector SSRF) o cambiar el
modelo de eventos. Adicionalmente, `~/.atlax-ai/tier.json` y
`~/.atlax-ai/reconcile.env` son config por-dev.

## Decision

> _Sección a completar en Fase C: detalle del split y validación automática._

El sistema se divide en dos zonas:

- **Edge** (máquina del dev): `hooks/langfuse-sync.ts`, `scripts/reconcile-traces.ts`, `scripts/detect-tier.ts`, `shared/jsonl-discovery.ts`, `shared/env-loader.ts`, `browser-extension/`
- **Core** (Cloud Run en PRO): `langfuse-web`, `langfuse-worker`, postgres → Cloud SQL, redis → Memorystore, clickhouse → ClickHouse Cloud, minio → GCS

Toda función que toque `os.homedir()`, `~/.atlax-ai`, `~/.claude/projects` o
`execSync("git ...")` permanece edge.

## Consequences

> _Sección a completar en Fase C: qué cambia en PRO migration, qué tests
> garantizan el split._

**Pros**:

- En PRO solo cambia `LANGFUSE_HOST` (de `http://localhost:3000` a URL Cloud Run). Hook y reconciler no se modifican.
- Cero superficie de ataque: ningún endpoint público lee el filesystem del dev
- `tests/cloud-run-boundary.test.ts` (17 tests) valida el split estructuralmente

**Contras**:

- Cada dev debe tener systemd timer/launchd configurado para el reconciler
- Onboarding de nuevos devs requiere `setup/setup.sh`

**Implementa**: I-13 — base no negociable de la migración PRO.
