# atlax-langfuse-bridge

Torre de control FinOps de Claude Code para Atlax360. Captura cada sesión vía
hook `Stop`, agrega tokens y coste, y emite trazas a Langfuse self-hosted.

**Cero dependencias en producción** — solo Bun (built-in).

> 📖 **Arquitectura completa**: ver [`ARCHITECTURE.md`](./ARCHITECTURE.md).
> 🛠️ **Operación día-a-día**: ver [`docs/operations/runbook.md`](./docs/operations/runbook.md).
> 📋 **Decisiones**: ver [`docs/adr/`](./docs/adr/).
> 📜 **Changelog**: ver [`CHANGELOG.md`](./CHANGELOG.md).

**Versión actual**: v0.5.4 · 466 tests / 814 expects / 0 fallos

---

## Quick Start (3 pasos)

### 1. Levantar Langfuse (servidor)

```bash
cd docker

cp env.example .env
openssl rand -base64 32   # → NEXTAUTH_SECRET y SALT en .env
openssl rand -hex 32      # → ENCRYPTION_KEY en .env
# Editar .env con NEXTAUTH_URL del dominio

docker compose up -d
```

Acceder a `http://localhost:3000`, crear el proyecto **claude-code** y copiar
las claves `pk-lf-...` / `sk-lf-...` al `.env`. Reiniciar:
`docker compose restart langfuse-web langfuse-worker`.

### 2. Instalar el hook en cada máquina dev

**Linux / macOS / WSL** (un comando):

```bash
bash setup/setup.sh \
  "https://langfuse.atlax360.com" \
  "pk-lf-XXXX" \
  "sk-lf-XXXX"
```

Sin argumentos te muestra qué configurar manualmente:

```bash
bash setup/setup.sh
```

**Windows nativo** (PowerShell):

```powershell
.\setup\setup.ps1 `
  -LangfuseHost "https://langfuse.atlax360.com" `
  -PublicKey    "pk-lf-XXXX" `
  -SecretKey    "sk-lf-XXXX"
```

### 3. Variables de entorno (automatizadas por setup)

```bash
# ~/.zshrc o ~/.bashrc — el setup script las añade automáticamente
export LANGFUSE_HOST="https://langfuse.atlax360.com"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
```

> Sin configuración del nombre del dev — se detecta del `git config user.email`.

Listo. La siguiente sesión Claude Code emite traza al cerrar.

---

## Qué se registra automáticamente

| Campo                 | Fuente                                             |
| --------------------- | -------------------------------------------------- |
| **Developer**         | `git config user.email`                            |
| **Proyecto**          | `git remote get-url origin` + `cwd`                |
| **Modelos usados**    | JSONL `message.model`                              |
| **Tokens**            | JSONL `message.usage.*`                            |
| **Coste estimado**    | tokens × precio modelo (`shared/model-pricing.ts`) |
| **Billing tier**      | `service_tier` + `CLAUDE_CODE_USE_VERTEX`          |
| **Tier determinista** | `~/.atlax-ai/tier.json` (autoritativo)             |
| **OS**                | `/proc/version` / `process.platform`               |
| **Branch git**        | JSONL `gitBranch`                                  |
| **Entrypoint**        | JSONL `entrypoint` (`cli`/`sdk-ts`)                |

Ver [`ARCHITECTURE.md §8`](./ARCHITECTURE.md#§8--observabilidad) para la lista
completa de tags.

---

## Cron del reconciler (opcional pero recomendado)

El hook puede no ejecutar (kill -9, crash, reboot). El reconciler escanea
recientes y repara. Setup en Linux/WSL:

```bash
# Ver docs/systemd/README.md para detalles
cp docs/systemd/atlax-langfuse-reconcile.service ~/.config/systemd/user/
cp docs/systemd/atlax-langfuse-reconcile.timer ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now atlax-langfuse-reconcile.timer
```

Por defecto corre cada 15 min con ventana de 24h. Ver
[runbook](./docs/operations/runbook.md#estado-y-diagnóstico-del-cron-reconciler)
para diagnóstico.

---

## Activar statusline (opcional)

Mantiene `~/.atlax-ai/tier.json` actualizado en cada turno (mejora la precisión
de los tags `tier:*` y `tier-source:*`).

```json
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/atlax-langfuse-bridge/scripts/statusline.sh"
  }
}
```

---

## Dashboard Langfuse — vistas FinOps

Una vez activo, en el panel de Langfuse:

- **Traces → filter by `userId`** → uso por desarrollador
- **Traces → filter by tag `project:*`** → uso por proyecto
- **Traces → filter by tag `billing:*`** → desglose por cubo
- **Traces → filter by tag `tier:seat-team | vertex-gcp | api-direct`** → tier autoritativo
- **Users** → resumen por dev (sesiones, coste, modelos)
- **Settings → Models** → definir precios para coste real (debe coincidir con `shared/model-pricing.ts`)

Ver [`ARCHITECTURE.md §8`](./ARCHITECTURE.md#§8--observabilidad) para más queries.

---

## LiteLLM Gateway (opt-in, workloads no-CLI)

Para workloads programáticos (Orvian, Atalaya, MCP servers backend) hay un
gateway opt-in con virtual keys + soft budget. **El flujo CLI de los 38 devs
no cambia** — sigue por OAuth directo a Anthropic.

```bash
cd docker

