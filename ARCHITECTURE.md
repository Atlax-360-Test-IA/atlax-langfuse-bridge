# ARCHITECTURE — atlax-langfuse-bridge

> **SDD canónico** del proyecto. Documenta el "qué" y el "por qué" de la
> arquitectura. Para instrucciones operativas en sesión Claude Code, ver
> [`CLAUDE.md`](./CLAUDE.md). Para procedimientos operativos, ver
> [`docs/operations/runbook.md`](./docs/operations/runbook.md). Para decisiones
> formales, ver [`docs/adr/`](./docs/adr/).

**Versión actual**: v0.5.5
**Última actualización**: 2026-05-07
**Estado**: Production-ready PoC (Langfuse v3 self-hosted local)

---

## §1 · Identidad del Proyecto

| Campo                   | Valor                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| **Nombre**              | `atlax-langfuse-bridge`                                                       |
| **Propósito**           | Torre de control FinOps del consumo de Claude Code en Atlax360 (38 devs)      |
| **Owner**               | `jgcalvo@atlax360.com`                                                        |
| **Stakeholders**        | 38 developers Atlax360 (usuarios), CTO Atlax360 (sponsor)                     |
| **Runtime ownership**   | Edge: máquina del dev. Core: Cloud Run en PRO (no aplicado en CI actual)      |
| **Estado del producto** | Production-ready PoC. Local self-hosted operativo. PRO migration documentada. |
| **Repositorio**         | `github.com/Atlax-360-Test-IA/atlax-langfuse-bridge`                          |

### Fases de versión

| Fase   | Versión           | Hito                                                                |
| ------ | ----------------- | ------------------------------------------------------------------- |
| Fase 0 | v0.1.0            | Hook Stop + reconciler + tier.json (PoC funcional)                  |
| Fase 1 | v0.2.x            | Pricing centralizado + LiteLLM gateway opt-in M1-M3                 |
| Fase 2 | v0.3.x            | Degradation log + tier cache + MCP server + browser extension       |
| Fase 3 | v0.4.x            | Hardening sprints 1-6 (294 tests, 89% coverage)                     |
| Fase 4 | v0.5.0 → v0.5.4   | Hardening sprints 7-15 + audit passes (466 tests, 0 deuda residual) |
| Fase 5 | v0.6.0 (en curso) | Documentación canónica completa                                     |
| Fase 6 | v1.0.0 (futuro)   | Migración a PRO (Cloud Run + Cloud SQL + Memorystore + ClickHouse)  |

---

## §2 · Stack Tecnológico

| Capa                    | Componente                                | Versión / Notas                                | Justificación                                    |
| ----------------------- | ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| **Runtime**             | Bun                                       | ≥1.3 (pinned `1.3.x` en CI)                    | [ADR-001](./docs/adr/ADR-001-bun-cero-deps.md)   |
| **Lenguaje**            | TypeScript                                | ^5.4.0                                         | Type safety + zero runtime cost via `bun run`    |
| **Deps prod**           | Cero                                      | —                                              | [ADR-001](./docs/adr/ADR-001-bun-cero-deps.md)   |
| **Deps dev**            | `bun-types`, `typescript`, `zod`          | —                                              | Solo build/test; nunca en runtime                |
| **Observabilidad**      | Langfuse v3 self-hosted                   | postgres + clickhouse + redis + minio (docker) | Cero vendor lock; OSS license                    |
| **Gateway (opt-in)**    | LiteLLM proxy                             | v1.83.7-stable                                 | [ADR-007](./docs/adr/ADR-007-litellm-optin.md)   |
| **CI**                  | GitHub Actions                            | matrix `ubuntu-latest` + `macos-latest`        | Compatibilidad cross-platform de los 38 devs     |
| **PRO target (futuro)** | Cloud Run + Cloud SQL + Memorystore + GCS | Documentado en `infra/cloud-run.yaml`          | [ADR-002](./docs/adr/ADR-002-edge-core-split.md) |

---

## §3 · Modelo de Dominio

### Entidades principales

| Entidad        | Definición                                                          | Storage                                             |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| **Session**    | Una sesión Claude Code completa, identificada por `session_id` UUID | `~/.claude/projects/**/sessions/{session_id}.jsonl` |
| **Trace**      | Registro Langfuse con `id = cc-${session_id}` (idempotente)         | Langfuse postgres + clickhouse                      |
| **Turn**       | Entry JSONL con `message.model` + `message.usage.*`                 | Línea del JSONL                                     |
| **Drift**      | `OK \| TURNS_DRIFT \| COST_DRIFT \| END_DRIFT \| MISSING`           | Computado en runtime por `shared/drift.ts`          |
| **Tier**       | `seat-team \| vertex-gcp \| api-direct \| unknown`                  | `~/.atlax-ai/tier.json`                             |
| **VirtualKey** | Clave LiteLLM por workload con soft budget                          | `~/.atlax-ai/virtual-keys.json` + LiteLLM postgres  |

