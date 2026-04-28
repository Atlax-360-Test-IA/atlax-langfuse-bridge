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

## [Unreleased]

### Added

- **ADR-008** (`docs/adr/ADR-008-consistency-bounds.md`): formaliza límites de recuperabilidad de la 2-layer eventual consistency; documenta incidente 22-Apr-2026 (`docker compose down -v`), lección `min(cleanupPeriodDays, WINDOW_HOURS)`, mitigaciones activas (PR #38)
- `ARCHITECTURE.md §11`: sección "Incidente 22-Apr-2026" con cronología, datos perdidos/recuperados, y mitigaciones
- `hooks/pre-tool-use-guard.sh`: PreToolUse guard que bloquea `docker compose down -v`, `docker volume rm/prune`, `rm -rf` sobre directorios de datos protegidos, y `dropdb/DROP DATABASE langfuse` — activo en `~/.claude/settings.json`
- `tests/pre-tool-use-guard.test.ts`: 21 tests (8 permitidos + 13 bloqueados)

### Changed

- Langfuse stack actualizado de 3.167.4 → 3.171.0 (security fixes v3.168, v3.170; catálogo modelos actualizado con claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5) (PR #37)
- Imágenes Docker pineadas a versión exacta `:3.171.0` (antes tag flotante `:3`)
- Worker healthcheck: `127.0.0.1` → `$$(hostname -i)` — el worker no escucha en loopback
- Eliminados `user:` forzados en postgres y minio que causaban conflictos con UIDs de volúmenes existentes

### ADR

- ADR-008 documentando límites de recuperabilidad y lecciones del incidente 22-Apr-2026

### Metrics

- Tests: 523 / expects: 898 / files: 37 (sin cambios funcionales)

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
