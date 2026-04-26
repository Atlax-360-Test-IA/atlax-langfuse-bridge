# atlax-langfuse-bridge

Torre de control de uso de Claude Code para el equipo Atlax360.

Intercepta el hook `Stop` de Claude Code al final de cada sesión y envía trazas a Langfuse self-hosted. Sin dependencias externas — solo Bun (built-in).

## Qué registra

| Campo              | Fuente                                    | Automático    |
| ------------------ | ----------------------------------------- | ------------- |
| **Developer**      | `git config user.email`                   | ✅ sin config |
| **Proyecto**       | `git remote get-url origin` + `cwd`       | ✅ sin config |
| **Modelos usados** | JSONL `message.model`                     | ✅            |
| **Tokens**         | JSONL `message.usage.*`                   | ✅            |
| **Coste estimado** | tokens × precio modelo                    | ✅            |
| **Billing tier**   | `service_tier` + `CLAUDE_CODE_USE_VERTEX` | ✅            |
| **OS**             | `/proc/version` / `process.platform`      | ✅            |
| **Branch git**     | JSONL `gitBranch`                         | ✅            |
| **Entrypoint**     | JSONL `entrypoint` (`cli`/`sdk-ts`)       | ✅            |

## Cubos de facturación detectados

| Tag Langfuse                         | Cuándo                               |
| ------------------------------------ | ------------------------------------ |
| `billing:anthropic-team-standard`    | Uso normal dentro del plan Team      |
| `billing:anthropic-priority-overage` | `service_tier: "priority"` — overage |
| `billing:vertex-gcp`                 | `CLAUDE_CODE_USE_VERTEX=1` activo    |

## Estructura

```
atlax-langfuse-bridge/
├── docker/
│   ├── docker-compose.yml       # Langfuse v3 + LiteLLM (opt-in)
│   ├── env.example              # Variables requeridas (copiar a .env)
│   └── litellm/
│       └── config.yaml          # Config gateway LiteLLM (Fase 1)
├── hooks/
│   └── langfuse-sync.ts         # Hook Stop (Bun, sin dependencias)
├── scripts/
│   ├── validate-traces.ts       # Smoke test: JSONL local vs Langfuse
│   ├── reconcile-traces.ts      # Cron job: repara traces con drift
│   ├── detect-tier.ts           # Escribe ~/.atlax-ai/tier.json
│   ├── mcp-server.ts            # MCP stdio server (tools agénticas)
│   ├── provision-keys.ts        # Provisiona virtual keys en LiteLLM
│   ├── smoke-mcp-e2e.ts         # Smoke E2E contra Langfuse real
│   └── statusline.sh            # Statusline Claude Code → detect-tier
├── shared/
│   ├── model-pricing.ts         # Fuente única pricing (I-6)
│   ├── aggregate.ts             # Agrega JSONL → ModelUsage
│   ├── degradation.ts           # emitDegradation → stderr JSON
│   ├── hash-cache.ts            # Cache SHA256 con TTL
│   ├── langfuse-client.ts       # Cliente REST Langfuse (getTrace, etc.)
│   ├── processing-tiers.ts      # Taxonomía deterministic/cached_llm/full_llm
│   └── tools/
│       ├── query-langfuse-trace.ts  # AgentTool: buscar traces
│       ├── annotate-observation.ts  # AgentTool: crear scores
│       ├── sandbox.ts               # Ejecución segura de tools
│       ├── registry.ts              # Registro global de tools
│       └── adapters/
│           ├── zod-adapter.ts       # Adapta AgentTool → AI SDK (Zod)
│           └── mcp-adapter.ts       # Adapta AgentTool → MCP tool
├── tests/
│   ├── cross-validation.test.ts # Invariantes entre módulos
│   └── e2e-pipeline.test.ts     # JSONL → batch Langfuse
├── docs/
│   └── systemd/                 # User units Linux/WSL del reconciler
├── setup/
│   ├── setup.sh                 # Installer Linux / macOS / WSL
│   └── setup.ps1                # Installer Windows nativo
├── browser-extension/           # MV3 captura claude.ai → Langfuse
└── README.md
```

