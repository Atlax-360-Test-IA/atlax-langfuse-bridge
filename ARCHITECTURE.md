# ARCHITECTURE — atlax-langfuse-bridge

> **SDD canónico** del proyecto. Documenta el "qué" y el "por qué" de la
> arquitectura. Para instrucciones operativas en sesión Claude Code, ver
> [`CLAUDE.md`](./CLAUDE.md). Para decisiones detalladas, ver [`docs/adr/`](./docs/adr/).

**Versión actual**: v0.5.4
**Última actualización**: 2026-04-27
**Estado**: Production-ready PoC (Langfuse v3 self-hosted local)

---

## §1 · Identidad del Proyecto

> _Sección a completar en Fase B con tabla de identidad: nombre, propósito,
> stakeholders, runtime ownership, fases v0.1.0 → v0.5.4 → v1.0._

El bridge es la torre de control FinOps del consumo de Claude Code en Atlax360
(38 desarrolladores). Captura cada sesión vía hook `Stop`, agrega tokens y coste,
y emite trazas a Langfuse v3 self-hosted. Sin dependencias runtime — solo Bun.

---

## §2 · Stack Tecnológico

> _Sección a completar en Fase B con tabla por capa (runtime, observabilidad,
> gateway opt-in, CI, PRO target). Cada elección referencia un ADR-N._

Runtime: **Bun ≥1.3** + TypeScript 5.4, cero deps prod (ver [ADR-001](./docs/adr/ADR-001-bun-cero-deps.md)).
Observabilidad: **Langfuse v3** self-hosted (postgres + clickhouse + redis + minio).
Gateway opt-in: LiteLLM proxy (ver [ADR-007](./docs/adr/ADR-007-litellm-optin.md)).
CI: GitHub Actions matrix ubuntu+macos. PRO target: Cloud Run + Cloud SQL PITR.

---

## §3 · Modelo de Dominio

> _Sección a completar en Fase B con entidades (Session, Trace, Turn, Drift,
> Tier, VirtualKey) y diagrama Mermaid del flujo JSONL → aggregate → ingestion._

Entidades principales:

- **Session**: archivo JSONL en `~/.claude/projects/**/sessions/{session_id}.jsonl`
- **Trace**: registro Langfuse con `id = cc-${session_id}` (idempotente, ver [ADR-003](./docs/adr/ADR-003-langfuse-idempotent.md))
- **Turn**: entry JSONL con `message.model` + `message.usage.*`
- **Drift**: `OK | TURNS_DRIFT | COST_DRIFT | END_DRIFT | MISSING` (ver `shared/drift.ts`)
- **Tier**: `seat-team | vertex-gcp | api-direct | unknown` (ver [ADR-004](./docs/adr/ADR-004-tier-system.md))
- **VirtualKey**: clave LiteLLM por workload, persistida en `virtual-keys.json`

---

## §4 · Estructura del Repositorio

> _Sección a completar en Fase B con mapa de directorios clasificado edge/core
> y tablas de `shared/` y `scripts/` con propósito + invariante implementado._

Topología edge/core (ver [ADR-002](./docs/adr/ADR-002-edge-core-split.md)):

- **Edge** (máquina del dev): `hooks/`, `scripts/reconcile-traces.ts`, `scripts/detect-tier.ts`, `shared/jsonl-discovery.ts`, `browser-extension/`
- **Core** (Cloud Run en PRO): `langfuse-web`, `langfuse-worker`, postgres, redis, clickhouse, minio

---

## §5 · Convenciones de Código

> _Sección a completar en Fase B con reglas: cero deps en hook,
> `process.stderr.write()` no `console.log`, `readFileSync` no streaming,
> patrón comentario `// I-N` en funciones que implementan invariantes._

Convenciones clave:

- Hook nunca lanza ni rechaza — siempre `process.exit(0)` (I-1)
- Logging estructurado JSON a stderr, no `console.log` en producción
- `if (import.meta.main)` guard en todos los scripts con side-effects
- Restauración `process.env` per-key en tests (I-12)

---

## §6 · Pipeline CI/CD

