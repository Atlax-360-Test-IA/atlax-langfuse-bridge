# atlax-langfuse-bridge

Torre de control FinOps de Claude Code para Atlax360. Captura cada sesión vía
hook `Stop`, agrega tokens y coste, y emite trazas a Langfuse self-hosted.
Incluye un reconciler cron, un gateway LiteLLM opt-in para workloads
programáticos, y un MCP server para consultas agénticas.

**Cero dependencias en producción** — solo Bun (built-in).

> 📖 **Arquitectura completa**: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> 🛠️ **Operación día-a-día**: [`docs/operations/runbook.md`](./docs/operations/runbook.md)
> 📋 **Decisiones formales**: [`docs/adr/`](./docs/adr/) (ADR-001..ADR-011)
> 📜 **Changelog**: [`CHANGELOG.md`](./CHANGELOG.md)
> 📊 **Dashboard Langfuse**: [`docs/operations/langfuse-dashboard-guide.md`](./docs/operations/langfuse-dashboard-guide.md)

**v0.6.0-wip · 818 tests / 1475 expects / 0 fallos** · v1.0 cuando piloto exitoso (≥3 devs × 2 semanas)

---

## ¿Qué hace?

```
Dev cierra sesión Claude Code
       ↓
  Hook Stop síncrono
  (hooks/langfuse-sync.ts)
       ↓  agrega tokens + coste
  POST /api/public/ingestion
       ↓
  Langfuse v3 (self-hosted)  ←──  Reconciler cron (cada 15min)
                                   detecta drift, repara
```

Cada sesión genera una traza `claude-code-session` con:

- Developer (detectado automáticamente de `git config user.email`)
- Proyecto git (`org/repo`)
- Modelos usados, tokens, coste estimado
- Billing tier (`seat-team`, `vertex-gcp`, `api-direct`)
- OS, entrypoint, rama git

---

## Quick Start (3 pasos)

### 1. Levantar Langfuse (una vez, en servidor compartido)

```bash
cd docker
cp env.example .env

# Generar secretos
openssl rand -base64 32   # → NEXTAUTH_SECRET y SALT en .env
openssl rand -hex 32      # → ENCRYPTION_KEY en .env

# Editar .env con NEXTAUTH_URL del dominio
docker compose up -d
```

Acceder a `http://localhost:3000`, crear el proyecto **claude-code** y copiar
las claves `pk-lf-...` / `sk-lf-...` al `.env`.

### 2. Instalar el hook en cada máquina dev

**Linux / macOS / WSL** (un comando):

```bash
bash setup/setup.sh \
  "https://langfuse.atlax360.com" \
  "pk-lf-XXXX" \
  "sk-lf-XXXX"
```

**Piloto multi-IDE (LiteLLM gateway)** — credenciales por env vars, flags solo `--litellm-mode` y `--dry-run`:

```bash
LANGFUSE_HOST="https://langfuse.atlax360.com" \
LANGFUSE_PUBLIC_KEY="pk-lf-XXXX" \
LANGFUSE_SECRET_KEY="sk-lf-XXXX" \
LITELLM_BASE_URL="https://litellm.atlax360.com" \
LITELLM_VIRTUAL_KEY="sk-..." \
bash scripts/pilot-onboarding.sh --litellm-mode
```

Para preview sin escribir nada:

```bash
LANGFUSE_HOST=... LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
  bash scripts/pilot-onboarding.sh --dry-run
```

Ver [`docs/operations/litellm-onboarding.md`](./docs/operations/litellm-onboarding.md)
para el flujo completo del piloto multi-IDE.

### 3. Variables de entorno

```bash
# ~/.zshrc o ~/.bashrc — el setup script las añade automáticamente
export LANGFUSE_HOST="https://langfuse.atlax360.com"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
```

El nombre del dev se detecta automáticamente de `git config user.email`.
Listo — la siguiente sesión Claude Code emite traza al cerrar.

---

## Qué se registra automáticamente