## Arquitectura de integridad (2 capas)

```
    ┌────────────────────┐      ┌──────────────────────┐
    │  Capa síncrona     │      │  Capa asíncrona       │
    │  hook Stop         │      │  reconciler cron      │
    │  on session close  │      │  every 15 min         │
    └──────────┬─────────┘      └──────────┬────────────┘
               │ POST /api/public/ingestion│
               ▼                           ▼
               ┌──────────────────────────────────┐
               │  Langfuse (idempotent upsert)    │
               └──────────────────────────────────┘
```

La capa síncrona (hook) captura al cerrar sesión. La capa asíncrona
(reconciler) escanea `~/.claude/projects/**/*.jsonl` recientes, detecta drift
contra Langfuse (`TURNS_DRIFT`, `COST_DRIFT`, `END_DRIFT`, `MISSING`), y
re-ejecuta el hook con un payload Stop sintético. Garantiza eventual
consistency aunque Claude Code crashee, se haga `kill -9`, o la máquina
reinicie antes de que `Stop` se dispare.

Ver `docs/systemd/README.md` para instalación del cron.

## Tier determinista (`~/.atlax-ai/tier.json`)

El statusline escribe el tier de facturación actual. El hook lo lee y lo
añade como tags `tier:seat-team | vertex-gcp | api-direct | unknown` y
`tier-source:oauth | env-vertex | env-api-key | none`. Es la fuente
autoritativa; `billing:*` sigue calculándose por heurística para
retrocompatibilidad con dashboards existentes.

```bash
# Activar statusline (en ~/.claude/settings.json):
{
  "statusLine": {
    "type": "command",
    "command": "/home/you/work/atlax-langfuse-bridge/scripts/statusline.sh"
  }
}
```

---

## 1. Desplegar Langfuse (servidor)

```bash
cd docker

# Generar secretos
cp env.example .env
openssl rand -base64 32   # → NEXTAUTH_SECRET y SALT
openssl rand -hex 32      # → ENCRYPTION_KEY

# Editar .env con los valores generados y configurar NEXTAUTH_URL

docker compose up -d
```

Accede a `http://localhost:3000` (o tu dominio), crea el proyecto **claude-code** y copia las claves `pk-lf-...` / `sk-lf-...` al `.env`. Reinicia con `docker compose restart langfuse-web langfuse-worker`.

---

## 2. Instalar el hook en cada máquina de desarrollo

### Linux / macOS / WSL (1 comando)

```bash
bash setup/setup.sh \
  "https://langfuse.atlax360.com" \
  "pk-lf-XXXX" \
  "sk-lf-XXXX"
```

O sin argumentos (te mostrará qué configurar manualmente):

```bash
bash setup/setup.sh
```

### Windows nativo (PowerShell)

```powershell
.\setup\setup.ps1 `
  -LangfuseHost "https://langfuse.atlax360.com" `
  -PublicKey    "pk-lf-XXXX" `
  -SecretKey    "sk-lf-XXXX"
