# Glosario de Términos · atlax-langfuse-bridge

> Naming canónico para evitar drift cross-doc. Si grep para encontrar un concepto
> no devuelve resultados, mira aquí primero antes de inventar un alias.

## Componentes principales

| Término canónico        | Alias aceptables (refactor lentamente) | Definición                                                                              |
| ----------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| **Hook Stop**           | "langfuse-sync hook", "Stop hook"      | Script síncrono `hooks/langfuse-sync.ts` que corre en el evento Stop de Claude Code     |
| **Reconciler**          | "reconciler cron"                      | Script asíncrono `scripts/reconcile-traces.ts` ejecutado por systemd/launchd cada 15min |
| **MCP server**          | "mcp-server"                           | Script `scripts/mcp-server.ts` que expone tools agénticas vía JSON-RPC 2.0 sobre stdio  |
| **Bridge health trace** | "bridge-health"                        | Trace day-scoped emitido al final de cada scan del reconciler                           |
| **Stack Langfuse v3**   | "stack PRO", "Langfuse self-hosted"    | Web + Worker + Postgres + ClickHouse + Redis + GCS en Cloud Run europe-west1            |
| **LiteLLM Gateway**     | "gateway", "litellm gateway"           | Proxy OpenAI-compatible sobre Anthropic/Vertex, instancia Cloud Run separada            |

## Tipos de identidad

| Término        | Definición                                                                     |
| -------------- | ------------------------------------------------------------------------------ |
| **dev**        | Developer que ejecuta Claude Code en su máquina (38 totales, 13 en piloto)     |
| **session_id** | UUID derivado del JSONL filename de Claude Code (`~/.claude/projects/*.jsonl`) |
| **traceId**    | `cc-${session_id}` — identificador de trace en Langfuse (I-2 idempotencia)     |
| **tier**       | Canal de facturación del dev: seat-team, api-key, vertex, etc. (I-7 tier.json) |

## Convenciones de naming en GCP

Patrón canónico: `atlax360-ai-<purpose>-<env>` donde `<env>` ∈ {`dev`, `pre`, `pro`}.
Detalles en `CLAUDE.md §Convención de naming GCP`.

## Conceptos del SDD

| Término         | Definición                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **Edge**        | Componentes que viven en la máquina del dev (hook, reconciler). Nunca van a Cloud Run (I-13).  |
| **Core**        | Componentes que viven en Cloud Run + GCE: Langfuse v3, LiteLLM Gateway                         |
| **Drift**       | Divergencia entre lo que el JSONL local dice y lo que Langfuse reporta (MISSING/TURNS/COST/OK) |
| **Degradation** | Entrada estructurada JSON a stderr cuando el hook/reconciler falla pero exit 0 (I-1)           |
| **SAFE_SID_RE** | Regex `/^[0-9a-zA-Z_-]{1,128}$/` para validar IDs antes de propagar (I-15)                     |