### Flujo de datos JSONL → Langfuse

```
┌────────────────────┐     ┌──────────────────────┐
│  Capa síncrona     │     │  Capa asíncrona      │
│  hook Stop         │     │  reconciler cron     │
│  on session close  │     │  every 15 min        │
│  (best-effort)     │     │  (eventual SSoT)     │
└──────────┬─────────┘     └──────────┬───────────┘
           │   POST /api/public/ingestion
           ▼                          ▼
        ┌───────────────────────────────────┐
        │  Langfuse (idempotent upsert)     │
        │  traceId = cc-${session_id}       │
        └───────────────────────────────────┘
```

La capa síncrona captura al cerrar sesión. La asíncrona escanea
`~/.claude/projects/**/*.jsonl` recientes, detecta drift, y re-ejecuta el hook
con un payload Stop sintético. Garantiza eventual consistency aunque Claude Code
crashee, se haga `kill -9`, o la máquina reinicie antes de que `Stop` se dispare.
Ver [ADR-006](./docs/adr/ADR-006-two-layer-consistency.md).

### Cubos de facturación

| Tag Langfuse                         | Cuándo                               |
| ------------------------------------ | ------------------------------------ |
| `billing:anthropic-team-standard`    | Uso normal dentro del plan Team      |
| `billing:anthropic-priority-overage` | `service_tier: "priority"` — overage |
| `billing:vertex-gcp`                 | `CLAUDE_CODE_USE_VERTEX=1` activo    |

---

## §4 · Estructura del Repositorio

### Mapa con clasificación edge/core

```
atlax-langfuse-bridge/
├── docker/                           [core — Langfuse v3 self-hosted]
│   ├── docker-compose.yml            # postgres + clickhouse + redis + minio + langfuse-{web,worker} + litellm (opt-in)
│   ├── env.example                   # Variables requeridas
│   └── litellm/config.yaml           # Config gateway LiteLLM
│
├── hooks/                            [edge — máquina del dev]
│   └── langfuse-sync.ts              # Hook Stop (Bun, cero deps), I-1 timeout 10s
│
├── scripts/                          [edge mayoritariamente]
│   ├── validate-traces.ts            # Smoke: JSONL local vs Langfuse [edge]
│   ├── reconcile-traces.ts           # Cron: detect+repair drift [edge]
│   ├── detect-tier.ts                # Escribe ~/.atlax-ai/tier.json [edge]
│   ├── mcp-server.ts                 # MCP stdio server [puede ser edge o core]
│   ├── provision-keys.ts             # Provisiona virtual keys LiteLLM [admin]
│   ├── smoke-mcp-e2e.ts              # E2E test CI-runnable [CI]
│   ├── smoke-litellm-langfuse.ts     # E2E LiteLLM gateway [CI]
│   ├── pilot-onboarding.sh           # Onboarding devs piloto (--litellm-mode, --dry-run) [edge]
│   └── statusline.sh                 # Statusline → detect-tier [edge]
│
├── shared/                           [biblioteca pura, importable de edge y core]
│   ├── model-pricing.ts              # SSoT pricing (I-6)
│   ├── aggregate.ts                  # JSONL → ModelUsage (I-3)
│   ├── degradation.ts                # emitDegradation → stderr JSON
│   ├── drift.ts                      # classifyDrift + DriftStatus (I-11)
│   ├── constants.ts                  # COST_EPSILON
│   ├── env-loader.ts                 # Carga .atlax-ai/reconcile.env
│   ├── hash-cache.ts                 # Cache SHA256 con TTL 24h
│   ├── jsonl-discovery.ts            # Discover JSONLs en ~/.claude/ [edge]
│   ├── langfuse-client.ts            # Cliente REST Langfuse (timeout, SSRF guard)
│   ├── processing-tiers.ts           # Taxonomía deterministic/cached_llm/full_llm
│   └── tools/                        # AgentTools registry
│       ├── query-langfuse-trace.ts
│       ├── annotate-observation.ts
│       ├── sandbox.ts                # echo / fixture / degradation modes
│       ├── registry.ts               # Registro central (SSoT)
│       └── adapters/
│           ├── zod-adapter.ts        # → AI SDK
│           └── mcp-adapter.ts        # → MCP protocol
│
├── tests/                            [CI]
│   ├── cross-validation.test.ts      # Invariantes I-12, I-7
│   ├── e2e-pipeline.test.ts          # I-3 cwd extraction
│   ├── langfuse-sync-http.test.ts    # Hook con Bun.serve mock
│   ├── reconcile-replay.test.ts      # Reconciler I-5 + idempotencia
│   ├── cloud-run-boundary.test.ts    # ADR ejecutable I-13 (17 tests)
│   └── extension-pricing.test.ts     # I-6 cross-validation
│
├── browser-extension/                [edge — Chrome del dev]
│   └── src/                          # MV3: content + service worker + popup
│
├── infra/                            [PRO target docs]
│   ├── cloud-run.yaml                # Manifest referencia (I-13)
│   └── backup-story.md               # Cloud SQL PITR + ClickHouse + GCS
│
├── docs/
│   ├── adr/                          # 9 ADRs Michael Nygard (ADR-001..ADR-009, ADR-011)
│   ├── operations/
│   │   ├── runbook.md                # Runbook operativo
│   │   ├── litellm-onboarding.md     # Guía onboarding devs piloto (S21-A)
│   │   ├── pilot-kpis.md             # KPIs formales del piloto + exit criteria (S21-D)
│   │   └── langfuse-dashboard-guide.md # Queries observabilidad bridge + piloto (S22-D)
│   └── systemd/                      # User units Linux/WSL del reconciler
│
├── setup/                            [edge installers]
│   ├── setup.sh                      # Linux / macOS / WSL
│   └── setup.ps1                     # Windows nativo
│
├── ARCHITECTURE.md                   # Este documento (SDD)
├── CHANGELOG.md                      # Semver retroactivo
├── ORGANIZATION.md                   # Convenciones Atlax
├── README.md                         # Quick Start + setup
└── CLAUDE.md                         # Invariantes I-1..I-14 (instrucciones Claude Code)
```

