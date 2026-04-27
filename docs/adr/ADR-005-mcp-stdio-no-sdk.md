# ADR-005 · MCP server stdio implementado sin SDK, JSON-RPC 2.0 a mano

- **Status**: Accepted
- **Date**: 2026-04-12 (retroactiva)
- **Implements**: I-10 (`MCP_AGENT_TYPE` validado contra allowlist)

## Context

> _Sección a completar en Fase C: opciones del SDK MCP de Anthropic, restricción
> de cero deps de ADR-001, complejidad real del protocolo._

El proyecto necesita exponer tools agénticos (`query-langfuse-trace`,
`annotate-observation`) vía Model Context Protocol. El SDK oficial
(`@modelcontextprotocol/sdk`) trae deps adicionales que violan ADR-001
(cero deps prod). Análisis: el protocolo MCP es JSON-RPC 2.0 sobre stdio +
~6 métodos (initialize, tools/list, tools/call, ping, notifications/initialized,
shutdown). Implementarlo a mano es viable.

## Decision

> _Sección a completar en Fase C: detalle de la implementación, adapters,
> sandbox modes._

`scripts/mcp-server.ts` implementa JSON-RPC 2.0 sobre stdin/stdout en ~150 líneas
sin deps. Los tools viven en `shared/tools/` como `AgentTool` definitions, y
adapters thin convierten al formato MCP (`shared/tools/adapters/mcp-adapter.ts`)
o AI SDK Zod (`shared/tools/adapters/zod-adapter.ts`). El registro central
(`shared/tools/registry.ts`) es la SSoT.

`MCP_AGENT_TYPE` se valida contra la allowlist `AGENT_TYPES = ["coordinator",
"trace-analyst", "annotator"]`. Valores fuera de la allowlist degradan a
`coordinator` con warning a stderr — nunca casteo directo.

Sandbox modes (`LANGFUSE_BRIDGE_SANDBOX_MODE`):

- `echo` — devuelve input sin tocar Langfuse (CI)
- `record` — graba interacciones a `~/.atlax-ai/sandbox/`
- (default) — ejecución real

## Consequences

> _Sección a completar en Fase C: qué se gana, qué se pierde, capacidades MCP
> no implementadas._

**Pros**:

- Cero deps prod (ADR-001 cumplido)
- Auditable end-to-end (~150 líneas vs SDK opaco)
- Adapters reutilizan mismo registro entre MCP y AI SDK

**Contras**:

- No implementa methods opcionales del spec MCP (resources, prompts, sampling)
- Mantenimiento manual al evolucionar el spec MCP

**Implementa**: I-10 — allowlist obligatoria, validación explícita.