```

---

## 3. Variables de entorno (por desarrollador)

El setup script las añade automáticamente. Si se hace manual:

```bash
# ~/.zshrc o ~/.bashrc
export LANGFUSE_HOST="https://langfuse.atlax360.com"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
```

No hace falta configurar el nombre del dev — se detecta del `git config user.email`.

---

## 4. Dashboard Langfuse

Una vez activo, en el panel de Langfuse:

- **Traces → filter by userId** → uso por desarrollador
- **Traces → filter by tag `project:*`** → uso por proyecto
- **Traces → filter by tag `billing:*`** → desglose de cubos
- **Users** → resumen por dev (sesiones, coste, modelos)
- **Settings → Models** → define precios por modelo para coste real

### Tags disponibles

```
project:<org/repo>               atlas360/harvest
billing:<tier>                   billing:anthropic-team-standard
tier:<tier>                      tier:seat-team (determinista)
tier-source:<source>             tier-source:oauth | env-vertex | env-api-key
os:<platform>                    os:wsl | os:linux | os:macos | os:windows
entrypoint:<type>                entrypoint:cli | entrypoint:sdk-ts
branch:<git-branch>              branch:feat/sprint-k
infra:<provider>                 infra:anthropic | infra:gcp
```

---

## LiteLLM Gateway (Fase 1 — opt-in)

Para workloads **no-interactivos** (agentes backend, SDK programático, MCP servers de Orvian/Atalaya) se incluye un gateway LiteLLM. El flujo Claude Code CLI de los 38 devs **no cambia** — sigue por OAuth directo a Anthropic.

### Activar el gateway

```bash
cd docker

# 1. Añadir las vars LiteLLM al .env (ver env.example §LiteLLM)
#    ANTHROPIC_API_KEY, LITELLM_MASTER_KEY, LITELLM_SALT_KEY, LITELLM_UI_*

# 2. Generar secretos
echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)"
echo "LITELLM_SALT_KEY=$(openssl rand -hex 32)"

# 3. Arrancar (profile opt-in)
docker compose --profile litellm up -d
```

- **API OpenAI-compatible**: `http://localhost:4001/v1/messages`
- **Admin UI**: `http://localhost:4001/ui` (login con `LITELLM_UI_USERNAME`/`LITELLM_UI_PASSWORD`)
- **BD**: `litellm` en el mismo Postgres (creada automáticamente por `litellm-db-init`)

Sin `--profile litellm`, `docker compose up` arranca sólo el stack Langfuse como antes.

**M2 (activo)**: callback Langfuse habilitado. Toda llamada al gateway genera un trace con tag `source:litellm-gateway`. Verificar con `bun run scripts/smoke-litellm-langfuse.ts`.

### M3: Virtual keys y presupuesto por workload

Cada workload backend tiene su propia virtual key con soft budget, rate limits y metadata propagada a Langfuse.

| Workload | `key_alias`    | Soft budget | Budget | TPM     | RPM |
| -------- | -------------- | ----------- | ------ | ------- | --- |
| Orvian   | `orvian-prod`  | $50         | 30d    | 200.000 | 100 |
| Atalaya  | `atalaya-prod` | $20         | 30d    | 100.000 | 50  |

Los MCP servers usan la key del workload padre (`orvian-prod` para MCP de Orvian).

#### Provisionar keys (idempotente)

Requiere el gateway corriendo (`docker compose --profile litellm up -d`):

```bash
# Preview sin crear keys
DRY_RUN=1 bun run scripts/provision-keys.ts

# Crear keys
bun run scripts/provision-keys.ts
# → Keys guardadas en ~/.atlax-ai/virtual-keys.json
```

Re-ejecutar es seguro — los aliases ya existentes se saltan sin modificar.

#### Usar una virtual key

```bash
ORVIAN_KEY=$(jq -r '.keys[] | select(.key_alias=="orvian-prod") | .key' \
  ~/.atlax-ai/virtual-keys.json)

curl http://localhost:4001/v1/chat/completions \
  -H "Authorization: Bearer $ORVIAN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hola"}]}'
```

#### Trazas en Langfuse

LiteLLM propaga el `metadata` de la key a cada trace. Para filtrar por workload en Langfuse:
**Traces → metadata → `workload = orvian`** (o `atalaya`).

> El `metadata.workload` llega como campo del trace, no como tag. Los tags globales
> `source:litellm-gateway` e `infra:anthropic` siguen funcionando (I-4: UNION en upsert).

#### Alertas de presupuesto