### Tabla de módulos `shared/` con invariante implementado

| Módulo               | Invariante | Propósito                                                     |
| -------------------- | ---------- | ------------------------------------------------------------- |
| `model-pricing.ts`   | **I-6**    | SSoT precios — único lugar a editar en cambios Anthropic      |
| `aggregate.ts`       | **I-3**    | `cwd` extraído del primer JSONL entry, no del Stop event      |
| `drift.ts`           | **I-11**   | `classifyDrift` única fuente — importado por reconcile/tests  |
| `langfuse-client.ts` | —          | SSRF guard (allowlist HTTPS / localhost), timeout 10s         |
| `hash-cache.ts`      | —          | Cache SHA256 con TTL 24h + cleanup `setInterval(...).unref()` |
| `degradation.ts`     | —          | `emitDegradation()` JSON estructurado a stderr                |

### Tabla de `scripts/` con tier de processing

| Script                | Tier            | Cacheable | Descripción                               |
| --------------------- | --------------- | --------- | ----------------------------------------- |
| `validate-traces.ts`  | `deterministic` | ✅        | Drift check vs Langfuse (read-only)       |
| `reconcile-traces.ts` | `deterministic` | ❌        | Detect + repair drift (write)             |
| `detect-tier.ts`      | `deterministic` | ❌        | Escribe `tier.json` (write)               |
| `mcp-server.ts`       | varía           | varía     | Tools agénticos (delega a tools registry) |
| `provision-keys.ts`   | `deterministic` | ❌        | Idempotente — re-ejecutar es seguro       |
| `smoke-mcp-e2e.ts`    | `deterministic` | ❌        | Round-trip test                           |

---

## §5 · Convenciones de Código

### Reglas no negociables

- **Hook nunca lanza ni rechaza** — siempre `process.exit(0)` (I-1). Cualquier error → degradation log + exit 0
- **Logging**: `process.stderr.write()` con JSON estructurado, **nunca** `console.log` en producción
- **File I/O**: `readFileSync` + `split("\n")` para JSONLs <50MB, no streaming (más simple, más rápido)
- **Sin retries síncronos** en el hook — timeout 10s duro; el reconciler cubre lo que el hook no consigue
- **Comentario `// I-N`** en funciones que implementan invariantes (trazabilidad)
- **Restauración `process.env` per-key** en tests (I-12) — nunca `process.env = {...origEnv}`
- **Guard `if (import.meta.main)`** en todos los scripts con side-effects

### Patrones canónicos

