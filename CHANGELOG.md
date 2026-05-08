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
- `docs/operations/runbook.md §Incidentes`: plantilla de incidente + INC-001 (23-Apr-2026, cronología completa, mitigaciones, gap pendiente)
- `setup/pilot-onboarding.sh`: script standalone de onboarding para los 37 devs del piloto — descarga hook + shared/ desde GitHub sin clonar el repo, registra hook Stop en settings.json, escribe credenciales en `~/.atlax-ai/reconcile.env` (modo 600), establece `cleanupPeriodDays: 90`. Uso: `curl -fsSL <url> | bash -s -- <HOST> <PK> <SK>`
- `tests/sprint16-coverage.test.ts`: 37 tests cubriendo gaps de cobertura — `readTierFile` (vía subprocess con HOME falso), `getBillingTier` (vertex/priority/standard), `getDevIdentity` (overrides), `detectOS`, error paths de `sendToLangfuse` (unsafe host, missing keys, HTTP 4xx), `langfuse-client` (buildConfig unsafe host, credentials missing, 404/500, listTraces params), `hash-cache` (TTL, FIFO, cacheSize), reconciler (`EXCLUDE_SESSION`, invalid SID skip, missing keys exit-1)

### Changed

- Langfuse stack actualizado a `3.172.1` (web + worker pineados a versión exacta — incremento desde 3.171.0 sin cambios funcionales; pin para reproducibilidad)
- Imágenes Docker pineadas a versión exacta (anterior bump `3.167.4 → 3.171.0` en PR #37 con security fixes v3.168, v3.170 y catálogo de modelos `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`)
- Worker healthcheck: `127.0.0.1` → `$$(hostname -i)` — el worker no escucha en loopback
- Eliminados `user:` forzados en postgres y minio que causaban conflictos con UIDs de volúmenes existentes

### ADR

- ADR-008 documentando límites de recuperabilidad y lecciones del incidente 22-Apr-2026

### Auditoría post-recovery (2026-05-08)

Modo auditoría tras recovery del crash de CC. Validación cruzada del estado real del sistema vs los artefactos commiteados.

HALLAZGOS REALES

- `/tmp/atlax-validation/validate-consistency.ts` se perdió al reiniciar WSL (no estaba commiteado al repo). **Recreado** en `scripts/validate-consistency.ts` (~270 líneas vs 700 originales, más conciso). Verificado funcional contra el sistema vivo: 3 OK / 1 TURNS_DRIFT esperado en sesión activa, bridge-health `status:ok`, cost reconciliation con `group_by[]=description` operativo.
- `fw-deny-rfc1918-default` añadida a `infra/provision-pro.sh` — rule defense-in-depth recomendada por agente Cloud Run topology que faltaba. Prioridad 1100 (deny EGRESS a 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 desde tag `langfuse-egress`). Las allows específicas (1000-1020) tienen prioridad menor y siguen funcionando.
- LiteLLM container sigue `unhealthy` en runtime aunque el fix de PR #68 está mergeado — el container actual fue arrancado ANTES del merge y el healthcheck nuevo solo aplica al recrear con `docker compose up -d`. Operación pendiente, no bug.

FALSO POSITIVO DESCARTADO

- "Bridge-health no se actualiza" diagnosticado inicialmente como bug de upsert. **NO era bug**: Langfuse v3 ingestion pipeline tiene latencia ~12-15s (API→Redis→Worker→ClickHouse). Consulté el trace 2s tras enviar y vi datos viejos. Tras esperar 12s, el upsert sí aplicó: tags UNION, metadata last-write-wins, timestamp actualizado. ADR-003 sigue siendo correcto.
- Lección persistida en `feedback_langfuse_v3_ingestion_latency.md` (memoria proyecto): "Esperar mínimo 15s antes de afirmar que un upsert no funcionó". Test confirmatorio reproducible documentado.

VALIDACIÓN CRUZADA EJECUTADA

- Suite completa: **818/0 fail / 1475 expects** (post-recovery)
- Tests E2E aislados: 30/30 verde (`langfuse-sync-http`, `reconcile-replay`, `bridge-health`, `cost-reconciliation`)
- Tests integración: 110/110 verde (`concurrency`, `cross-validation`, `sprint16-coverage`, `anthropic-admin-client`, `langfuse-client`)
- Reconciler dry-run en producción: cost-divergence-detected emitiendo warnings reales con datos Anthropic ($14k+ Sonnet 4.6, $560 Haiku 4.5, $0 Opus 4.7 = seat-only)
- bridge-health trace `repaired:2 failed:0 status:ok` confirmado tras esperar pipeline

ARTEFACTOS DE LA SESIÓN ANTERIOR
Verificada integridad de todos los outputs de subagentes previos: ADR-012 (148 líneas), plan despliegue (861 líneas), `cloud-run.yaml` (11 cambios), `provision-pro.sh` (467 líneas, syntax OK). Conocimiento valioso de los agentes 100% persistido a disco antes del crash. Logs operativos brutos perdidos pero irrelevantes para continuidad.

### PRO Deployment Plan — Decisión arquitectónica + plan formal (2026-05-08)

Tras la validación intensiva del Paso 2, se diseña el despliegue PRO en Cloud Run europe-west1. Investigación exhaustiva con 2 agentes paralelos contra fuentes oficiales (ClickHouse Cloud, Aiven, GCE pricing, Langfuse self-hosting docs).

**Decisión clave** (formalizada en [ADR-012](docs/adr/ADR-012-clickhouse-gce-self-hosted.md)): **ClickHouse self-hosted en GCE VM** (n2-highmem-4 + 200 GB pd-ssd) en europe-west1, no ClickHouse Cloud (cross-region europe-west4 + complejidad PSC) ni Aiven (precio no transparente). Razón decisiva: misma región que Cloud Run + no requiere modificar `vpc-access-egress: private-ranges-only`.

**Decisiones del usuario** (registradas en plan):

- Versión: `v0.6.0-wip` durante PRO ramp-up; `v1.0.0` solo cuando piloto exitoso (≥3 devs × 2 semanas)
- `minScale=0` en web (cold start aceptado, ahorra ~$60-80/mes idle); `minScale=1` en worker (BullMQ poll loop)
- Dominio custom `langfuse.atlax360.com` desde día 1 con Cloud LB + Cloud Armor + cert managed
- Plan formal escrito + ejecución stage-by-stage con checkpoints

**Artefactos creados**:

- `docs/adr/ADR-012-clickhouse-gce-self-hosted.md` — decisión formal
- `docs/operations/cloud-run-deployment-plan.md` — plan ejecutable de 5 fases con checklists, rollback plan, coste estimado (~$480-540/mes total), riesgos top 5
- `infra/cloud-run.yaml` actualizado con 11 cambios consolidados de la auditoría 360º (Direct VPC egress, Private IP Postgres, OTEL*SDK_DISABLED, gen2 execution environment, healthcheck timeouts ajustados, S3_MEDIA_UPLOAD*\*, minScale 0/1 según servicio)
- `infra/provision-pro.sh` — script idempotente de provisioning (VPC, subnets, Cloud SQL, Memorystore, GCS, GCE ClickHouse, Service Accounts, Secret Manager). Soporta `--dry-run` y `--skip-*` por sección
- `docs/adr/README.md` actualizado con entrada ADR-012

**No ejecutado en este PR** (solo planificación): el provisioning real requiere proyecto GCP con billing + dominio + ventana operativa de 1-2 días. Ejecución bajo modo auto stage-by-stage cuando se reinicie sesión con credenciales GCP listas.

### Fix Paso-2 — Bug crítico de cost reconciliation descubierto en validación (2026-05-08)

Durante la validación funcional intensiva (Paso 2 post-auditoría) se descubrió un bug silencioso en `scripts/reconcile-traces.ts:reconcileCostAgainstAnthropic()`:

**El problema**: el reconciler invocaba `getCostReport({ startingAt, endingAt })` sin `groupBy: ["description"]`. Sin ese parámetro, la API de Anthropic devuelve filas con `model: null`. `sumCostByModel()` rutea entonces todo el coste a `"__non_token__"` y el reconciler filtra explícitamente esa key (`if (k === "__non_token__") continue`). Resultado: el map de costes reales queda vacío, `compareCostByModel()` retorna `[]`, `isSeatOnlyScenario([])` retorna `false`, y la comparación de divergencia se SALTABA silenciosamente. Logs decían `cost-comparison-seat-only` cuando en realidad había $14,788 USD/semana de Sonnet 4.6 facturados vía API que el bridge nunca verificaba.

**El fix**: añadir `groupBy: ["description"]` al call site. Con esto, las filas vienen con el campo `model` poblado y la comparación detecta divergencias reales.

**Hallazgo derivado**: el bridge solo observa ~7% del tráfico API de la organización (jgcalvo via Claude Code), el resto son workloads programáticos (Harvest, dashboard, VALA) que NO usan Claude Code CLI ni gateway LiteLLM. Esto NO es bug del bridge — es gap de cobertura de instrumentación, conocido y documentado en POST-V1 backlog (PV1-A3 onboarding LiteLLM).

**Test anti-regresión**: `tests/cost-reconciliation.test.ts` (+2 tests) verifica que toda llamada futura a `cost_report` desde el reconciler incluye `group_by[]=description`. El test usa `Bun.serve` mock y un `ANTHROPIC_ADMIN_API_BASE` override añadido a `shared/anthropic-admin-client.ts:AnthropicAdminConfig.baseUrl`.

**Bug colateral arreglado**: el container `litellm:v1.83.7-stable` de docker-compose tenía healthcheck `curl -f http://localhost:4000/health/liveliness`, pero la imagen NO incluye `curl` ni `wget`. 585 fallos consecutivos del healthcheck reportaban el container como `unhealthy` aunque funcionaba. Reemplazado por `python3 -c "import urllib.request; ..."` (python3 sí está en la imagen). Verificado: exit 0.

Tests: 818 / 0 fail / 1475 expects (de 816/1470 pre-fix).

### PR Audit-3 — Coherencia documental + reglas globales (2026-05-08)

Cierra los items de Nivel 4 de la auditoría 360º y formaliza los patrones detectados como reglas reusables — separadas por scope.

DOCS DRIFT (Nivel 4)

- **D1**: `pilot-report-v1.md` métricas actualizadas a 816/1470/51.
- **D4**: `ORGANIZATION.md` corregido `I-1..I-13` → `I-1..I-14`.
- **D7**: `S23-A.md` referencia a "ADR-012" inexistente reemplazada por nota explicativa (RFC-002 decide "no implementar", no se crea ADR).
- **D8**: `ARCHITECTURE.md §11` actualizada con estado real de PBI #3 (`hooks/pre-tool-use-guard.sh` ya implementado, 21 tests, activo en settings).
- **D10**: typo `atlas360` → `atlax360` en `ARCHITECTURE.md`.
- **D11**: README/ARCHITECTURE/CHANGELOG sincronizan números de tests (816, 1470, 51 ficheros).

REGLAS GLOBALES (`~/.claude/rules/`)

- `security.md` extendido: path confinement helper, Docker bind 127.0.0.1, credentials a archivo 600 (no shell rc), no loguear key prefixes, eval prohibido en bash, sanitizar inputs de pipes, NaN guards en env vars, validación constants en `shared/`, bound de longitud en regex.
- `testing.md` extendido: subprocess coverage gap awareness, doble cobertura unit + E2E, tests E2E invocan script real (no helper), `process.env` restore por clave (patrón I-12), `os.homedir()` inmutable en runtime de Bun, aserciones específicas (`toBeCloseTo` para floats), polling con backoff vs sleeps hardcoded, concurrency tests para mutexes.
- `cross-project-patterns.md` extendido: ToolContext.signal/stepBudgetMs es contrato, errores tipados sobre string-match (`LangfuseNotFoundError`), `.toSorted()` sobre `.sort()` (ES2023, requiere `lib: ES2023` en tsconfig).

REGLAS DE PROYECTO (`CLAUDE.md`)

- Sección "Convenciones específicas (post-auditoría 360º 2026-05-08)" añadida con los 4 patrones específicos del bridge: backfill env vars, SAFE_SID_RE desde shared/, safeFilePath() para transcript_path, comentarios `// I-N` en código.

Tests: 816 / 0 fail / 1470 expects.

### PR Audit-2 — Hardening + calidad (2026-05-08)

Items Nivel 2-3 de la auditoría 360º. Sin afectar comportamiento, propaga reglas
que ya existían en un módulo a todos los demás:

- **H1**: NaN guards añadidos en `THROTTLE_MS` (`backfill-historical-traces.ts`) y
  `MCP_STEP_BUDGET_MS` (`mcp-server.ts`). Patrón copiado del existente en
  `WINDOW_HOURS` (`reconcile-traces.ts`). `setTimeout(fn, NaN)` y
  `AbortSignal.timeout(NaN)` ya no producen comportamiento silencioso/RangeError.
- **H2 + H6**: `SAFE_SID_RE` movido a `shared/validation.ts` con bound de longitud
  `{1,128}`. Eliminados duplicados en `reconcile-traces.ts` (re-export por compat)
  y `backfill-historical-traces.ts`. Aplicado por primera vez en `validate-traces.ts`.
- **H3**: `mcp-server.ts` con `MAX_LINE_BYTES = 1MB`: si un cliente envía una línea
  > 1MB sin newline, el servidor cierra la conexión en vez de crecer hasta OOM.
- **H5**: `tier.json` se escribe con `mode: 0o600` (defensa en profundidad por si
  el campo `account` lleva datos sensibles en el futuro).
- **H9**: `litellm-m3-virtual-keys.test.ts` — sleep hardcoded de 2s reemplazado por
  polling con backoff exponencial (250ms→4s, deadline 8s). Reduce flakiness en CI lento.
- **H10**: `costEntries.sort()` mutante reemplazado por `[...].toSorted()` (ES2023).
  `tsconfig.json` sube `lib: ES2023`.
- **H11**: `readTierFile()` valida también el campo `account` (debe ser `string|null`).
- **H12**: `pilot-onboarding.sh` elimina `eval "$*"` — usa `"$@"` con printf %q
  para dry-run. Antipattern reconocido del global rules.

CALIDAD

- **Q1**: Eliminados los 4 `require()` en módulos ESM (3 tests + 1 import lazy):
  `cross-validation.test.ts`, `langfuse-payload-schema.test.ts`,
  `langfuse-sync.test.ts` (await import), `detect-tier-advanced.test.ts`.
- **Q2**: Aserciones débiles fortalecidas (`toBeCloseTo` para floats, `not.toBe("undefined")`).
- **Q4**: `as any` en zod-adapter default reemplazado por exhaustiveness check con
  `const _exhaustive: never = prop.type` (TS detecta variantes nuevas).
- **Q5**: `withSandboxAll<T extends AgentTool<any, any>>` → `<unknown, unknown>` +
  `readonly T[]` (preserva tsconfig maximalista).
- **Q7**: Browser extension genera generation IDs con `crypto.randomUUID()` en vez
  de `${traceId}-${now}` (millisecond collision en automatización).
- **Q8**: Browser extension añade tag `cost-source:estimated` para coincidir con
  hook + reconciler (queries de dashboard ven todas las superficies consistentemente).
- **Q9**: Nuevo `tests/concurrency.test.ts` (+11 tests):
  - Mutex de `withSandbox`: serialización de N=10 calls concurrentes verificada
    con `maxInFlight === 1`.
  - Liberación del mutex tras rejection (no deadlock).
  - Independencia entre tools de nombre distinto.
  - Validación defensiva de tools MCP con args malformados (null, tipos erróneos,
    limit fuera de rango, value object).
  - Path traversal: `safeFilePath()` bloquea `../`, sibling-prefix trick, input vacío.
- **Q10**: `provision-keys.ts` ya no loguea prefix de virtual key — solo length.
- **Q12**: `backup-langfuse.sh` valida nombres de tabla con regex
  `^[a-zA-Z_][a-zA-Z0-9_]*$` antes de interpolar en SQL (defensa en profundidad).

Tests: 816 / 0 fail / 1470 expects (+11 tests, +18 expects vs PR Audit-1).

### PR Audit-1 — Bloqueantes pre-onboarding (2026-05-08)

Salida de la auditoría 360º (4 agentes especializados). Items bloqueantes:

- **B1** README Quick Start §2: corregido — `pilot-onboarding.sh` solo acepta `--litellm-mode` y `--dry-run`, las credenciales son env vars (no flags `--host`/`--public-key` que no existen).
- **B2** ADR-010 + ADR-009 + ADR-011 añadidos al índice canónico (`docs/adr/README.md`); CLAUDE.md y ARCHITECTURE.md ahora dicen `ADR-001..ADR-011` (eran "001..009, 011").
- **B3** Versión declarada `v0.6.0-wip` (era `0.5.4` en `package.json`, `0.5.5` en ARCHITECTURE, "v1.0" en README). v1.0 al cumplir exit criteria del piloto (≥3 devs × 2 semanas).
- **B4** Langfuse 3.172.1 documentado en CHANGELOG (drift respecto a 3.171.0 que figuraba antes).
- **B5** `ToolContext.signal`/`stepBudgetMs` ahora cableado en `query-langfuse-trace.ts` y `annotate-observation.ts` con `AbortSignal.any([stepSignal, ctx.signal])`. `shared/langfuse-client.ts` extendido para aceptar `signal` en `LangfuseConfig`. Bonus L-3: `LangfuseNotFoundError` tipado reemplaza el string-match `"→ 404"`.
- **B6** `docker-compose.yml`: `langfuse-web:3000` y `litellm:4001` ahora bindados a `127.0.0.1:` (estaban a `0.0.0.0`, accesibles desde LAN).
- **B7** Hook `transcript_path` confinado a `~/.claude/projects/` con nuevo helper `safeFilePath()` en `shared/validation.ts`. Override `ATLAX_TRANSCRIPT_ROOT_OVERRIDE` reservado solo para tests.
- **B8** `setup/setup.sh` converge con `pilot-onboarding.sh`: credenciales a `~/.atlax-ai/bridge.env` (chmod 600) + `source` desde shell rc, en vez de inline en `~/.zshrc` (chmod 644). Añadida limpieza de installs legacy.
- **B9** `backfill-historical-traces.ts`: inyecta `_invokedByReconciler: true` en el payload Stop (tag `source:reconciler`) y `LANGFUSE_FORCE_NOW_TIMESTAMP=1` en el env (evita que ClickHouse ReplacingMergeTree pierda traces buenos).
- **B10** I-12 violations limpiadas: 14 ocurrencias de `process.env = { ...origEnv }` en 7 ficheros de test → reemplazadas por nuevo helper `tests/helpers/env.ts` (`saveEnv`/`restoreEnv` por clave específica).
- **H4** StopEvent con validación de tipos explícita (`typeof event.session_id === "string"` etc.) tras el `JSON.parse`.

### Ops (Sprint 24 — 2026-05-07) · CIERRE v1

- **S24-A**: `README.md` reescrito para v1 — Quick Start actualizado (hook + piloto LiteLLM), tabla de qué se registra, comandos esenciales, limitaciones conocidas, estructura del repo, árbol `docs/` completo. Versión: v1.0 / 776 tests.
- **S24-B**: `docs/operations/pilot-report-v1.md` — reporte de cierre con métricas del piloto: 8/8 sprints completados, 31/33 items (S21-B bloqueado por dep humana, S23-C no aplica), bridge-health `status:ok`, reconciler 100% tasa de reparación, 0 devs en piloto LiteLLM (gap de adopción: script listo, faltan voluntarios).
- **S24-C**: `docs/roadmap/post-v1-backlog.md` — 8 items POST-V1 priorizados (ALTA: upgrade LiteLLM, distribuir hook 13 devs, onboarding piloto; MEDIA: multi-IDE, multi-vendor, dashboard→Langfuse; BAJA: cobertura reconciler, scope review automatizado).
- **S24-D**: `~/work/atlax-observatorios/scope-reviews/scope-review-2026-05.md` — scope review mayo 2026: 3 reclasificaciones (ADR-009 y I-6 promovidos a `applicable`; Key Decisions dashboard promovidos a ADR pending).

### Ops (Sprint 23 — 2026-05-07)

- **S23-A**: spike `docs/spikes/S23-A-bridge-http-viability.md` — análisis exhaustivo de si `atlax-claude-dashboard` necesita lectura HTTP del bridge. Hallazgo clave: el dashboard es 100% independiente (Anthropic Admin API → Postgres propio, 0 referencias al bridge/Langfuse en su código). No existe demanda actual.
- **S23-B**: `docs/rfcs/RFC-002-bridge-http-no-implementar.md` — decisión "no implementar" HTTP server en el bridge. Razones: no hay demanda, viola I-13 en espíritu, añade SPOF, alternativa superior post-v1 es `dashboard → Langfuse API` directa. CP-4 del roadmap resuelto como CP-4-v2 (post-v1, sin cambios en bridge).
- **S23-C**: no aplica — RFC-002 decide "no implementar", nada que proyectar a Sprint 24.

### Fix (PR #61 — 2026-05-07)

- `docs/operations/langfuse-dashboard-guide.md`: corrección nombre trace `langfuse-sync` → `claude-code-session` en tabla de trazas disponibles (el hook emite `name: "claude-code-session"` en línea 325 de `hooks/langfuse-sync.ts`)
- `tests/langfuse-sync-unit.test.ts`: 26 tests unitarios directos sobre funciones exportadas del hook (`calcCost`, `getBillingTier`, `getDevIdentity`, `getProjectName`, `readTierFile`, `detectOS`); cobertura de `hooks/langfuse-sync.ts` sube de ~25% a ≥60%

### Ops (Sprint 22 — 2026-05-07)

- **S22-A** (PR #56): tag `source:reconciler` en todos los traces emitidos por el reconciler
- **S22-B** (PR #57): `sendBridgeHealthTrace()` — trace `bridge-health` al final de cada scan (traceId day-scoped, tags `status:ok/degraded`, `metadata.degradations[]`); 10 tests en `tests/bridge-health.test.ts`
- **S22-C**: audit deps — `bun-types@^1.3.13` (compatible con bun 1.3.12), `typescript@5.9.3` (latest 5.x, no bump a 6 — breaking), `zod@3.25.76` (latest 3.x, no bump a 4 — API incompatible). `bun run check` pasa sin warnings.
- **S22-D**: `docs/operations/langfuse-dashboard-guide.md` — guía de observabilidad: 7 queries de referencia (sesiones/dev, bridge-health, drift rate, días degraded, cost divergence, cobertura IDE, tiempo a primer trace) + alertas recomendadas + API curl snippets + runbook de diagnóstico rápido
- **S21-A/C/D** (PR #59): `litellm-onboarding.md`, `pilot-onboarding.sh` (--litellm-mode, --dry-run), `pilot-kpis.md` (exit criteria 2 semanas consecutivas)
- **S20-A/B/C** (PR #58): smoke tests LiteLLM virtual keys — /key/generate shape, budget enforcement (400 budget_exceeded), atribución Langfuse (user_api_key_alias ✓, user_api_key_user_id null = bug conocido v1.83.7)

### Metrics

- Tests: 805 / expects: 1450 / files: 50 / 0 fail (post-audit pass 2026-05-08)

### Audit pass 2026-05-08 (post-cierre v1)

- `tests/reconcile-pure-functions.test.ts`: +29 tests directos sobre las funciones puras del reconciler (`familyKey`, `computeReportRange`, `isSeatOnlyScenario`, `compareCostByModel`). Cubre la lógica de divergencia coste estimado/real introducida en S18-B sin necesidad de mocks HTTP.
- Sincronización de métricas: `README.md`, `ARCHITECTURE.md §10`, `CHANGELOG.md` actualizados a 805/1450/50.
- Validación SDD (`tests/sdd-invariants.test.ts` + `tests/sdd-links.test.ts`): 58/58 tests verdes — todos los I-1..I-14 tienen cobertura documental, todos los paths referenciados existen.

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