LiteLLM alerta cuando el spend de una key supera el `soft_budget`. Configura
`LITELLM_ALERT_WEBHOOK_URL` en `.env` para recibir notificaciones vía Slack
(o cualquier endpoint HTTP POST Slack-compatible: n8n, Make, etc.).

Sin webhook, los warnings aparecen en los logs:

```bash
docker compose --profile litellm logs litellm | grep -i budget
```

#### Rotación de claves

```bash
OLD_KEY=$(jq -r '.keys[] | select(.key_alias=="orvian-prod") | .key' \
  ~/.atlax-ai/virtual-keys.json)

# Revocar
curl -X POST http://localhost:4001/key/delete \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"keys\": [\"$OLD_KEY\"]}"

# Re-provisionar (mismo alias, nueva key)
bun run scripts/provision-keys.ts
```

> **ADVERTENCIA**: `LITELLM_SALT_KEY` es inmutable. Cambiarla invalida TODAS las
> virtual keys. Solo rotar si se compromete el sistema completo.

---

## MCP server — tools agénticos sobre el bridge

`scripts/mcp-server.ts` expone los `AgentTool`s del registry como un MCP server stdio. Permite que un agente (Claude Code subagents, Claude Desktop, IDE plugins, Atalaya coordinator) consulte y anote traces de Langfuse desde un prompt.

### Tools disponibles

| Tool                   | Tier         | Cacheable | Para qué                                                                   |
| ---------------------- | ------------ | --------- | -------------------------------------------------------------------------- |
| `query-langfuse-trace` | `cached_llm` | ✅        | Lookup por traceId o listado filtrado (userId, tags, timeRange).           |
| `annotate-observation` | `full_llm`   | ❌        | Postear scores (NUMERIC/CATEGORICAL/BOOLEAN) sobre un trace u observation. |

Cero deps runtime — protocolo JSON-RPC 2.0 implementado a mano.

### Arrancar el server

```bash
# Producción — el cliente MCP lanza el proceso
LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… bun run scripts/mcp-server.ts

# Modo sandbox (no toca Langfuse) — útil para validar integración
LANGFUSE_BRIDGE_SANDBOX_MODE=echo bun run scripts/mcp-server.ts
```

### Variables de entorno

| Variable                       | Default              | Uso                                                                  |
| ------------------------------ | -------------------- | -------------------------------------------------------------------- |
| `LANGFUSE_HOST`                | `cloud.langfuse.com` | Endpoint Langfuse (typically `http://localhost:3000` en local).      |
| `LANGFUSE_PUBLIC_KEY`          | —                    | `pk-lf-…` del proyecto.                                              |
| `LANGFUSE_SECRET_KEY`          | —                    | `sk-lf-…` del proyecto.                                              |
| `MCP_AGENT_TYPE`               | `coordinator`        | `coordinator` (todas) \| `trace-analyst` (read-only) \| `annotator`. |
| `MCP_STEP_BUDGET_MS`           | `10000`              | Budget por tool call que recibe el `ToolContext`.                    |
| `LANGFUSE_BRIDGE_SANDBOX_MODE` | `off`                | `off` \| `echo` \| `fixture` \| `degradation`.                       |

### Configurar Claude Desktop

Añadir a `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "atlax-langfuse-bridge": {
      "command": "bun",
      "args": ["run", "/path/to/atlax-langfuse-bridge/scripts/mcp-server.ts"],
      "env": {
        "LANGFUSE_HOST": "http://localhost:3000",
        "LANGFUSE_PUBLIC_KEY": "pk-lf-…",
        "LANGFUSE_SECRET_KEY": "sk-lf-…",
        "MCP_AGENT_TYPE": "coordinator"
      }
    }
  }
}
```

Reiniciar Claude Desktop. En cualquier conversación, las tools `query-langfuse-trace` y `annotate-observation` quedan disponibles para el modelo.

### Smoke E2E

`scripts/smoke-mcp-e2e.ts` ejercita el flujo completo (inject → query → cache hit → list by tag → annotate × 2 → round-trip) contra Langfuse real. Skip claro si las credenciales no están en el entorno o Langfuse no responde.

