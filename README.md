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
│   ├── docker-compose.yml       # Langfuse v3 self-hosted completo
│   └── env.example              # Variables requeridas (copiar a .env)
├── hooks/
│   └── langfuse-sync.ts         # Hook Stop (Bun, sin dependencias)
├── scripts/
│   ├── validate-traces.ts       # Smoke test: JSONL local vs Langfuse
│   ├── reconcile-traces.ts      # Cron job: repara traces con drift
│   ├── detect-tier.ts           # Escribe ~/.atlax-ai/tier.json
│   └── statusline.sh            # Statusline Claude Code → detect-tier
├── docs/
│   └── systemd/                 # User units Linux/WSL del reconciler
├── setup/
│   ├── setup.sh                 # Installer Linux / macOS / WSL
│   └── setup.ps1                # Installer Windows nativo
├── browser-extension/           # MV3 capture claude.ai (futuro: MDM push)
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

## Limitaciones conocidas

| Objetivo                            | Estado                                                |
| ----------------------------------- | ----------------------------------------------------- |
| Claude Code CLI                     | ✅ Cubierto                                           |
| claude.ai (chat/projects)           | ❌ No genera JSONL local — imposible sin proxy        |
| IDE extensions (VS Code)            | ⚠️ Parcial — solo si lanzan Claude Code via CLI       |
| Cuenta corp vs personal             | ❌ Requiere Analytics API (solo Enterprise/API plan)  |
| Team subscription vs overage exacto | ⚠️ `service_tier: priority` es indicador, no garantía |

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