- **Cero deps prod**: `package.json.dependencies` vacío. Solo `devDependencies` para tipos y zod (build-time)
- **Allowlist en SSRF**: `langfuse-client.ts:isSafeHost()` rechaza protocolos non-http(s) y hosts non-localhost via http
- **Validación de filenames**: `SAFE_SID_RE = /^[0-9a-zA-Z_-]+$/` en reconciler — rechaza path traversal
- **Atomic writes**: `tier.json` y `virtual-keys.json` se escriben via `Bun.write(.tmp) + rename()`
- **Fetch con timeout obligatorio**: `AbortSignal.timeout(timeoutMs)` en cada outbound HTTP

---

## §6 · Pipeline CI/CD

### Jobs en `.github/workflows/ci.yml`

| Job             | Trigger  | Timeout | Matrix         | Continue on error  |
| --------------- | -------- | ------- | -------------- | ------------------ |
| `test`          | push, PR | 15 min  | ubuntu + macos | No                 |
| `smoke-e2e`     | push, PR | 10 min  | ubuntu         | No (skip-graceful) |
| `smoke-litellm` | push, PR | 10 min  | ubuntu         | Sí                 |

- **Bun version pinned**: `oven-sh/setup-bun@v2` con `bun-version: "1.3.x"` (commit SHA pinned)
- **Cache**: `actions/cache@v4` sobre `~/.bun/install/cache` keyed en `hashFiles('bun.lock','bun.lockb')`
- **Frozen lockfile**: `bun install --frozen-lockfile` en cada job
- **Permissions**: `contents: read` en todos los jobs (mínimo viable)

Sin CD automático — deploy manual vía `setup/setup.sh` en máquinas dev.

### Política semver

| Tipo de cambio                     | Bump  |
| ---------------------------------- | ----- |
| Breaking del payload del hook      | MAJOR |
| Breaking del protocolo MCP         | MAJOR |
| Nueva capability (sprint feature)  | MINOR |
| Audit pass / fix / refactor / docs | PATCH |

Ver `CHANGELOG.md` para mapping versión → PR.

---

## §7 · Contratos de Datos

### Payload Stop (entrada del hook)

Recibido por stdin en formato JSON:

```typescript
type StopEvent = {
  session_id: string; // UUID — identifica la sesión Claude Code
  transcript_path: string; // Ruta al JSONL de la sesión
  cwd: string; // Directory del proceso (ver I-3 — usar primer entry, no éste)
  permission_mode: string; // "default" | "acceptEdits" | ...
  hook_event_name: "Stop"; // Discriminador
};
```

### Ingestion batch (salida hook → Langfuse)

```typescript
type IngestionBatch = {
  batch: Array<{
    type: "trace-create" | "generation-create";
    timestamp: string; // ISO 8601
    body: {
      id: string; // cc-${session_id} para trace, ${traceId}-${safeModelId} para generation
      // ... campos específicos por tipo
    };
  }>;
};
```

### `~/.atlax-ai/tier.json`

```typescript
type TierFile = {
  tier: "seat-team" | "vertex-gcp" | "api-direct" | "unknown";
  source: "env" | "credentials-exists" | "unknown";
  account: string | null; // Siempre null cuando source=credentials-exists (I-8)
  ts: string; // ISO 8601
};
```

### Degradation log (stderr JSON)

```typescript
type DegradationEntry = {
  type: "degradation";
  source: string; // ej. "sendToLangfuse", "getTrace:fetch"
  error: string; // String(err) safe
  ts: string; // ISO 8601
};
```

### `~/.atlax-ai/virtual-keys.json`

```typescript
type VirtualKeysFile = {
  keys: Array<{
    key_alias: string; // "orvian-prod" | "atalaya-prod" | ...
    key: string; // sk-...
    workload: string; // "orvian" | "atalaya"
    soft_budget_usd: number;
    budget_duration: string; // "30d"
    tpm: number;
    rpm: number;
    created: string; // ISO 8601
  }>;
};
```

---

## §8 · Observabilidad

### Tags Langfuse aplicados a cada trace