```bash
bun run scripts/smoke-mcp-e2e.ts
```

Salida esperada con stack arriba:

```
[smoke-mcp] ✓ trace injected via /api/public/ingestion
[smoke-mcp] ✓ trace visible in Langfuse (post-worker ingestion)
[smoke-mcp] ✓ query-langfuse-trace lookup OK
[smoke-mcp] ✓ cache hit confirmed (fromCache=true)
[smoke-mcp] ✓ list by tag smoke-mcp-run:… returned the trace
[smoke-mcp] ✓ annotate NUMERIC OK (scoreId=…)
[smoke-mcp] ✓ annotate CATEGORICAL OK (scoreId=…)
[smoke-mcp] ✓ round-trip: both scores visible in trace.scores[]
[smoke-mcp] ✅ all checks passed
```

### Sandbox modes (testing sin red)

| Modo          | Comportamiento                                                                          |
| ------------- | --------------------------------------------------------------------------------------- |
| `off`         | Default — ejecución real contra Langfuse.                                               |
| `echo`        | Devuelve `{ __sandbox: "echo", input }` — verifica conectividad MCP sin tocar Langfuse. |
| `fixture`     | Devuelve respuesta pregrabada via `registerFixture()` — error si no hay fixture.        |
| `degradation` | Devuelve `{ __sandbox: "degradation", degradation: [...] }` — testea handling de gaps.  |

La activación es **solo via env** — los inputs de la tool no exponen el modo, así que un integrador no puede activarlo accidentalmente desde producción.

### Adapter para AI SDK v6

Si el consumer usa `ai` SDK (no MCP), `shared/tools/adapters/zod-adapter.ts` mapea `AgentTool` → forma `tool({...})`:

```ts
import { listToolsForAgent } from "atlax-langfuse-bridge/shared/tools/registry";
import { buildAiSdkToolset } from "atlax-langfuse-bridge/shared/tools/adapters/zod-adapter";

const toolset = await buildAiSdkToolset(
  listToolsForAgent("coordinator"),
  { agentType: "coordinator", stepBudgetMs: 10_000 },
);

const result = await generateText({ model, tools: toolset, ... });
```

Zod se carga via dynamic import — el bridge mantiene cero deps runtime, el consumer ya tendrá `zod` en su `package.json`.

### Troubleshooting

