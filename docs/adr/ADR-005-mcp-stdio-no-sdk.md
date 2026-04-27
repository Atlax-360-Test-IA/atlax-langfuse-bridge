# ADR-005 · MCP server stdio implementado sin SDK, JSON-RPC 2.0 a mano

- **Status**: Accepted
- **Date**: 2026-04-12 (retroactiva)
- **Implements**: I-10 (`MCP_AGENT_TYPE` validado contra allowlist)
- **Supersedes**: —
- **Superseded by**: —
- **Related**: [ADR-001](./ADR-001-bun-cero-deps.md) (constraint cero deps que motiva esta decisión)

## Context

El proyecto necesita exponer tools agénticos vía Model Context Protocol (MCP)
para que consumers como Claude Desktop, Claude Code subagents, IDE plugins, o
el coordinator de Orvian puedan consultar y anotar traces de Langfuse desde
un prompt.

Tools requeridas:

- `query-langfuse-trace` — lookup por traceId, listado filtrado
- `annotate-observation` — crear scores (NUMERIC/CATEGORICAL/BOOLEAN) sobre traces

### Opciones del SDK MCP

Existen varios SDKs oficiales y comunitarios:

1. **`@modelcontextprotocol/sdk` (oficial Anthropic, npm)**:
   - Pros: API tipada, manejo de notifications, soporte para resources/prompts
   - Contras: ~1.2 MB con deps transitivas (zod, ws, transformación EventSource).
     Viola **ADR-001** (cero deps prod).

2. **`mcp-framework` (comunitario)**:
   - Pros: más ligero (~400 KB)
   - Contras: aún tiene deps. Mantenimiento incierto.

3. **Implementación a mano**:
   - Pros: cero deps, ~150 líneas de código TS, control total
   - Contras: hay que mantenerla al evolucionar el spec MCP

### Análisis de complejidad real del protocolo

El spec MCP (versión `2024-11-05` actual) define:

- **Transport**: JSON-RPC 2.0 sobre stdio (línea por línea, terminada en `\n`)
- **Métodos requeridos**: `initialize`, `tools/list`, `tools/call`
- **Métodos opcionales**: `ping`, `notifications/initialized`, `resources/*`, `prompts/*`, `sampling/*`
- **Error codes**: estándar JSON-RPC (-32700 parse error, -32601 method not found, -32602 invalid params)

Para nuestro caso de uso solo necesitamos: `initialize`, `tools/list`, `tools/call`,
`ping`, `notifications/initialized` (silently ignored). Esto cabe en ~150 líneas.

### Restricción de seguridad: validación estricta de inputs

`MCP_AGENT_TYPE` controla qué tools puede usar el agente conectado. Casteo
directo de env var → `AgentType` es un vector: un valor malicioso podría
escalar permisos.

## Decision

### Implementación stdio sin SDK

`scripts/mcp-server.ts` (~150 líneas) implementa JSON-RPC 2.0 sobre stdin/stdout
sin deps. Estructura:

```typescript
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
};

async function dispatch(req: JsonRpcRequest): Promise<void> {
  // ... switch on method, write response to stdout
}

// Read stdin line by line, parse JSON, dispatch.
```

### Tools como AgentTool definitions

Tools viven en `shared/tools/` como `AgentTool` definitions:

```typescript
type AgentTool<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  inputSchema: JSONSchema; // JSON Schema para introspección
  validate(input: unknown): TInput; // type guard
  allowedAgentTypes: AgentType[]; // RBAC
  tier: ProcessingTier; // deterministic | cached_llm | full_llm
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
};
```

### Adapters multi-protocol

El registro central (`shared/tools/registry.ts`) es la SSoT. Adapters thin
convierten al formato destino:

- `shared/tools/adapters/mcp-adapter.ts` — `AgentTool` → MCP tool definition
- `shared/tools/adapters/zod-adapter.ts` — `AgentTool` → AI SDK Zod tool

