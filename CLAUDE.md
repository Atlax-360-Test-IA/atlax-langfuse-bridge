# CLAUDE.md — atlax-langfuse-bridge

Project-specific rules for Claude Code when working on this repo. Extends the
global `~/.claude/CLAUDE.md`.

> 📖 **Arquitectura completa**: ver [`ARCHITECTURE.md`](./ARCHITECTURE.md) — SDD §1-§14.
> 🛠️ **Operación día-a-día**: ver [`docs/operations/runbook.md`](./docs/operations/runbook.md).
> 📋 **Decisiones formales**: ver [`docs/adr/`](./docs/adr/) (ADR-001..ADR-012).
> 📜 **Cambios**: ver [`CHANGELOG.md`](./CHANGELOG.md).

Este archivo solo contiene **instrucciones operativas para Claude Code en
sesión** (invariantes, comandos rápidos, anti-patterns). Todo lo arquitectónico
vive en `ARCHITECTURE.md`.

## What this project is

Torre de observabilidad FinOps para el uso de Claude Code en Atlax360. Tres
piezas coordinadas:

1. **Hook `Stop`** (`hooks/langfuse-sync.ts`) — síncrono, corre al cerrar
   sesión, agrega usage del JSONL y lo envía a Langfuse vía ingestion API.
2. **Reconciler cron** (`scripts/reconcile-traces.ts`) — asíncrono, corre
   cada 15 min vía systemd/launchd, detecta drift y re-ejecuta el hook.
3. **Stack Langfuse v3 self-hosted** (`docker/`) — destino de todas las trazas.

## Categoría Shared Platform — `edge-tooling` + `server-only`

Este proyecto pertenece a dos categorías del patrón Atlax 360 AI Suite Shared
Platform (ver `~/work/kairos/docs/atlax-ai-shared-platform.md` v0.3 §3.1):

- **`edge-tooling`**: hook + reconciler + scripts viven en la laptop del dev,
  sin servidor HTTP permanente. Invariantes que NO aplican: `getAuthContext`,
  CORS, CSP, `/api/health`, OAuth Google, Workload Identity Federation. Sí
  aplican: logs JSON estructurados, `AbortSignal.timeout()`, retry+backoff. Ver
  invariante I-13 (edge/core split). Esta parte NUNCA migra a Cloud Run.
- **`server-only`**: el stack Langfuse v3 (web + worker + Postgres + ClickHouse +
  Redis + GCS) es el componente que sí va a Cloud Run + GCE en GCP. Este sí
  consume la Capa 1 del Shared Platform (proyecto GCP propio, secretos en
  Secret Manager, logs a Cloud Logging).

Validación completa: [`docs/audits/shared-platform-validation-2026-05-09.md`](./docs/audits/shared-platform-validation-2026-05-09.md).

## Convención de naming GCP

Todos los proyectos GCP de Atlax 360 AI Suite siguen el patrón:

```
atlax360-ai-<purpose>-<env>
```

Donde `<purpose>` es el producto y `<env>` ∈ {`dev`, `pre`, `pro`}. Display
name canónico: `Atlax 360 · AI · <Purpose> · <ENV>` (con `·` como separador).

Pre-reservado para la suite:

| Project ID                            | Display name                       | Categoría     |
| ------------------------------------- | ---------------------------------- | ------------- |
| `atlax360-ai-platform-{dev,pre,pro}`  | Atlax 360 · AI · Platform · {ENV}  | Capa 1 shared |
| `atlax360-ai-langfuse-pro`            | Atlax 360 · AI · Langfuse · PRO    | server-only   |
| `atlax360-ai-kairos-{dev,pre,pro}`    | Atlax 360 · AI · Kairos · {ENV}    | web-app       |
| `atlax360-ai-dashboard-{dev,pre,pro}` | Atlax 360 · AI · Dashboard · {ENV} | web-app       |
| `atlax360-ai-harvest-{dev,pre,pro}`   | Atlax 360 · AI · Harvest · {ENV}   | híbrido       |