| Tag                    | Ejemplo                             | Fuente                                                                                   |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `project:owner/repo`   | `project:atlas360/harvest`          | `git remote get-url origin`                                                              |
| `billing:<tier>`       | `billing:anthropic-team-standard`   | Heurística sobre `service_tier` + `CLAUDE_CODE_USE_VERTEX`                               |
| `tier:<tier>`          | `tier:seat-team`                    | `~/.atlax-ai/tier.json` (autoritativo, ver [ADR-004](./docs/adr/ADR-004-tier-system.md)) |
| `tier-source:<source>` | `tier-source:credentials-exists`    | `~/.atlax-ai/tier.json`                                                                  |
| `os:<platform>`        | `os:linux-wsl`                      | `/proc/version` + `process.platform`                                                     |
| `entrypoint:<type>`    | `entrypoint:cli`                    | JSONL `entrypoint` (`cli` / `sdk-ts`)                                                    |
| `branch:<git-branch>`  | `branch:feat/sprint-15`             | JSONL `gitBranch`                                                                        |
| `infra:<provider>`     | `infra:anthropic`                   | Derivado de tier                                                                         |
| `surface:<surface>`    | `surface:cli` / `surface:chat`      | Hook → `cli`; extension → `chat`/`projects`                                              |
| `platform:<platform>`  | `platform:browser` / `platform:app` | Solo extension — UA Electron → `app`                                                     |

Los tags son UNION en upsert (I-4). No hay PATCH/DELETE de tags vía API pública.

### Degradation log

Todos los `catch` del hook y reconciler emiten:

```json
{
  "type": "degradation",
  "source": "sendToLangfuse",
  "error": "fetch failed",
  "ts": "2026-04-27T10:00:00.000Z"
}
```

Diagnóstico:

```bash
journalctl --user -u atlax-langfuse-reconcile.service -n 50 \
  | grep '"type":"degradation"' \
  | jq .
```

### Tier cache SHA256

`shared/hash-cache.ts` implementa cache en memoria (`Map<hash, tier>`) con TTL 24h
y cleanup automático vía `setInterval(...).unref()`. El hash es SHA256 del
contenido relevante del trace (`modelo + tokens + session_id`). Evita
reclasificar traces idénticos en sesiones largas.

### Statusline

`scripts/statusline.sh` se invoca por Claude Code en cada turno y actualiza
`tier.json`. Configuración en `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/atlax-langfuse-bridge/scripts/statusline.sh"
  }
}
```

### Métricas de referencia

- **Devs activos**: 38 (Atlax360)
- **Sesiones/día estimadas**: ~30 (variable por dev)
- **Volumen 1 año estimado**: <50M trazas (cap nativo de ClickHouse holgado)
- **Latencia hook p99**: <2s (timeout 10s nunca alcanzado en operación normal)
- **Latencia reconciler p99**: <30s/dev (escaneo + drift detection sin repair)

---

## §9 · Seguridad

### Reglas no negociables

- **Nunca parsear `~/.claude/.credentials.json`** — solo comprobar existencia (I-8). El archivo contiene tokens OAuth de sesión Anthropic.
- **`account` en `tier.json` queda `null`** cuando la fuente es `credentials-exists` — privacy by design.
- **Secretos en `~/.atlax-ai/`** con permisos 600. El setup script verifica.
- **`LITELLM_SALT_KEY` inmutable** tras emitir virtual keys — cambiarla invalida todas las keys.
- **Sandbox modes MCP solo via env** (`LANGFUSE_BRIDGE_SANDBOX_MODE`), nunca via input de tool.
- **`MCP_AGENT_TYPE` validado contra allowlist** (I-10) — degradación a `coordinator` con warning.
- **SSRF allowlist** en `langfuse-client.ts` — HTTPS para cualquier host, HTTP solo localhost.
- **Path traversal protection**: `SAFE_SID_RE = /^[0-9a-zA-Z_-]+$/` en reconciler — rechaza filenames maliciosos.

### En PRO (Cloud Run)

- **Secret Manager** para todos los secrets (NEXTAUTH_SECRET, ENCRYPTION_KEY, claves Langfuse, claves LiteLLM, HMAC GCS)
- **VPC privada** para Memorystore + ClickHouse — no IPs públicas
- **HTTPS only** vía Cloud Load Balancer + cert managed
- **Cloud SQL** con IAM auth + auditoría
- **GCS** con Object Versioning + lifecycle policy 90d

Ver `infra/backup-story.md` para detalle de backup story (RPO ≤ 1 min).

---

## §10 · Testing

**Estado actual**: 750 tests / 1370 expects / 48 ficheros / 0 fallos.

### Pirámide de tests

| Capa                 | Ficheros clave                                                                                      | Cobertura                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Unitarios**        | `tests/*.test.ts`, `shared/*.test.ts`, `scripts/*.test.ts`, `browser-extension/src/*.test.js`       | Todos los módulos                                                                      |
| **Cross-validation** | `tests/cross-validation.test.ts`                                                                    | Invariantes entre módulos (pricing, drift, tier)                                       |
| **E2E CI-runnable**  | `tests/langfuse-sync-http.test.ts`, `tests/reconcile-replay.test.ts`, `tests/bridge-health.test.ts` | Hook HTTP + reconciler DRY_RUN + bridge-health trace con Bun.serve mocks               |
| **Smoke LiteLLM**    | `tests/litellm-m3-virtual-keys.test.ts`                                                             | S20-A/B/C: /key/generate, budget enforcement, atribución Langfuse (skip si no gateway) |
| **ADR ejecutable**   | `tests/cloud-run-boundary.test.ts`                                                                  | Verifica I-13 estructuralmente (17 tests)                                              |