Esto permite que el mismo tool se exponga por MCP y por AI SDK sin duplicar
lógica. Si en el futuro se necesita OpenAI function calling u otro protocolo,
se añade un adapter.

### Validación estricta de MCP_AGENT_TYPE (I-10)

```typescript
const VALID_AGENT_TYPES: ReadonlySet<AgentType> = new Set([
  "coordinator",
  "trace-analyst",
  "annotator",
]);

function getAgentType(): AgentType {
  const raw = process.env["MCP_AGENT_TYPE"];
  if (raw && VALID_AGENT_TYPES.has(raw as AgentType)) {
    return raw as AgentType;
  }
  if (raw) {
    process.stderr.write(
      `[mcp-server] unknown MCP_AGENT_TYPE="${raw}", falling back to "coordinator"\n`,
    );
  }
  return "coordinator";
}
```

**Nunca** se castea directamente sin pasar por la allowlist.

### Sandbox modes (testing sin red)

`LANGFUSE_BRIDGE_SANDBOX_MODE` activable solo via env (nunca via input de tool):

| Modo          | Comportamiento                                                                   |
| ------------- | -------------------------------------------------------------------------------- |
| `off`         | Default — ejecución real contra Langfuse                                         |
| `echo`        | Devuelve `{ __sandbox: "echo", input }` — verifica conectividad MCP sin Langfuse |
| `fixture`     | Devuelve respuesta pregrabada via `registerFixture()` — error si no hay fixture  |
| `degradation` | Devuelve `{ __sandbox: "degradation", degradation: [...] }` — testea handling    |

La activación es **solo via env** — los inputs de la tool no exponen el modo.
Esto previene que un integrador active `echo` accidentalmente desde producción.

## Consequences

### Lo que se gana

- **Cero deps prod (ADR-001 cumplido)**: el package.json no añade deps por el MCP server
- **Auditable end-to-end (~150 líneas)**: un dev puede leer el server completo y
  entender cada error code que devuelve
- **Adapters reutilizan mismo registro**: añadir un nuevo protocolo (ej. OpenAI
  function calling) requiere solo un adapter, no reimplementar las tools
- **Validación estricta de MCP_AGENT_TYPE (I-10)**: imposible escalar permisos
  vía env var malformada

### Lo que se pierde / restricciones

- **No implementa methods opcionales del spec MCP**: `resources/*`, `prompts/*`,
  `sampling/*` quedan fuera. Si un consumer lo requiere, hay que extender la
  implementación.
- **Mantenimiento manual al evolucionar el spec**: si Anthropic publica
  versión `2025-XX-XX` con cambios, hay que actualizar a mano. Mitigación: los
  tests `scripts/mcp-server.test.ts` cubren todos los métodos; si el spec
  cambia, los tests fallan inmediatamente.
- **Sin types compartidos con clientes oficiales**: los tipos JSON-RPC son
  re-implementados. Mitigación: tipos minimales y bien documentados.
- **No soporta multi-transport**: solo stdio. Si un consumer requiere HTTP
  (ej. para web-based MCP), hay que añadir Bun.serve handler.

### Implementa I-10

I-10 formaliza la validación contra allowlist. Test:
`scripts/mcp-server.test.ts:43` (`tools/list (I-10)`).

### Decisión consciente: no usar SDK

Si en el futuro Anthropic publica un SDK MCP "lean" sin deps transitivas,
podríamos reconsiderar (nuevo ADR). Mientras tanto, la implementación a mano
es la única que cumple ADR-001.

## References

- Implementation: `scripts/mcp-server.ts`
- Tools registry: `shared/tools/registry.ts`
- Adapters: `shared/tools/adapters/{mcp-adapter,zod-adapter}.ts`
- Tests: `scripts/mcp-server.test.ts`
- MCP spec: https://spec.modelcontextprotocol.io/specification/2024-11-05/
- Sprint PR #9 (MCP server inicial)
