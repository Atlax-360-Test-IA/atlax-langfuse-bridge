# Changelog

All notable changes to `atlax-langfuse-bridge` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adapted for the Atlax360 ecosystem with `ADR`, `Metrics`, and `Ops` sections.

## Versionado

Semver retroactivo. Política:

- **MAJOR** — breaking del contrato externo (payload del hook, protocolo MCP, schema BD)
- **MINOR** — nueva capability (sprint funcional con nuevo módulo, endpoint o tier)
- **PATCH** — audit pass, fix, refactor, docs

---

## [1.0.0] — 2026-05-11

Versión estable. Cumple los exit criteria definidos en S24-B: stack PRO activo en
`https://langfuse.atlax360.ai`, suite de tests verde, auditoría 360º completada,
LiteLLM gateway operativo con trazabilidad per-workload.

### Added

- **PRO deployment** — Langfuse v3 self-hosted en Cloud Run europe-west1 + ClickHouse GCE + Cloud SQL + Memorystore. Dominio `langfuse.atlax360.ai`. `infra/provision-pro.sh` idempotente con `--dry-run`. (PRs #69–#86)
- **LiteLLM gateway PRO** — `litellm.atlax360.ai`. M1 (modelo único), M2 (callback Langfuse), M3 (virtual keys per-workload + presupuesto + alertas Slack). Revisión `v1.83.10-stable`. (PRs #3–#6, #51, #55, #58, #91, #96)
- **Vertex AI via gateway** — 3 modelos `vertex-claude-*` (sonnet-4-6, haiku-4-5, opus-4-7) enrutados por LiteLLM → Vertex europe-west1. Atribución per-dev via virtual keys. `roles/aiplatform.user` en SA. (PR #102)
- **MCP server** — `scripts/mcp-server.ts`: 3 agent types (`coordinator`, `trace-analyst`, `annotator`), Zod/MCP adapters, sandbox modes, smoke E2E contra Langfuse real. (PRs #9–#10)
- **Reconciler** — `scripts/reconcile-traces.ts`: detección de drift MISSING/TURNS/COST/OK, reparación automática vía re-emit del hook, integración Anthropic Admin API (`cost_report` con `group_by[]=description`). (PRs #1, #47, #50, #54, #68, #87)
- **Bridge health trace** — `sendBridgeHealthTrace()`: trace `bridge-health` day-scoped al final de cada scan del reconciler, con `status:ok/degraded` y `metadata.degradations[]`. (PR #57)
- **PreToolUse guard** — `hooks/pre-tool-use-guard.sh`: bloquea `docker compose down -v`, `docker volume rm/prune`, `rm -rf` sobre datos protegidos, `dropdb/DROP DATABASE`. 21 tests. (PR #39)
- **Pilot onboarding** — `setup/pilot-onboarding.sh`: script standalone para devs, descarga hook + shared/ sin clonar repo, credenciales en `~/.atlax-ai/` (chmod 600), soporte `--litellm-mode` y `--dry-run`. (PRs #41, #85, #95)
- **Backfill script** — `scripts/backfill-historical-traces.ts`: re-emit one-shot con `_invokedByReconciler:true` + `LANGFUSE_FORCE_NOW_TIMESTAMP=1` para evitar regresión en ClickHouse `ReplacingMergeTree`. (PR #47)
- **SDD canónico** — `ARCHITECTURE.md` §1-§14 + Apéndice A, `docs/adr/` ADR-001..ADR-015, `docs/operations/runbook.md`, `docs/operations/langfuse-dashboard-guide.md`. (PRs #32–#35, #89)
- **Invariante I-14** — límites operativos del paralelismo agéntico: N≤5 read-only, N≤3 write, doble-check obligatorio, síntesis en orquestador. (PR #49, ADR-011)
- **Shared platform validation** — categoría dual `edge-tooling` + `server-only` validada contra Atlax 360 AI Suite Shared Platform v0.3. Naming canónico `atlax360-ai-<purpose>-<env>`. (PRs #73, #76)
- **ADR-008** — límites de recuperabilidad 2-layer eventual consistency, incidente 22-Apr-2026, mitigaciones. (PR #38)
- **ADR-012** — ClickHouse self-hosted en GCE vs. Cloud/Aiven: decisión formal y razones. (PR #69)
- **ADR-013/014/015** — aprendizajes F4/F5 PRO (Cloud SQL private-only, Certificate Manager maps, Serverless NEG allUsers). (PR #89)
- **Cobertura de tests** — sprint consolidation S25: 95 nuevos tests cubriendo ramas no alcanzadas de `langfuse-sync.ts`, `reconcile-traces.ts`, `mcp-server.ts`. (PRs #97–#101)

### Changed

- Langfuse stack `3.172.1` (web + worker pineados a versión exacta). Worker healthcheck usa `hostname -i` en vez de `127.0.0.1`. (PRs #37, #44)
- `SAFE_SID_RE` centralizado en `shared/validation.ts` con bound `{1,128}`. Eliminados duplicados en reconciler y backfill. (PR #66)
- `transcript_path` en hook confinado a `~/.claude/projects/` con `safeFilePath()`. Override `ATLAX_TRANSCRIPT_ROOT_OVERRIDE` solo en tests. (PR #65)
- `docker-compose.yml`: `langfuse-web:3000` y `litellm:4001` bindados a `127.0.0.1:` (antes `0.0.0.0`). (PR #65)
- `ToolContext.signal`/`stepBudgetMs` cableado en `query-langfuse-trace.ts` y `annotate-observation.ts` con `AbortSignal.any([stepSignal, ctx.signal])`. (PR #65)
- `LangfuseNotFoundError` tipado reemplaza string-match `"→ 404"`. (PR #65)
- `costEntries.sort()` mutante → `[...].toSorted()` (ES2023). `tsconfig.json` sube `lib: ES2023`. (PR #66)
- LiteLLM `langfuse_default_tags`: eliminado `infra:anthropic` (ambiguo con Vertex) → queda `["source:litellm-gateway"]`, provider discriminable por campo `model` del trace. (PR #102)
- `pilot-onboarding.sh` elimina `eval "$*"` → usa `"$@"` con `printf %q` para dry-run. (PR #66)
- Tests: 14 ocurrencias de `process.env = { ...origEnv }` → helper `saveEnv`/`restoreEnv` (patrón I-12). (PR #65)

### Fixed

- **Bug crítico cost reconciliation** — `getCostReport` sin `groupBy: ["description"]` rutaba todo el coste a `__non_token__` y la comparación se saltaba silenciosamente. Con el fix, el reconciler detecta divergencias reales (~$14k/semana Sonnet 4.6 que antes ignoraba). (PR #68)
- LiteLLM healthcheck `curl` → `python3 urllib.request` (imagen no incluye curl). (PR #68)
- Cloud Run: `REDIS_PORT` 6379→6378, TLS, `CLICKHOUSE_USER` default→langfuse. (PR #83)
- `provision-pro.sh`: `gcloud storage hmac create` SA positional, VPC CIDR `10.20.96.0/20`, `--edition=ENTERPRISE` Cloud SQL para mantener budget F1. (PRs #79–#81)
- Reconciler: detección de cobertura parcial del bridge para evitar falsos positivos en divergencia de costes. (PR #87)
- `validate-traces.ts` recreado tras pérdida en reinicio WSL. (PR #70)

### Security

- NaN guards en `THROTTLE_MS` (`backfill-historical-traces.ts`) y `MCP_STEP_BUDGET_MS` (`mcp-server.ts`). (PR #66)
- `mcp-server.ts`: `MAX_LINE_BYTES = 1MB` — OOM guard en stdin loop. (PR #66)
- `tier.json` escrito con `mode: 0o600`. (PR #66)
- `backup-langfuse.sh`: regex `^[a-zA-Z_][a-zA-Z0-9_]*$` valida nombres de tabla antes de interpolar en SQL. (PR #66)
- `fw-deny-rfc1918-default` en GCP: deny EGRESS RFC-1918 desde tag `langfuse-egress` (prioridad 1100). (PR #70)
- Cloud NAT activado + red default eliminada en proyecto GCP. (PR #82)

### ADR

- ADR-008: límites de recuperabilidad 2-layer consistency + incidente 22-Apr-2026
- ADR-009: quota limits y throttling MCP
- ADR-010: cost-source tag unificado
- ADR-011: límites paralelismo agéntico (I-14)
- ADR-012: ClickHouse self-hosted GCE vs. Cloud/Aiven
- ADR-013: Cloud SQL private-only (sin IP pública)
- ADR-014: Certificate Manager maps vs. certificados directos
- ADR-015: Serverless NEG + `allUsers` + ingress restriction

### Metrics

- Tests: **1053** / expects: **1923** / files: **64** / 0 fail
- Cobertura: hook ≥79%, reconciler ≥82%, mcp-server ≥93%
- Stack PRO: 8/8 smoke checks verdes (2026-05-10)
- LiteLLM gateway: 5/6 modelos OK en smoke (vertex-opus-4-7 en cuota inicial)

---

## [0.6.0-wip] — SDD canónico

### Added

- **Fase A** (PR #32 — `docs/sdd-canonical-structure`):
  - `ARCHITECTURE.md` con scaffolding SDD canónico §1-§14 + Apéndice A (placeholders)
  - `ORGANIZATION.md` con convenciones del ecosistema Atlax
  - `CHANGELOG.md` con semver retroactivo v0.1.0 → v0.5.4
  - `docs/adr/README.md` + 7 ADRs (header Nygard completo, contenido mínimo)
  - `docs/operations/runbook.md` (placeholder)
  - Campo `version: "0.5.4"`, `description`, `keywords`, `repository` en `package.json`
- **Fase B** (PR #33 — `docs/sdd-content-migration`):
  - `ARCHITECTURE.md` completado con contenido migrado de README + CLAUDE.md
  - `docs/operations/runbook.md` completado (validar, reconcile, cron, LiteLLM, browser ext, rollback)
  - `README.md` refactorizado a Quick Start + setup (~306 líneas, era 603)
  - `CLAUDE.md` refactorizado preservando I-1..I-13 (~182 líneas, era 221)
- **Fase C** (este PR — `docs/adr-retroactive-content`):
  - 7 ADRs completos con Context/Decision/Consequences detallado retroactivo
  - Cada ADR incluye alternativas descartadas con razones técnicas
  - Referencias cruzadas explícitas entre ADRs (Related: ADR-NNN)
  - Sección "References" con paths a tests y PRs en cada ADR

### Changed

- README ya no contiene contenido arquitectónico — todo migrado a SDD
- CLAUDE.md mantiene solo invariantes operativos (stack, topology, histórico bugs eliminados)
- Punteros cruzados entre README ↔ ARCHITECTURE ↔ CLAUDE ↔ runbook ↔ ADRs

### ADR

- ADR-001 a ADR-007 documentando decisiones arquitectónicas retroactivas (contenido completo en Fase C)

### Metrics

- Tests: 466 / expects: 814 / files: 35 (sin cambios funcionales — solo docs)

---

## [0.5.4] — 2026-04-27

### Fixed

- `.split("/").pop()!` → `?? ""` en `reconcile-traces.ts` y `validate-traces.ts` (PR #31)
- Healthcheck `langfuse-worker` añadido en docker-compose; `langfuse-web` ahora espera `service_healthy`
- README: árbol `shared/` completado con `drift.ts`, `constants.ts`, `env-loader.ts`, `jsonl-discovery.ts`

### Changed

- Labels `// I-N` añadidos en tests sin referencia explícita (I-3, I-5, I-7, I-10, I-12)
- CLAUDE.md I-9 clarificado: aplica si el bridge genera IDs propios (actualmente no)
- Describe labels stale en `validate-traces.test.ts` y `reconcile-traces.test.ts` apuntando a I-11

### Metrics

- 466 tests / 814 expects / 35 files / 0 fail

### Ops

- PR #31 mergeado — audit cosmetic LOW/NIT cerrado

---

## [0.5.3] — 2026-04-27

### Fixed

- I-11 violado: `classifyDrift` duplicado en `validate-traces.ts` → eliminado, ahora importa de `shared/drift.ts` (PR #30)
- `WINDOW_HOURS=NaN` en `validate-traces.ts` producía scan vacío silencioso → guard `Number.isFinite`
- `runReconciler()` en `reconcile-replay.test.ts` sin timeout de proceso → `Promise.race` con 30s
- `langfuse-client.ts`: `timeoutMs` opcional → required; eliminado `!` non-null assert

### Added

- `timeout-minutes` en los 3 jobs CI (15/10/10 min)
- `docker/docker-compose.yml`: `minio-init` con `service_healthy` + retry loop
- `infra/cloud-run.yaml`: worker env block expandido (redis, clickhouse, s3, salt)
- `.gitignore` cubre `~/` artefacto de sesión

### Metrics

- 466 tests / 814 expects / 35 files / 0 fail

### Ops

- PR #30 mergeado — audit pass HIGH/MEDIUM cerrado, sin breaking changes

---

## [0.5.2] — 2026-04-26

### Added

- Sprint 13: hardening `EXT-H1/M1/M2` + `PRO-W1` (PR #25)
- Sprint 14: 3 E2E CI-runnable gaps cubiertos con Bun.serve HTTP mocks (PR #26)
- Sprint 15: PRO migration readiness — invariante **I-13** + Cloud Run scaffolding (PR #27)
- README post-Sprint 15: secciones edge/core, degradation, tier cache, test pyramid (PR #28)
- `.gitignore` excluye `.handoff-*.md` (PR #29)

### Changed

- `CLAUDE.md` añade I-13 (edge/core split)
- `infra/cloud-run.yaml` y `infra/backup-story.md` documentan migración PRO

### ADR

- Decisión arquitectónica: hook/reconciler/discovery NUNCA migran a Cloud Run (formalizada como I-13, base de futuro ADR-002)

### Metrics

- 466 tests / 814 expects / 35 files

### Ops

- `tests/cloud-run-boundary.test.ts` añadido (17 tests) — ADR ejecutable

---

## [0.5.1] — 2026-04-25

### Fixed

- Sprint 8: extension hardening H1-H5 (PR #20)
- Sprint 9: HIGH `shared/` + types + tsconfig (PR #21)
- Sprint 10: HIGH CI/Docker hardening H14-H19 (PR #22)
- Sprint 11: MEDIUM dedup + architecture (PR #23)
- Sprint 12: LOW + meta (zero new debt) (PR #24)

### Metrics

- 422 tests / 718 expects (tras Sprint 13)

### Ops

- 5 sprints consecutivos sin nueva deuda técnica

---

## [0.5.0] — 2026-04-23

### Fixed

- Sprint 7: 5 critical security fixes C1-C5 (PR #19)
  - Path traversal en filenames de session JSONLs
  - SSRF allowlist en `LANGFUSE_HOST`
  - Auth bypass en MCP server
  - Y 2 más en hardening de seguridad

### Metrics

- 363 tests / 615 expects (post Sprint 7)

### Ops

- Hito de seguridad: cero criticals abiertos

---

## [0.4.5] — 2026-04-22

### Added

- Sprint 6: debt cleanup M7/M8/M9/N1/N2/N3 (PR #18)

### Metrics

- 348 tests / 590 expects

---

## [0.4.4] — 2026-04-21

### Added

- Sprint 5: refactor `shared/` — `COST_EPSILON`, `loadEnvFile`, `discoverRecentJsonls` (PR #17)

### Changed

- Centralización de utilidades compartidas en `shared/`

---

## [0.4.3] — 2026-04-20

### Added

- Sprint 4: `extension-pricing.test.ts` cross-validation, `detect-tier` 47% → 90% coverage, drift tests (PR #16)

---

## [0.4.2] — 2026-04-19

### Added

- Sprint 3: test consolidation — 294 tests, 89% coverage (PR #15)

---

## [0.4.1] — 2026-04-18

### Fixed

- Sprint 2 debt: entrypoint allowlist, manifest optional perms, exponential backoff, README updates (PR #14)

---

## [0.4.0] — 2026-04-17

### Fixed

- Sprint 1: 7 bugs críticos/altos — I-8 enforcement, setup script, tier flags, getTrace 404 handling, typecheck, CI cache (PR #13)

### Metrics

- Hito: primer sprint de hardening sistemático

---

## [0.3.5] — 2026-04-15

### Changed

- Browser extension modernización — pricing canónico, degradation log, tests (PR #12)

### Ops

- Extension MV3 alineada con `shared/model-pricing.ts` (I-6)

---

## [0.3.4] — 2026-04-14

### Added

- CI GitHub Actions matrix ubuntu+macos (PR #11)
- `shared/degradation.ts` consolidado, smoke E2E wired

---

## [0.3.3] — 2026-04-13

### Added

- MCP smoke E2E test contra Langfuse real (PR #10)
- Sección operativa README

---

## [0.3.2] — 2026-04-12

### Added

- MCP server stdio sin SDK — JSON-RPC 2.0 a mano (PR #9)
- Zod adapter, sandbox modes (`echo` para CI), hash-cache SHA256

### ADR

- Decisión retroactiva: MCP sin SDK Anthropic (formalizada como base de ADR-005)

---

## [0.3.1] — 2026-04-11

### Added

- AgentTool adapter base (PR #8)
- Tier taxonomy: `processing-tiers.ts` (deterministic / cached_llm / full_llm)

---

## [0.3.0] — 2026-04-10

### Added

- Spec de degradation log estructurado (PR #7)
- Tier cache SHA256 con TTL 24h en `shared/hash-cache.ts`

---

## [0.2.4] — 2026-04-09

### Added

- LiteLLM M3: virtual keys per-workload + soft budget alerts (PR #6)

---

## [0.2.3] — 2026-04-08

### Added

- LiteLLM M2: callback Langfuse activo (PR #5)
- Trazas de gateway aparecen en mismo project Langfuse

---

## [0.2.2] — 2026-04-07

### Added

- Test consolidation inicial: 68 tests (PR #4)

---

## [0.2.1] — 2026-04-06

### Added

- LiteLLM M1: gateway opt-in con un modelo (PR #3)
- `docker compose --profile litellm` activa el stack

### ADR

- Decisión retroactiva: LiteLLM como gateway opt-in, no en flujo CLI principal (base de ADR-007)

---

## [0.2.0] — 2026-04-05

### Changed

- Centralización `MODEL_PRICING` en `shared/model-pricing.ts` (PR #2)
- Implementa **I-6** (única fuente de verdad de pricing)

---

## [0.1.0] — 2026-04-01

### Added

- Hook `Stop` inicial (`hooks/langfuse-sync.ts`)
- Reconciler cron (`scripts/reconcile-traces.ts`) con systemd timer
- Detección de tier (`scripts/detect-tier.ts`) con escritura `~/.atlax-ai/tier.json`
- Stack Langfuse v3 self-hosted (`docker/docker-compose.yml`)
- Fix `cwd` del Stop event — extracción del primer JSONL entry (**I-3**)

### ADR

- Decisión retroactiva: Bun runtime con cero deps prod (base de ADR-001)
- Decisión retroactiva: 2-layer eventual consistency hook + reconciler (base de ADR-006)
- Decisión retroactiva: Langfuse upsert idempotente por traceId (base de ADR-003)

### Metrics

- Hito: PoC funcional para 38 devs Atlax

### Ops

- Despliegue inicial en máquinas Linux/WSL/macOS de los devs

---

## Convenciones de actualización

Cada PR mergeado a `main` debe añadir entrada en `[Unreleased]`. Al cortar
release, mover entradas a sección con versión + fecha. La versión semver se
incrementa según política (ver §"Versionado" arriba).