# Generar secretos
echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)"
echo "LITELLM_SALT_KEY=$(openssl rand -hex 32)"
# → Añadir a .env junto con ANTHROPIC_API_KEY y LITELLM_UI_*

# Arrancar (profile opt-in — sin él arranca solo Langfuse)
docker compose --profile litellm up -d
```

- API: `http://localhost:4001/v1/messages`
- Admin UI: `http://localhost:4001/ui`

Ver [runbook → LiteLLM Gateway](./docs/operations/runbook.md#operaciones-de-litellm-gateway)
para provisionar virtual keys, alertas, rotación.

Decisión documentada en [ADR-007](./docs/adr/ADR-007-litellm-optin.md).

---

## MCP server — tools agénticos

`scripts/mcp-server.ts` expone tools de Langfuse (`query-langfuse-trace`,
`annotate-observation`) vía MCP stdio. Para Claude Desktop:

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
// %APPDATA%\Claude\claude_desktop_config.json (Windows)
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

Smoke E2E: `bun run scripts/smoke-mcp-e2e.ts`.

Decisión documentada en [ADR-005](./docs/adr/ADR-005-mcp-stdio-no-sdk.md).

---

## Browser extension — claude.ai + Desktop App

`browser-extension/` (Manifest V3) captura claude.ai (chat / projects) y
Claude Desktop App (Electron). Cobertura complementaria al hook CLI.

```
1. chrome://extensions → activar "Modo desarrollador"
2. "Cargar descomprimida" → seleccionar la carpeta browser-extension/
3. Click en el icono → host + public/secret keys
4. "Guardar y verificar" → debe mostrar "Conectado — Langfuse vX.Y"
```

Las trazas aparecen con prefijo `claude-web-*` (vs `cc-*` del CLI) y tag
`entrypoint:claude-ai`. Ver [`ARCHITECTURE.md §3`](./ARCHITECTURE.md#§3--modelo-de-dominio).

---

## Comandos esenciales

```bash
# Validar integridad contra Langfuse
bun run scripts/validate-traces.ts

# Detect-only (no escribe)
DRY_RUN=1 bun run scripts/reconcile-traces.ts

# Detect + repair drift
bun run scripts/reconcile-traces.ts

# Forzar redetección de tier
bun run scripts/detect-tier.ts && cat ~/.atlax-ai/tier.json

# Tests + typecheck
bun run check
```

Más comandos en [runbook](./docs/operations/runbook.md).

---

## Limitaciones conocidas

| Objetivo                            | Estado                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| Claude Code CLI                     | ✅ Cubierto (hook Stop + reconciler)                              |
| claude.ai (chat/projects)           | ✅ Cubierto vía `browser-extension/`                              |
| Claude Desktop App (Electron)       | ✅ Cubierto vía la misma extension (UA Electron → `platform:app`) |
| IDE extensions (VS Code)            | ⚠️ Parcial — solo si lanzan Claude Code via CLI                   |
| Cuenta corp vs personal             | ❌ Requiere Analytics API (solo Enterprise)                       |
| Team subscription vs overage exacto | ⚠️ `service_tier: priority` es indicador, no garantía             |

Ver [`ARCHITECTURE.md §12`](./ARCHITECTURE.md#§12--gaps-pendientes) para los
GAPs pendientes y mitigación.

---

## Actualizar el hook tras un release

```bash
git pull
bash setup/setup.sh   # sobreescribe ~/.claude/hooks/langfuse-sync.ts
```

---

## Estructura del repositorio

```
hooks/                           # Hook Stop síncrono
scripts/                         # Reconciler, MCP, validate, detect-tier
shared/                          # Biblioteca pura (cero deps prod)
tests/                           # 466 tests / 814 expects
browser-extension/               # MV3 captura claude.ai
docker/                          # Langfuse v3 + LiteLLM (opt-in)
infra/                           # Cloud Run target + backup story
docs/                            # ADRs + runbook + systemd units
setup/                           # Installers (Linux/macOS/WSL/Windows)

ARCHITECTURE.md                  # SDD canónico (§1-§14 + Apéndice A)
CHANGELOG.md                     # Semver retroactivo
ORGANIZATION.md                  # Convenciones Atlax
CLAUDE.md                        # Invariantes I-1..I-13 (Claude Code)
```

Detalle completo en [`ARCHITECTURE.md §4`](./ARCHITECTURE.md#§4--estructura-del-repositorio).

---

## Contribuir

Este repo sigue las convenciones canónicas del ecosistema Atlax360
(ver [`ORGANIZATION.md`](./ORGANIZATION.md)):

- **Branches**: nunca commitear a `main`. Crear rama `<type>/<descripción>`.
- **Versionado**: semver retroactivo (MAJOR breaking · MINOR feature · PATCH fix).
- **ADRs**: inmutables. Cambio de decisión = nuevo ADR con `Supersedes: ADR-NNN`.
- **Tests**: cada PR debe pasar `bun run check` (typecheck + tests).
- **CLAUDE.md**: respetar invariantes I-1..I-13.

Ver [`CLAUDE.md`](./CLAUDE.md) para detalle de invariantes.