| Campo                 | Fuente                                                 |
| --------------------- | ------------------------------------------------------ |
| **Developer**         | `git config user.email` (override: `LANGFUSE_USER_ID`) |
| **Proyecto**          | `git remote get-url origin` → `org/repo`               |
| **Modelos usados**    | JSONL `message.model`                                  |
| **Tokens**            | JSONL `message.usage.*` (input, output, cache)         |
| **Coste estimado**    | tokens × precio modelo (`shared/model-pricing.ts`)     |
| **Billing tier**      | `service_tier` + `CLAUDE_CODE_USE_VERTEX`              |
| **Tier determinista** | `~/.atlax-ai/tier.json` (escrito por detect-tier)      |
| **OS**                | `/proc/version` / `process.platform`                   |
| **Branch git**        | JSONL `gitBranch`                                      |
| **Entrypoint**        | JSONL `entrypoint` (`cli` / `sdk-ts`)                  |
| **Source**            | `source:reconciler` si fue reparado por el cron        |

---

## Reconciler cron (recomendado)

El hook puede no ejecutar (kill -9, crash, reboot). El reconciler detecta
el drift y repara en la siguiente ventana.

**Linux / WSL** (systemd user):

```bash
cp docs/systemd/atlax-langfuse-reconcile.service ~/.config/systemd/user/
cp docs/systemd/atlax-langfuse-reconcile.timer ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now atlax-langfuse-reconcile.timer
```

Por defecto: cada 15 min, ventana de 24h. Ajustar `WINDOW_HOURS` en
`~/.atlax-ai/reconcile.env` para sesiones largas (72h o 168h).