### Mapeo invariante → fichero de test

| Invariante | Cobertura principal                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| **I-1**    | `tests/langfuse-sync-http.test.ts` (hook nunca exit ≠ 0)                                                                    |
| **I-2**    | `tests/e2e-pipeline.test.ts:121` (`trace body.timestamp matches envelope (I-2)`)                                            |
| **I-3**    | `tests/e2e-pipeline.test.ts:228+` (`E2E edge cases (I-3: cwd from first entry)`)                                            |
| **I-4**    | Comentario en `shared/aggregate.ts:46` (allowlist de tags)                                                                  |
| **I-5**    | `tests/reconcile-replay.test.ts:135` (`reconcile-traces — dry run scan (I-5)`)                                              |
| **I-6**    | `tests/extension-pricing.test.ts:15` (`extension pricing.js ↔ shared/model-pricing.ts sync (I-6)`)                          |
| **I-7**    | `scripts/detect-tier.test.ts:10` (`detectTier (I-7, I-12)`)                                                                 |
| **I-8**    | `scripts/detect-tier.test.ts:72` (`I-8: OAuth tier never reads credentials content`)                                        |
| **I-9**    | (Documental — el bridge no genera IDs propios actualmente)                                                                  |
| **I-10**   | `scripts/mcp-server.test.ts:43` (`tools/list (I-10)`)                                                                       |
| **I-11**   | `shared/drift.test.ts` + `scripts/{validate,reconcile}-traces.test.ts`                                                      |
| **I-12**   | `tests/cross-validation.test.ts:90` (`tier detection consistency (I-12)`)                                                   |
| **I-13**   | `tests/cloud-run-boundary.test.ts` (17 tests, ADR ejecutable)                                                               |
| **I-14**   | `docs/experiments/2026-05-07-parallel-subagent-experiment.md` + `docs/adr/ADR-011-parallel-subagent-limits.md` (documental) |

### Comandos

```bash
bun test          # todos los tests
bun test --watch  # modo desarrollo
bun run check     # typecheck + tests
```

### Política no-flaky

- Smoke E2E con credenciales: skip-graceful si `LANGFUSE_PUBLIC_KEY` no está
- Smoke LiteLLM: `continue-on-error: true` en CI (gateway no siempre disponible)
- Subprocess tests con timeout via `Promise.race` (30s) — no `await proc.exited` desnudo
- `process.env` restoration per-key (I-12) — no global mutation

---

## §11 · GAPs Resueltos

### Sprints 7-15 (PRs #19-#28)

| Sprint    | PR  | Hito                                                                |
| --------- | --- | ------------------------------------------------------------------- |
| Sprint 7  | #19 | 5 critical security fixes C1-C5 (path traversal, SSRF, auth bypass) |
| Sprint 8  | #20 | Extension hardening H1-H5                                           |
| Sprint 9  | #21 | HIGH `shared/` + types + tsconfig                                   |
| Sprint 10 | #22 | HIGH CI/Docker hardening H14-H19                                    |
| Sprint 11 | #23 | MEDIUM dedup + architecture                                         |
| Sprint 12 | #24 | LOW + meta (zero new debt)                                          |
| Sprint 13 | #25 | EXT-H1/M1/M2 + PRO-W1 hardening (422 tests / 718 assertions)        |
| Sprint 14 | #26 | 3 E2E CI-runnable gaps cubiertos (Bun.serve HTTP mocks)             |
| Sprint 15 | #27 | PRO migration readiness — invariante I-13 + Cloud Run scaffolding   |
| —         | #28 | README post-Sprint 15 docs                                          |

### Audit passes

| PR  | Findings cerrados                                                                               |
| --- | ----------------------------------------------------------------------------------------------- |
| #30 | 7 HIGH/MEDIUM (I-11, NaN guards, CI timeouts, subprocess timeout)                               |
| #31 | 6 LOW/NIT (`.pop()!` cleanup, labels I-N, docker worker healthcheck, README, I-9 clarification) |

### Bugs históricos relevantes

