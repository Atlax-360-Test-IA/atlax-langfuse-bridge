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
│   ├── docker-compose.yml   # Langfuse v3 self-hosted completo
│   └── env.example          # Variables requeridas (copiar a .env)
├── hooks/
│   └── langfuse-sync.ts     # Hook script (Bun, sin dependencias)
├── setup/
│   ├── setup.sh             # Installer Linux / macOS / WSL
│   └── setup.ps1            # Installer Windows nativo
└── README.md
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