**macOS** (launchd): ver [`docs/operations/runbook.md`](./docs/operations/runbook.md#cron-macos).

---

## Salud del bridge (bridge-health)

El reconciler emite automáticamente un trace `bridge-health` en cada scan con:

```
metadata.candidates   → sesiones detectadas en la ventana
metadata.drift        → sesiones con drift
metadata.repaired     → reparadas exitosamente
metadata.failed       → fallidas
tags: status:ok | status:degraded
tags: date:YYYY-MM-DD, source:reconciler
```

Ver consultas en [`docs/operations/langfuse-dashboard-guide.md`](./docs/operations/langfuse-dashboard-guide.md).

---

## LiteLLM Gateway (opt-in)

Para workloads programáticos (MCP servers, scripts, IDEs alternativos)
hay un gateway con virtual keys + soft budget. **El flujo CLI no cambia.**

```bash
cd docker

# Secretos (añadir a .env)
echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)"
echo "LITELLM_SALT_KEY=$(openssl rand -hex 32)"
# También: ANTHROPIC_API_KEY, LITELLM_UI_USERNAME, LITELLM_UI_PASSWORD

docker compose --profile litellm up -d
# API: http://localhost:4001/v1/messages
# Admin UI: http://localhost:4001/ui
```

Modelos disponibles: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5.

Ver [`docs/operations/litellm-onboarding.md`](./docs/operations/litellm-onboarding.md)
y [ADR-007](./docs/adr/ADR-007-litellm-optin.md).

---

## Statusline (mejora precisión de tier)

Mantiene `~/.atlax-ai/tier.json` actualizado en cada turno de Claude Code:

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

## MCP server — tools agénticos

`scripts/mcp-server.ts` expone `query-langfuse-trace` y `annotate-observation`
vía MCP stdio. Para Claude Desktop:

```json
{
  "mcpServers": {
    "atlax-langfuse-bridge": {
      "command": "bun",
      "args": ["run", "/path/to/atlax-langfuse-bridge/scripts/mcp-server.ts"],
      "env": {
        "LANGFUSE_HOST": "http://localhost:3000",
        "LANGFUSE_PUBLIC_KEY": "pk-lf-…",
        "LANGFUSE_SECRET_KEY": "sk-lf-…"
      }
    }
  }
}
```

Ver [ADR-005](./docs/adr/ADR-005-mcp-stdio-no-sdk.md).

---

## Browser extension — claude.ai + Desktop App

`browser-extension/` (Manifest V3) captura claude.ai (chat / projects) y
Claude Desktop App (Electron). Cobertura complementaria al hook CLI.

```
1. chrome://extensions → activar "Modo desarrollador"
2. "Cargar descomprimida" → seleccionar carpeta browser-extension/
3. Click en el icono → host + public/secret keys
4. "Guardar y verificar" → debe mostrar "Conectado — Langfuse vX.Y"
```

Trazas con prefijo `claude-web-*` y tag `entrypoint:claude-ai`.

---

## Comandos esenciales

```bash
# Tests + typecheck (818 tests / 0 fallos)
bun run check

# Validar integridad contra Langfuse
bun run scripts/validate-traces.ts

# Reconciler manual (dry-run)
DRY_RUN=1 bun run scripts/reconcile-traces.ts

# Reconciler manual (repair)
bun run scripts/reconcile-traces.ts

# Forzar redetección de tier
bun run scripts/detect-tier.ts && cat ~/.atlax-ai/tier.json

# Estado del cron
systemctl --user status atlax-langfuse-reconcile.timer
journalctl --user -u atlax-langfuse-reconcile.service -n 50
```

Más comandos en [`docs/operations/runbook.md`](./docs/operations/runbook.md).

---

## Limitaciones conocidas

| Objetivo                            | Estado                                                          |
| ----------------------------------- | --------------------------------------------------------------- |
| Claude Code CLI                     | ✅ Cubierto (hook Stop + reconciler)                            |
| claude.ai (chat/projects)           | ✅ Cubierto vía `browser-extension/`                            |
| Claude Desktop App (Electron)       | ✅ Cubierto vía browser extension (UA Electron)                 |
| LiteLLM gateway (API-key workloads) | ✅ Opt-in operativo (virtual keys + budget)                     |
| IDE alternativos (Cline, Continue)  | ⚠️ Parcial — vía LiteLLM gateway; cobertura completa en POST-V1 |
| Coste real seats Premium            | ⚠️ Estimado. Real disponible solo con `ANTHROPIC_ADMIN_API_KEY` |
| Quota seat en tiempo real           | ❌ API no expone este dato (ADR-009)                            |
| Multi-vendor (OpenAI, Vertex)       | 🔜 POST-V1 (base LiteLLM ya disponible)                         |

---

## Estructura del repositorio

```
hooks/                   # Hook Stop síncrono (langfuse-sync.ts)
scripts/                 # Reconciler, MCP, validate, detect-tier, pilot-onboarding
shared/                  # Biblioteca pura — pricing, aggregate, drift, degradation
tests/                   # 818 tests / 1475 expects (52 ficheros)
browser-extension/       # MV3 — captura claude.ai y Desktop App
docker/                  # Langfuse v3 self-hosted + LiteLLM gateway (opt-in)
infra/                   # Cloud Run target + backup story
docs/
  adr/                   # ADR-001..ADR-011 (inmutables)
  operations/            # runbook, litellm-onboarding, pilot-kpis, dashboard-guide
  rfcs/                  # RFC-001 (Anthropic cost_report), RFC-002 (HTTP bridge)
  spikes/                # S23-A (bridge HTTP viability)
  roadmap/               # Q2-Q3 2026, sprint-17
  systemd/               # Units para el reconciler cron
setup/                   # Installers (Linux/macOS/WSL/Windows)

ARCHITECTURE.md          # SDD canónico §1-§14 + Apéndice A
CHANGELOG.md             # Semver retroactivo (v0.1.0 → v1.0)
CLAUDE.md                # Invariantes I-1..I-14 + comandos operativos
ORGANIZATION.md          # Convenciones ecosistema Atlax
```

Detalle completo en [`ARCHITECTURE.md §4`](./ARCHITECTURE.md#§4--estructura-del-repositorio).

---

## Actualizar el hook tras un release

```bash
git pull
bash setup/setup.sh   # sobreescribe ~/.claude/hooks/langfuse-sync.ts
```

---

## Contribuir

Este repo sigue las convenciones canónicas del ecosistema Atlax360
([`ORGANIZATION.md`](./ORGANIZATION.md)):

- **Branches**: nunca commitear a `main`. Rama `<type>/<descripción>`.
- **Versionado**: semver (MAJOR breaking · MINOR feature · PATCH fix/docs).
- **ADRs**: inmutables. Cambio = nuevo ADR con `Supersedes: ADR-NNN`.
- **Tests**: cada PR pasa `bun run check` (typecheck + 818 tests).
- **Invariantes**: respetar I-1..I-14 en [`CLAUDE.md`](./CLAUDE.md).