| Fecha      | Bug                                                     | Fix                                                                                 |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 2026-04-21 | `cwd` del Stop event contamina tags (`project:jgcalvo`) | Extraer `cwd` del primer JSONL entry vía `aggregateLines()` (I-3)                   |
| 2026-04-20 | langfuse-web `(unhealthy)` falsamente                   | Healthcheck con `$(hostname -i)` — Next.js bindea a IP del contenedor, no localhost |
| 2026-04-22 | LiteLLM gateway `Forbidden` desde dev                   | Reseteo `LITELLM_SALT_KEY` (cambio invalidó keys); documentado como inmutable       |

### Incidente 22-Apr-2026 — pérdida de BD por `docker compose down -v`

**Causa**: agente Claude Code ejecutó `docker compose down -v` sin confirmación explícita,
borrando todos los volúmenes Docker incluyendo `postgres-data` y `clickhouse-data`.

**Datos perdidos**: trazas anteriores a ~9-Apr-2026 (boundary `cleanupPeriodDays: 14`
del PoC — los JSONLs anteriores ya estaban rotados, imposible reconciliar).

**Datos recuperados**: sesiones 9-Apr → 22-Apr-2026 (reconciler vía JSONLs aún en disco).

**Lección formalizada en [ADR-008](./docs/adr/ADR-008-consistency-bounds.md)**:
la 2-layer eventual consistency garantiza RPO ≤ 15min solo si el backup de la BD está
activo. Sin backup, RPO = ∞. La ventana de recuperabilidad real es:

```
ventana_recuperable = min(cleanupPeriodDays × 24h, WINDOW_HOURS)
```

**Mitigaciones activas desde 24-Apr-2026**:

- Systemd timer `atlax-langfuse-backup.timer` — diario 03:00, 7 diarios + 4 semanales
- `cleanupPeriodDays: 90` documentado como prerequisito para devs del piloto
- Restore drill verificado 28-Apr-2026 (Postgres OK, ClickHouse OK)
- PBI #3 pendiente: hook PreToolUse que bloquea `docker compose down -v`

---

## §12 · GAPs Pendientes

### GAP-P01: macOS launchd equivalente

`docs/systemd/` cubre Linux/WSL pero no macOS. Devs Mac configuran cron manual.
**Mitigación**: documentar plist template en `docs/systemd/launchd/`. **Esfuerzo**: 1h.

### GAP-P02: PRO migration Cloud Run

Manifest documentado en `infra/cloud-run.yaml` (REFERENCE ONLY, NOT APPLIED IN CI).
**Status**: PLANNED. **Bloqueante**: decisión de presupuesto Atlax360. Ver [ADR-002](./docs/adr/ADR-002-edge-core-split.md) y `infra/backup-story.md`.

### GAP-P03: Analytics API Anthropic

Datos exactos de cuenta corp vs personal solo accesibles via Analytics API
(Enterprise/API plan). Hoy se infiere de `service_tier: priority`.
**Esfuerzo**: 2-3 días (validar disponibilidad + implementación).

### GAP-P04: Calibración hard budget LiteLLM

Soft budget actual ($50 Orvian / $20 Atalaya / 30d) sin calibración real.
**Mitigación**: ajustar tras 30d de operación. **Esfuerzo**: 1h post-data.

### NO APLICAN (decisiones documentadas)

| GAP                      | Razón                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Partial index `trace_id` | Sin BD local — Langfuse gestiona dedup via `id` upsert ([ADR-003](./docs/adr/ADR-003-langfuse-idempotent.md)) |
| Audit table partitioning | ClickHouse particiona nativo via MergeTree                                                                    |

---

## §13 · Patrones Cross-Proyecto

Patrones extraídos de este proyecto que pueden reusarse en otros proyectos Atlax360.

### P-1 · Cero deps runtime con Bun

**Cuándo aplicar**: hooks plugins de herramientas externas (Claude Code, IDEs)
con timeout estricto. Cualquier latencia de cold-start consume budget.

**Cómo**: Bun ≥1.3 + APIs built-in (`fetch`, `Bun.file`, `crypto.subtle`).
Cero `dependencies` en package.json. Setup vía `setup.sh` que verifica Bun.

**Ver**: [ADR-001](./docs/adr/ADR-001-bun-cero-deps.md).

### P-2 · Degradation log estructurado a stderr

**Cuándo aplicar**: cualquier código en producción donde `console.log` no sea visible
(systemd, cron, hooks). JSON estructurado permite agregar/grep en journalctl.

**Cómo**: helper `emitDegradation(source, err)` en cada `catch`. Esquema fijo
`{ type: "degradation", source, error, ts }`. Nunca silenciar errores.