**Por qué este naming**: separa narrativamente la subfamilia AI Suite del
resto del portafolio Atlax 360, manteniendo coherencia con el dominio canónico
`atlax360.ai` (D-009 v0.3). GCP IDs no admiten `.`, por eso el dominio
literal no se replica en el ID; el display name aporta el `·` visual.

Buckets GCS y otros recursos siguen `atlax360-ai-<purpose>-<resource>` (ej.
`atlax360-ai-langfuse-events`, `atlax360-ai-langfuse-clickhouse-backups`).

Decisión formal: pendiente ADR en `atlax-platform` (sesión arranque del repo
shared) — hasta entonces este CLAUDE.md es la fuente de verdad.

## Invariantes no negociables

> Estos invariantes son las reglas de comportamiento que Claude Code debe
> respetar al editar este repo. Cada uno tiene cobertura de test (ver
> [`ARCHITECTURE.md §10`](./ARCHITECTURE.md#§10--testing) para el mapeo).

### I-1 · Hook siempre `exit 0`

El hook NUNCA bloquea Claude Code. Cualquier error se escribe a stderr y
termina con `process.exit(0)`. Romper esto degrada UX de 38 devs.

### I-2 · Idempotencia por traceId

`traceId = cc-${session_id}`. Langfuse hace upsert por ID. El reconciler
depende de esto: re-ejecutar el hook sobre una sesión ya sincronizada NO
debe crear duplicados, solo actualizar turns/cost/timestamps.

### I-3 · cwd del primer JSONL entry, nunca del evento Stop

El payload Stop trae un `cwd` que a veces no coincide con dónde arrancó la
sesión (happy wrapper, subshells, etc.). Esto contamina tags de proyecto.
**Regla**: `sessionCwd = primer entry con .cwd` (fallback al Stop event).
Implementado vía `aggregateLines()` en `shared/aggregate.ts` — el campo `cwd`
se extrae en el primer pass del JSONL. Previamente produjo tags ruidosos
(`project:jgcalvo` en vez de `project:owner/repo`).

### I-4 · Tags son UNION en upsert (no replacement)

Langfuse hace UNION de tags al upsertar un trace existente. Si corriges un
bug que genera un tag malo, los traces históricos retienen AMBOS tags. No
hay PATCH/DELETE de tags vía API pública (devuelve 405). Sólo UI o
`ALTER TABLE` en ClickHouse.

### I-5 · Ventana de reparación ≥ 24h

El reconciler usa `WINDOW_HOURS=24` por defecto. Si una sesión dura >24h,
AMPLIAR la variable en `~/.atlax-ai/reconcile.env` (típicamente a 72h o
168h). No bajar de 24h — pierdes sesiones de fin de semana.

### I-6 · Modelo de pricing central

`MODEL_PRICING` vive en `shared/model-pricing.ts`. Es la **única fuente de
verdad** para costes estimados — todos los consumidores importan de ahí.
Cuando Anthropic ajusta precios, cambiar únicamente `shared/model-pricing.ts`.
No duplicar el objeto en ningún otro fichero del repo.

### I-7 · Tier determinista en `~/.atlax-ai/tier.json`

Escrito por `scripts/detect-tier.ts` vía statusline. Leído por el hook. El
billing heurístico (`billing:*`) se mantiene por retrocompatibilidad pero
la fuente autoritativa son los tags `tier:*` y `tier-source:*`.

### I-8 · Nunca parsear `~/.claude/.credentials.json`

`detect-tier.ts` puede comprobar la **existencia** del archivo (para inferir
tier `seat-team` en OAuth) pero NUNCA parsea su contenido ni extrae email.
El motivo: el archivo contiene tokens de sesión Anthropic. `account` queda
`null` en tier.json cuando la fuente es OAuth — esto es intencional.

### I-9 · Generación IDs deterministas — usar timestamp del turn, no Date.now()

**Aplica si el bridge genera IDs para events/observations de Langfuse.**
Actualmente el bridge no genera esos IDs (vienen del LLM upstream via JSONL).
Esta regla es un guard para código futuro que sí los genere.

Si se añade generación de IDs propios: usar `turn.timestamp` (del JSONL), nunca
`Date.now()` ni `new Date().toISOString()`. `Date.now()` produce un ID diferente
en cada re-ejecución, rompiendo la deduplicación por `id` en Langfuse (I-2).

### I-10 · MCP_AGENT_TYPE validado contra allowlist

El env var `MCP_AGENT_TYPE` acepta solo los valores definidos en `AgentType`:
`"coordinator" | "trace-analyst" | "annotator"`. Un valor desconocido loguea
un warning a stderr y usa `"coordinator"` como fallback. No castear a
`AgentType` sin validación previa.

### I-11 · classifyDrift vive en shared/drift.ts (única fuente de verdad)

La función `classifyDrift()` y el tipo `DriftStatus` viven en
`shared/drift.ts`. No duplicar la lógica en scripts o tests. El reconciler
importa desde ahí, los tests también.

### I-12 · process.env restore en tests: guardar/restaurar keys específicas

No usar `process.env = { ...origEnv }` para restaurar env en tests — asignar
al proxy `process.env` puede no funcionar correctamente. Patrón correcto:

```typescript
const saved = process.env["MY_VAR"];
afterEach(() => {
  if (saved !== undefined) process.env["MY_VAR"] = saved;
  else delete process.env["MY_VAR"];
});
```

### I-13 · El reconciler y el hook NUNCA migran a Cloud Run

El reconciler (`scripts/reconcile-traces.ts`), el hook (`hooks/langfuse-sync.ts`)
y los scripts de descubrimiento (`shared/jsonl-discovery.ts`, `shared/env-loader.ts`)
**dependen del filesystem local del developer** y por diseño se quedan en la
máquina del dev — nunca van a Cloud Run.

**Cómo aplicar**: si una función toca `os.homedir()`, `~/.atlax-ai`,
`~/.claude/projects` o `execSync("git ...")`, está en el lado "edge" del
sistema y se queda local. Esto se valida en `tests/cloud-run-boundary.test.ts`.

Razones detalladas y target topology PRO en [ADR-002](./docs/adr/ADR-002-edge-core-split.md).

### I-14 · Límites operativos del paralelismo agéntico

Formalizado a partir del experimento del 2026-05-07
(`docs/experiments/2026-05-07-parallel-subagent-experiment.md`).

**Reglas:**

- **N≤5 agentes read-only** por tanda. Si se necesitan más, dividir en dos tandas con síntesis intermedia.
- **N≤3 agentes write** simultáneos, solo con archivos completamente disjuntos.
- **Doble-check obligatorio**: verificar toda sugerencia de código de subagente contra la fuente primaria (docs oficiales, spec, código existente) antes de aplicar. Sin doble-check, no aceptar output de subagente en `shared/` ni contratos de API.
- **Nunca dos agentes en el mismo archivo**: race condition garantizada → secuencial obligatorio.
- **Síntesis siempre en el orquestador**: los subagentes devuelven resultados, el orquestador decide.

**Blast Radius Matrix por sprint** (aplicar antes de paralelizar):

- **LOW**: archivos completamente disjuntos → paralelo sin restricciones
- **MEDIUM**: comparten módulo `shared/` o fichero de config → máx. N=2, revisión humana
- **HIGH**: mismo archivo o contrato de API → secuencial obligatorio

**Por qué**: el experimento mostró speedup real de 2-4× con N≤5, pero un subagente
(A4) sugirió un schema incorrecto que el orquestador detectó mediante doble-check.
Sin esa verificación, la regresión hubiera llegado a producción.

**Código de referencia**: `docs/experiments/2026-05-07-parallel-subagent-experiment.md`
**Scope**: `all` (aplica a todos los proyectos Atlax con desarrollo centaur)

Ver [ADR-011](./docs/adr/ADR-011-parallel-subagent-limits.md) para decisión formal y contexto completo.

## Comandos de operación

```bash
# Validar integridad contra Langfuse
bun run scripts/validate-traces.ts

# Detectar drift y reparar
bun run scripts/reconcile-traces.ts

# Estado del cron
systemctl --user status atlax-langfuse-reconcile.timer
journalctl --user -u atlax-langfuse-reconcile.service -n 50

# Actualizar tier manualmente
bun run scripts/detect-tier.ts

# Tests + typecheck
bun run check
```

Más comandos y diagnóstico en [`docs/operations/runbook.md`](./docs/operations/runbook.md).

## Anti-patterns a evitar

- **No añadir dependencias npm al hook**: aumenta latencia de cierre de
  sesión y riesgo de supply chain. Todo con APIs built-in de Bun/Node. Ver
  [ADR-001](./docs/adr/ADR-001-bun-cero-deps.md).
- **No usar `console.log` en el hook**: stdout puede interferir con otros
  hooks downstream. Usar `process.stderr.write()` para errores estructurados (degradation log JSON).
- **No hacer retries síncronos en el hook**: timeout es 10s duro. Si falla,
  el reconciler lo recoge en la siguiente ventana. Ver [ADR-006](./docs/adr/ADR-006-two-layer-consistency.md).
- **No leer el JSONL en streaming**: `readFileSync` + `split("\n")` es más
  rápido para tamaños típicos (<50MB) y más simple que streaming.
- **No editar ADRs existentes**: son inmutables. Si una decisión cambia, crear
  ADR nuevo con `Status: Supersedes ADR-NNN` y marcar el viejo como `Superseded`.

## Convenciones específicas (post-auditoría 360º 2026-05-08)

Estas reglas surgen del audit de `~/.claude/projects/.../memory/project_audit_2026-05-08.md` y son específicas de la arquitectura de este bridge. Las reglas globales viven en `~/.claude/rules/security.md` y `~/.claude/rules/testing.md`.

- **Backfill scripts inyectan `_invokedByReconciler:true` + `LANGFUSE_FORCE_NOW_TIMESTAMP=1`**. Sin ellos, ClickHouse `ReplacingMergeTree` (keyed por `event_ts`) puede sobrescribir traces buenos con valores históricos al reprocesar. El reconciler en línea ya lo hace; cualquier nuevo script de re-emisión también debe hacerlo. Patrón en `scripts/backfill-historical-traces.ts:replayHook()`.
- **`SAFE_SID_RE` se importa desde `shared/validation.ts`, nunca se redefine localmente**. Bound de longitud `{1,128}` obligatorio. Cualquier path/ID derivado de filename de JSONL pasa por este regex antes de uso.
- **`safeFilePath()` para `transcript_path` en hook + cualquier path de fuente externa**. Confinamiento a `~/.claude/projects/` por defecto. Override `ATLAX_TRANSCRIPT_ROOT_OVERRIDE` reservado SOLO para tests.
- **Comentarios `// I-N` en código que implementa invariante** (trazabilidad). El test `tests/sdd-invariants.test.ts` verifica que cada I-N aparece en `ARCHITECTURE.md`; el patrón de comentar en código es complementario para que `grep "// I-N"` resuelva a la implementación.

## Mantenimiento del SDD

Cuando hagas cambios en el código que toquen al SDD:

- **Renombrar módulo en `shared/` o `scripts/`**: actualizar `ARCHITECTURE.md §4` y las tablas que lo referencien
- **Añadir nuevo invariante a este `CLAUDE.md`**: añadir fila al `ARCHITECTURE.md §10` (mapeo I-N → test) + Apéndice A
- **Cambio de stack runtime**: actualizar `ARCHITECTURE.md §2` + ADR correspondiente (nuevo, no editar viejo)
- **Nuevo módulo `shared/`**: actualizar tabla en `ARCHITECTURE.md §4`
- **Cambio en CI/CD workflow**: actualizar `ARCHITECTURE.md §6`

El test `tests/sdd-invariants.test.ts` verifica que cada I-N tiene cobertura
en `ARCHITECTURE.md`. El test `tests/sdd-links.test.ts` verifica que los paths
de código referenciados en el SDD existen en disco.