| Síntoma                                              | Diagnóstico / fix                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Tool not found or not authorized` en `tools/call`   | El `MCP_AGENT_TYPE` no tiene autorización para esa tool. Cambia a `coordinator` o revisa `allowedAgentTypes` en el módulo de la tool. |
| `Langfuse unreachable at …` en smoke E2E             | Stack docker no está arriba. `docker compose ps` para verificar.                                                                      |
| `trace not visible after 30s` en smoke               | Worker Langfuse caído. `docker compose logs langfuse-worker \| tail -50`.                                                             |
| El server no aparece en Claude Desktop               | Path absoluto a `mcp-server.ts` correcto en el config; reiniciar la app.                                                              |
| Score creado pero no aparece en `scores[]` del trace | Latencia del worker (ingestion async). Esperar 5–10s y reintentar.                                                                    |

---

## Browser extension — claude.ai + Claude Desktop App

`browser-extension/` es una extensión Manifest V3 que captura la actividad
de **claude.ai (chat / projects)** y de **Claude Desktop App (Electron)**.
La cobertura es complementaria al hook CLI: misma instancia Langfuse, traces
con prefijo `claude-web-*` (vs `cc-*` del CLI) y tag `entrypoint:claude-ai`.

### Arquitectura

- **`content-main.js`** (MAIN world, `document_start`) — sobreescribe
  `window.fetch` antes de que la página cargue su JS. Intercepta SSE de
  `/api/.../chat_conversations/<uuid>/completion`, parsea
  `message_start` / `message_delta` / `message_stop` y emite un CustomEvent
  por turno. Cuerpo de la respuesta clonado: la página ve el original.
- **`content-isolated.js`** (ISOLATED world) — bridge a `chrome.runtime`
  porque MAIN world no puede llamar al service worker directamente.
- **`background.js`** (service worker, ESM) — recibe los eventos, calcula
  coste vía `pricing.js` (espejo de `shared/model-pricing.ts`, cross-validado
  por test) y hace `POST /api/public/ingestion`. Errores se persisten en
  `chrome.storage.local` con `degradationLog` (rolling buffer 50 entradas).
- **`popup.html` + `popup.js`** — configuración de host/public/secret keys,
  con verificación de conectividad contra `/api/public/health`.

### Tagging

| Tag                             | Valor                                         |
| ------------------------------- | --------------------------------------------- |
| `surface:chat \| projects`      | Detectado por URL (`/chats/` vs `/projects/`) |
| `platform:browser \| app`       | UA Electron → `app`, resto → `browser`        |
| `tier:claude-web \| claude-app` | Derivado de `platform`                        |
| `tier-source:browser-extension` | Fuente fija (no se mezcla con tier del CLI)   |
| `entrypoint:claude-ai`          | Distingue de `entrypoint:cli` del hook        |

### Instalación (modo desarrollador)

```
1. chrome://extensions → activar "Modo desarrollador"
2. "Cargar descomprimida" → seleccionar la carpeta browser-extension/
3. Click en el icono → introducir Langfuse host + public/secret keys
4. "Guardar y verificar" → debe mostrar "Conectado — Langfuse <version>"
```

### Diagnóstico

Para ver entradas de degradación (errores de red, ingestión, storage):

```js
// En la consola del service worker (chrome://extensions → "Inspeccionar vistas: service worker")
chrome.storage.local
  .get("degradationLog")
  .then((r) => console.table(r.degradationLog));
```

---

## Limitaciones conocidas

| Objetivo                            | Estado                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| Claude Code CLI                     | ✅ Cubierto (hook Stop + reconciler)                              |
| claude.ai (chat/projects)           | ✅ Cubierto vía `browser-extension/` (MV3, intercepta SSE)        |
| Claude Desktop App (Electron)       | ✅ Cubierto vía la misma extension (UA Electron → `platform:app`) |
| IDE extensions (VS Code)            | ⚠️ Parcial — solo si lanzan Claude Code via CLI                   |
| Cuenta corp vs personal             | ❌ Requiere Analytics API (solo Enterprise/API plan)              |
| Team subscription vs overage exacto | ⚠️ `service_tier: priority` es indicador, no garantía             |

---

## Actualizar el hook

```bash
# Pull del repo y reinstalar
git pull
bash setup/setup.sh   # sobreescribe ~/.claude/hooks/langfuse-sync.ts
```

---

## Operación

### Validar integridad manualmente

```bash
# Últimas 24h
bun run scripts/validate-traces.ts

# Ventana específica
WINDOW_HOURS=72 bun run scripts/validate-traces.ts

# Sesiones concretas
bun run scripts/validate-traces.ts path/to/session.jsonl [...]
```

Exit code `1` si hay drift (útil en CI). Requiere `LANGFUSE_*` en el entorno.

### Reparar drift detectado

```bash
# Dry run (solo detecta)
DRY_RUN=1 bun run scripts/reconcile-traces.ts

# Reparación real
bun run scripts/reconcile-traces.ts

# Excluir sesión actual (la que aún no ha cerrado)
EXCLUDE_SESSION=<sid> bun run scripts/reconcile-traces.ts
```

El reconciler loguea en JSON a stdout (journalctl-friendly). Para automatizar:
`docs/systemd/` trae units para Linux/WSL.

### Forzar redetección de tier

```bash
bun run scripts/detect-tier.ts
cat ~/.atlax-ai/tier.json
```