### P-3 · Eventual consistency 2 capas

**Cuándo aplicar**: sistemas donde la captura síncrona puede fallar (kill -9,
crash, network, batería). Best-effort + cron asíncrono garantizan SSoT.

**Cómo**: capa síncrona con timeout duro + `exit 0` siempre. Capa asíncrona
(cron) escanea estado local vs remoto, computa drift, repara. Idempotencia
en el endpoint remoto es prerrequisito (ver [ADR-003](./docs/adr/ADR-003-langfuse-idempotent.md)).

**Ver**: [ADR-006](./docs/adr/ADR-006-two-layer-consistency.md).

### P-4 · AgentTool + multi-protocol adapters

**Cuándo aplicar**: cuando el mismo "tool" debe exponerse por múltiples
protocolos (MCP, AI SDK, OpenAI function calling).

**Cómo**: registro central (`shared/tools/registry.ts`) con `AgentTool`
definitions. Adapters thin (`mcp-adapter.ts`, `zod-adapter.ts`) traducen al
protocolo destino. Sandbox modes (echo / fixture / degradation) activables
solo via env, nunca via input.

---

## §14 · Áreas de Investigación

### R-1 · Analytics API Anthropic

¿Los datos de overage por seat son accesibles via API? Hoy inferimos por
`service_tier: priority`. Confirmar disponibilidad en plan Enterprise.

### R-2 · ClickHouse Cloud vs self-hosted en GKE

Análisis de coste a ≥50M trazas/año. ClickHouse Cloud cobra por GB ingestado;
self-hosted en GKE requiere ops adicional pero mejor control de coste a escala.

### R-3 · Migración a Langfuse v4

Cuando se publique. Revisar `docker/docker-compose.yml` y migrar.

### R-4 · IDE extensions (VS Code plugin)

Cuarto entrypoint (junto a `cli`, `sdk-ts`, `extension`). Cobertura del 100%
del Claude Code surface area requeriría adaptarlo.

### R-5 · Hard budget LiteLLM con datos reales

Tras 30d de soft budget ($50 Orvian / $20 Atalaya), recalibrar a hard budget
con throttle automático.

---

## Apéndice A · Architectural Truth

Verdades no-negociables del sistema:

| Afirmación                                                              | Invariante | ADR     |
| ----------------------------------------------------------------------- | ---------- | ------- |
| El hook nunca bloquea Claude Code (siempre `exit 0`)                    | I-1        | ADR-006 |
| `traceId = cc-${session_id}` con upsert idempotente                     | I-2        | ADR-003 |
| `cwd` se extrae del primer JSONL entry, no del Stop event               | I-3        | —       |
| Tags Langfuse son UNION en upsert (no replacement)                      | I-4        | ADR-003 |
| Ventana reconciler ≥ 24h por defecto, cap 8760h                         | I-5        | ADR-006 |
| `MODEL_PRICING` única fuente de verdad de pricing                       | I-6        | ADR-001 |
| Tier determinista en `~/.atlax-ai/tier.json`                            | I-7        | ADR-004 |
| Nunca parsear `.credentials.json` — solo existencia                     | I-8        | ADR-004 |
| IDs de generation deterministas (timestamp del turn)                    | I-9        | ADR-003 |
| `MCP_AGENT_TYPE` validado contra allowlist                              | I-10       | ADR-005 |
| `classifyDrift` única fuente en `shared/drift.ts`                       | I-11       | —       |
| Restauración `process.env` per-key en tests                             | I-12       | —       |
| Reconciler/hook/discovery NUNCA migran a Cloud Run                      | I-13       | ADR-002 |
| Paralelismo agéntico: N≤5 read-only, N≤3 write, doble-check obligatorio | I-14       | ADR-011 |

**Límites estructurales externos documentados:**

| Afirmación                                                      | ADR     |
| --------------------------------------------------------------- | ------- |
| Quota seats Anthropic Premium no consultable vía API (post-hoc) | ADR-009 |

---

## Mantenimiento

- **Renombrar módulo en `shared/` o `scripts/`**: actualizar §4 + las tablas que lo referencien
- **Añadir invariante a CLAUDE.md**: añadir fila al Apéndice A + sección §10 (mapeo de tests)
- **Decisión arquitectónica nueva**: nuevo ADR-NNN (no modificar los existentes — son inmutables)
- **Cambio de stack**: actualizar §2 + ADR correspondiente

El test `tests/sdd-invariants.test.ts` (Fase D) verifica que cada I-N tiene
cobertura en este documento. El test `tests/sdd-links.test.ts` verifica que
los paths referenciados existen en disco.