> _Sección a completar en Fase B con descripción de los 3 jobs de ci.yml,
> política semver por PR, tabla versiones → PRs._

Tres jobs en `.github/workflows/ci.yml`:

1. `test` — typecheck + bun test, matrix ubuntu+macos, Bun 1.3.x pinned
2. `smoke-e2e` — skip-graceful sin credenciales Langfuse
3. `smoke-litellm` — `continue-on-error: true`, gate por `LITELLM_*` secrets

Sin CD automático. Deploy manual vía `setup/setup.sh`.

---

## §7 · Contratos de Datos

> _Sección a completar en Fase B con schemas TypeScript de: payload Stop,
> Langfuse ingestion batch, tier.json, degradation log, virtual-keys.json._

Contratos públicos:

- **Payload Stop** (entrada hook): `session_id`, `cwd`, `transcript_path`, `permission_mode`, `hook_event_name`
- **Ingestion batch** (salida hook → Langfuse): `[{ type: "trace-create" | "generation-create", body, timestamp }]`
- **`~/.atlax-ai/tier.json`**: `{ tier, source, account, ts }` (ver `scripts/detect-tier.ts:TierFile`)
- **Degradation log** (stderr JSON): `{ type: "degradation", source, error, ts }`

---

## §8 · Observabilidad

> _Sección a completar en Fase B con tabla completa de tags Langfuse
> (`project:*`, `billing:*`, `tier:*`, `os:*`, `entrypoint:*`, etc.),
> queries FinOps recomendadas, MCP tools agénticos._

Tags Langfuse aplicados en cada trace:

- `project:owner/repo` (extraído de `git remote`)
- `billing:anthropic-team-standard | anthropic-priority-overage | vertex-gcp`
- `tier:seat-team | vertex-gcp | api-direct | unknown` (autoritativo)
- `tier-source:env | credentials-exists | unknown`
- `os:linux-wsl | linux-native | macos | windows`
- `surface:cli | sdk-ts | extension`

Degradation log: stderr JSON, journalctl-friendly. Statusline: actualiza tier.json en cada turno.

---

## §9 · Seguridad

> _Sección a completar en Fase B con detalle de I-8, secretos en
> `~/.atlax-ai/`, sandbox modes MCP, Cloud Run con Secret Manager._

Reglas no negociables:

- Nunca parsear `~/.claude/.credentials.json` — solo comprobar existencia (I-8)
- Secretos en `~/.atlax-ai/` con permisos 600
- `LITELLM_SALT_KEY` inmutable tras emitir virtual keys
- Sandbox modes MCP solo via env (`LANGFUSE_BRIDGE_SANDBOX_MODE`), no via input de tool
- En PRO: Secret Manager + VPC privada para Memorystore y ClickHouse

---

## §10 · Testing

> _Sección a completar en Fase B con pirámide 466/814/35, tabla por capa,
> mapeo I-N → fichero test, comandos, política no-flaky._

**Estado actual**: 466 tests / 814 expects / 35 ficheros / 0 fallos.

Capas:

- **Unitarios** (`tests/*.test.ts`, `shared/*.test.ts`, `browser-extension/src/*.test.js`)
- **Cross-validation** (`tests/cross-validation.test.ts`) — invariantes entre módulos
- **E2E CI-runnable** (`tests/langfuse-sync-http.test.ts`, `tests/reconcile-replay.test.ts`)
- **ADR ejecutable** (`tests/cloud-run-boundary.test.ts`) — enforce I-13

---

## §11 · GAPs Resueltos

> \_Sección a completar en Fase B con los 65 findings cerrados sprints 7-15
>
> - 2 audit passes, referencia al PR que los cerró.\_

Sprints 7-15 cerraron 65 findings (críticos seguridad C1-C5, hardening high/medium/low).
Audit pass post-Sprint 15 (PR #30): 7 findings HIGH/MEDIUM. Audit pass cosmético (PR #31): 6 findings LOW/NIT.

Bugs históricos relevantes:

- 2026-04-21: cwd del Stop event contamina tags → fix vía `aggregateLines()` primer pass (I-3)
- 2026-04-20: langfuse-web `(unhealthy)` → healthcheck con `$(hostname -i)` (Next.js bindea a IP interna)

---

## §12 · GAPs Pendientes

> _Sección a completar en Fase B con detalle por GAP._

- **GAP-P01**: macOS launchd equivalente del systemd timer del reconciler
- **GAP-P02**: PRO migration Cloud Run (PLANNED, ver [ADR-002](./docs/adr/ADR-002-edge-core-split.md) y `infra/cloud-run.yaml`)
- **GAP-P03**: Analytics API Anthropic — datos de cuenta corp vs personal (solo Enterprise tier)
- **GAP-P04**: Calibración hard budget LiteLLM tras 30d de datos reales

GAPs marcados como **NO APLICA**:

- Partial index trace_id (sin BD local — Langfuse gestiona dedup)
- Audit table partitioning (ClickHouse particiona nativo via MergeTree)

---

## §13 · Patrones Cross-Proyecto

> _Sección a completar en Fase B con detalle de patrones reusables._

Patrones extraídos de este proyecto que pueden reusarse en otros proyectos Atlax360:

- **P-1 · Cero deps runtime con Bun** — hook plugins que requieren startup latencia mínima
- **P-2 · Degradation log estructurado** — JSON a stderr en cada `catch`, journalctl-friendly
- **P-3 · Eventual consistency 2 capas** — síncrono (best-effort) + cron asíncrono (autoridad)
- **P-4 · AgentTool + multi-protocol adapters** — un registro central, adapters thin a MCP/Zod/AI-SDK

---

## §14 · Áreas de Investigación

> _Sección a completar en Fase B con cada línea de research activa._

- **R-1**: Analytics API Anthropic — confirmar si los datos de overage por seat son accesibles vía API (hoy se infieren de `service_tier: priority`)
- **R-2**: ClickHouse Cloud vs self-hosted en GKE — análisis de coste para ≥50M trazas/año
- **R-3**: Migración a Langfuse v4 cuando se publique
- **R-4**: IDE extensions (VS Code plugin) como cuarto entrypoint (junto a `cli`, `sdk-ts`, `extension`)
- **R-5**: Hard budget LiteLLM con datos reales tras 30d de calibración

---

## Apéndice A · Architectural Truth

> _Tabla a completar en Fase B con cada verdad no-negociable + invariante I-N + ADR-N._

Verdades no-negociables del sistema:

| Afirmación                                                | Invariante | ADR     |
| --------------------------------------------------------- | ---------- | ------- |
| El hook nunca bloquea Claude Code (siempre `exit 0`)      | I-1        | ADR-006 |
| `traceId = cc-${session_id}` con upsert idempotente       | I-2        | ADR-003 |
| `cwd` se extrae del primer JSONL entry, no del Stop event | I-3        | —       |
| Tags Langfuse son UNION en upsert (no replacement)        | I-4        | ADR-003 |
| Ventana reconciler ≥ 24h por defecto, cap 8760h           | I-5        | ADR-006 |
| `MODEL_PRICING` única fuente de verdad de pricing         | I-6        | ADR-001 |
| Tier determinista en `~/.atlax-ai/tier.json`              | I-7        | ADR-004 |
| Nunca parsear `.credentials.json` — solo existencia       | I-8        | ADR-004 |
| IDs de generation deterministas (timestamp del turn)      | I-9        | ADR-003 |
| `MCP_AGENT_TYPE` validado contra allowlist                | I-10       | ADR-005 |
| `classifyDrift` única fuente en `shared/drift.ts`         | I-11       | —       |
| Restauración `process.env` per-key en tests               | I-12       | —       |
| Reconciler/hook/discovery NUNCA migran a Cloud Run        | I-13       | ADR-002 |

---

## Mantenimiento

Al renombrar un módulo en `shared/` o `scripts/`, actualizar §4. Al añadir un
nuevo invariante a `CLAUDE.md`, añadir fila al Apéndice A. El test
`tests/sdd-invariants.test.ts` (Fase D) verifica que cada I-N tiene cobertura
en este documento.
