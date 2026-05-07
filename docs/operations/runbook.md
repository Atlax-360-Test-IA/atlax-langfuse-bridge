# Runbook Operativo — atlax-langfuse-bridge

> Procedimientos operativos del sistema. Para arquitectura, ver
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md). Para instalación inicial, ver
> [`README.md`](../../README.md).

## Índice

- [Validar integridad contra Langfuse](#validar-integridad-contra-langfuse)
- [Detectar y reparar drift](#detectar-y-reparar-drift)
- [Estado y diagnóstico del cron reconciler](#estado-y-diagnóstico-del-cron-reconciler)
- [Forzar redetección de tier](#forzar-redetección-de-tier)
- [Diagnóstico de degradation logs](#diagnóstico-de-degradation-logs)
- [Triage por componente](#triage-por-componente)
- [Operaciones de LiteLLM Gateway](#operaciones-de-litellm-gateway)
- [Browser extension — diagnóstico](#browser-extension--diagnóstico)
- [Rollback de Langfuse](#rollback-de-langfuse)
- [Actualizar el hook en máquinas dev](#actualizar-el-hook-en-máquinas-dev)
- [Actualizar pricing tras nuevo modelo Anthropic](#actualizar-pricing-tras-nuevo-modelo-anthropic)

---

## Validar integridad contra Langfuse

Compara JSONLs locales con traces remotos y reporta drift en tabla:

```bash
# Últimas 24h (default)
bun run scripts/validate-traces.ts

# Ventana específica
WINDOW_HOURS=72 bun run scripts/validate-traces.ts

# Sesiones concretas
bun run scripts/validate-traces.ts path/to/session.jsonl [...]
```

Exit code:

- `0` — todas las sesiones en sync
- `1` — drift detectado (útil en CI)
- `2` — error de configuración (falta `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`)

---

## Detectar y reparar drift

```bash
# Detect-only (no escribe)
DRY_RUN=1 bun run scripts/reconcile-traces.ts

# Detect + repair
bun run scripts/reconcile-traces.ts

# Excluir sesión actual (la que aún no ha cerrado)
EXCLUDE_SESSION=<sid> bun run scripts/reconcile-traces.ts
```

### Categorías de drift

| Status        | Significado                            |
| ------------- | -------------------------------------- |
| `OK`          | Local y remoto coinciden               |
| `MISSING`     | Sesión local sin trace remoto          |
| `TURNS_DRIFT` | `local.turns ≠ remote.metadata.turns`  |
| `COST_DRIFT`  | Diferencia > `COST_EPSILON` (0.01 USD) |
| `END_DRIFT`   | Timestamp de fin difiere               |

Para cada drift, el reconciler re-ejecuta el hook con un payload Stop sintético.
Idempotencia garantizada por `traceId = cc-${session_id}` (ver
[ADR-003](../adr/ADR-003-langfuse-idempotent.md)).

El reconciler loguea en JSON estructurado a stdout (journalctl-friendly).

---

## Estado y diagnóstico del cron reconciler

### Linux / WSL (systemd user)

```bash
# Estado del timer
systemctl --user status atlax-langfuse-reconcile.timer

# Logs últimas 50 entradas
journalctl --user -u atlax-langfuse-reconcile.service -n 50

# Próxima ejecución
systemctl --user list-timers atlax-langfuse-reconcile.timer

# Reiniciar tras editar reconcile.env
systemctl --user restart atlax-langfuse-reconcile.timer
```

### macOS (launchd)

```bash
launchctl list | grep atlax
tail -n 50 ~/Library/Logs/atlax-langfuse-reconcile.log
```

### Errores comunes

| Error en logs                                       | Causa probable                                   | Mitigación                                 |
| --------------------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| `LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set` | `~/.atlax-ai/reconcile.env` no cargado           | Verificar `EnvironmentFile=` en `.service` |
| `LANGFUSE_HOST blocked`                             | Host fuera de allowlist (no HTTPS, no localhost) | Ajustar `LANGFUSE_HOST` o usar HTTPS       |
| `hook-replay-timeout`                               | Hook tarda >30s (Langfuse caído o lento)         | Verificar `docker compose ps`              |
| `cwd-missing`                                       | JSONL sin entry con campo `cwd`                  | Skip (sesión muy corta sin context)        |

---

## Forzar redetección de tier

```bash
bun run scripts/detect-tier.ts
cat ~/.atlax-ai/tier.json
```

El statusline (`scripts/statusline.sh`) actualiza `tier.json` en cada turno.
Forzar manual solo si:

- Cambio reciente de `CLAUDE_CODE_USE_VERTEX` o `ANTHROPIC_API_KEY`
- Login/logout de cuenta Anthropic (cambio de `~/.claude/.credentials.json`)
- Tag `tier:unknown` apareciendo inesperadamente

### Estructura tier.json

```json
{
  "tier": "seat-team",
  "source": "credentials-exists",
  "account": null,
  "ts": "2026-04-27T10:00:00.000Z"
}
```

`account` queda `null` cuando `source=credentials-exists` por diseño (I-8 — no
parsear el archivo de credenciales).

---

## Diagnóstico de degradation logs

Todos los `catch` del hook y reconciler emiten degradation log JSON estructurado:

```json
{
  "type": "degradation",
  "source": "sendToLangfuse",
  "error": "fetch failed",
  "ts": "2026-04-27T10:00:00.000Z"
}
```

### Filtrado por journalctl

```bash
journalctl --user -u atlax-langfuse-reconcile.service -n 200 \
  | grep '"type":"degradation"' \
  | jq .
```

### Fuentes (`source`) comunes

| Source                      | Significado                                      | Acción                                       |
| --------------------------- | ------------------------------------------------ | -------------------------------------------- |
| `sendToLangfuse`            | POST `/api/public/ingestion` falló               | Verificar Langfuse arriba; reconciler recoge |
| `getTrace:fetch`            | GET trace falló                                  | Tolerable — el reconciler reintenta          |
| `aggregateLines:parse`      | Línea JSONL malformada                           | Investigar fichero específico                |
| `getProjectName:git-remote` | `git remote` falló (CWD fuera de repo o sin git) | Esperado en algunos contextos (CI temp dirs) |
| `detectTier:credentials`    | Lectura `tier.json` falló                        | Re-ejecutar `detect-tier.ts`                 |

---

## Triage por componente

| Componente             | Síntoma                     | Primera acción                                                                   |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| Hook `Stop`            | Sesiones sin trace          | Verificar `~/.atlax-ai/reconcile.env`; mirar `journalctl --user`                 |
| Reconciler             | Cron no dispara             | `systemctl --user status atlax-langfuse-reconcile.timer`                         |
| Langfuse `(unhealthy)` | Healthcheck falla           | `docker compose logs langfuse-web --tail 50`                                     |
| Langfuse worker        | Traces no aparecen tras 30s | `docker compose logs langfuse-worker --tail 50`                                  |
| MCP server             | Tool call falla con -32602  | Verificar `MCP_AGENT_TYPE` allowlist (`coordinator`/`trace-analyst`/`annotator`) |
| Browser extension      | No captura sesiones         | DevTools → service worker activo + popup conectado                               |
| LiteLLM gateway        | `Forbidden` 401             | Re-provisionar virtual key; nunca rotar `LITELLM_SALT_KEY`                       |

---

## Operaciones de LiteLLM Gateway

> El gateway es **opt-in**. Requiere `docker compose --profile litellm up -d`.

### Activar LiteLLM M1 (primera vez)

M1 = gateway operativo con master key única. Sin virtual keys aún (M3) ni
callback Langfuse activo (M2 — ya configurado en `config.yaml` pero pendiente
de validar con LANGFUSE*INIT_PROJECT*\*\_KEY rellenas).

```bash
cd docker

# 1. Generar secretos (ejecutar una vez, guardar en .env)
echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)"   # → .env
echo "LITELLM_SALT_KEY=$(openssl rand -hex 32)"         # → .env
# ANTHROPIC_API_KEY ya debe estar en .env (cuenta corporativa Atlax360)

# 2. Arrancar con perfil litellm
docker compose --profile litellm up -d litellm

# 3. Verificar health (esperar ~15s en primer arranque — BD init)
curl http://localhost:4001/health/liveliness
# Esperado: "I'm alive!"

# 4. Smoke test M1
LITELLM_MASTER_KEY=$(grep LITELLM_MASTER_KEY .env | cut -d= -f2) \
  bun test tests/litellm-m1-smoke.test.ts
# Esperado: 5 pass, 0 fail
```

**Variables requeridas en `docker/.env`:**

| Variable             | Descripción                              | Cómo generar                      |
| -------------------- | ---------------------------------------- | --------------------------------- |
| `ANTHROPIC_API_KEY`  | Clave API corporativa Atlax360           | Panel Anthropic → API Keys        |
| `LITELLM_MASTER_KEY` | Gate admin UI + virtual keys (M3)        | `echo sk-$(openssl rand -hex 32)` |
| `LITELLM_SALT_KEY`   | Cifra virtual keys en BD — **inmutable** | `openssl rand -hex 32`            |

> ⚠️ `LITELLM_SALT_KEY` nunca se rota tras emitir virtual keys. Cambiarla invalida
> todas las keys existentes en la BD.

### Arrancar gateway

```bash
cd docker

# Generar secretos (una vez)
echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)"
echo "LITELLM_SALT_KEY=$(openssl rand -hex 32)"
# → Añadir a .env

docker compose --profile litellm up -d
```

- **API**: `http://localhost:4001/v1/messages` (OpenAI-compatible)
- **Admin UI**: `http://localhost:4001/ui`
- **BD**: `litellm` en mismo postgres (auto-creada por `litellm-db-init`)

### Provisionar virtual keys

```bash
# Preview (no crea)
DRY_RUN=1 bun run scripts/provision-keys.ts

# Crear (idempotente — re-ejecutar es seguro)
bun run scripts/provision-keys.ts
# → ~/.atlax-ai/virtual-keys.json
```

### Usar virtual key

```bash
ORVIAN_KEY=$(jq -r '.keys[] | select(.key_alias=="orvian-prod") | .key' \
  ~/.atlax-ai/virtual-keys.json)

curl http://localhost:4001/v1/chat/completions \
  -H "Authorization: Bearer $ORVIAN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hola"}]}'
```

### Alertas de presupuesto

LiteLLM alerta cuando spend supera `soft_budget`. Configurar
`LITELLM_ALERT_WEBHOOK_URL` en `.env` para recibir notificaciones (Slack-compatible).

Sin webhook, los warnings aparecen en logs:

```bash
docker compose --profile litellm logs litellm | grep -i budget
```

### Rotación de claves

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

> ⚠️ **NO rotar `LITELLM_SALT_KEY`** salvo compromiso del sistema completo.
> Cambiarla invalida TODAS las virtual keys ya emitidas.

### Smoke E2E

```bash
bun run scripts/smoke-litellm-langfuse.ts
```

Verifica que el callback Langfuse del gateway está activo (trace con tag
`source:litellm-gateway` aparece en mismo project).

---

## Browser extension — diagnóstico

### Service worker activo

1. Abrir `chrome://extensions`
2. Click en "Inspeccionar vistas: service worker" para `atlax-langfuse-bridge`
3. Verificar logs en consola del SW

### Degradation log de la extensión

```js
// En consola del service worker:
chrome.storage.local
  .get("degradationLog")
  .then((r) => console.table(r.degradationLog));
```

Buffer rolling de 50 entradas. Cada entry: `{ source, error, ts }`.

### Popup desconectado

1. Click en icono extensión → popup
2. Verificar host + public key + secret key
3. Click "Guardar y verificar" — debe mostrar "Conectado — Langfuse vX.Y"
4. Si falla: red bloqueada, host incorrecto, o clave inválida

---

## Rollback de Langfuse

> Aplicable a self-hosted local. En PRO (Cloud Run) el rollback usa
> `gcloud run services update-traffic` — ver [`infra/backup-story.md`](../../infra/backup-story.md).

### Rollback de versión Langfuse

```bash
cd docker

# Pin versión específica en docker-compose.yml
# image: langfuse/langfuse:3.X.Y  (en lugar de :3)

docker compose pull langfuse-web langfuse-worker
docker compose up -d langfuse-web langfuse-worker

# Verificar
docker compose ps
curl http://localhost:3000/api/public/health
```

### Restore desde backup (postgres)

```bash
# Asumiendo backup en ~/atlax-backups/postgres-{date}.sql.gz

docker compose stop langfuse-web langfuse-worker

gunzip -c ~/atlax-backups/postgres-2026-04-27.sql.gz \
  | docker compose exec -T postgres psql -U langfuse -d langfuse

docker compose start langfuse-web langfuse-worker
```

### ClickHouse restore

ClickHouse particiona nativo via MergeTree. Restore parcial por particiones
es preferible a full restore. Ver `infra/backup-story.md` para detalle.

---

## Actualizar el hook en máquinas dev

```bash
# Pull del repo y reinstalar
git pull
bash setup/setup.sh   # sobreescribe ~/.claude/hooks/langfuse-sync.ts
```

El setup script es idempotente. Si las claves Langfuse ya están en `~/.zshrc`,
no las duplica.

### Rollback del hook

```bash
# Restaurar versión anterior desde git
git checkout <commit-anterior> -- hooks/langfuse-sync.ts
bash setup/setup.sh
```

---

## Actualizar pricing tras nuevo modelo Anthropic

Cuando Anthropic publica un nuevo modelo o cambia precios, sigue este procedimiento:

```bash
# 1. Verificar qué hay actualmente
./scripts/sync-pricing.sh

# 2. Editar shared/model-pricing.ts (añadir entrada o corregir valores)
#    Fuente oficial: https://platform.claude.com/docs/en/about-claude/pricing

# 3. Añadir el nuevo modelo a EXPECTED_MODELS en scripts/sync-pricing.sh

# 4. Validar y testear
bun test shared/model-pricing.test.ts
bun run check

# 5. Comparar con dashboard (si tienes acceso al path local)
DASHBOARD_PRICING_PATH=~/work/atlax-claude-dashboard/src/lib/pricing.ts \
  ./scripts/sync-pricing.sh

# 6. Commit y PR
git add shared/model-pricing.ts scripts/sync-pricing.sh
git commit -m "chore(pricing): actualizar <modelo> a $X/$Y MTok"
```

**Nota**: `sync-pricing.sh` detecta modelos faltantes pero no valida valores de precio —
verificar siempre manualmente contra la página oficial de Anthropic.

---

## Mantenimiento

- **Backup local recurrente**: `cron` o `systemd` que ejecute
  `pg_dump` + `clickhouse-backup` → `~/atlax-backups/`
- **Rotación de logs**: journalctl gestiona automático (configurable en `journald.conf`)
- **Monitoreo de espacio docker**: `docker system df` mensual; `docker system prune` si crece
- **Pricing sync mensual**: ejecutar `./scripts/sync-pricing.sh` en la Scope Review mensual para detectar drift

---

## Incidentes

### Plantilla de entrada

```
### INC-NNN · <Título breve> — <Fecha>

**Severidad**: Crítica / Alta / Media / Baja
**Estado**: Resuelto / En curso
**Duración**: HH:MM (detección → resolución)
**Datos perdidos**: Sí (descripción) / No
**Impacto**: N usuarios / N sesiones afectadas

**Cronología**:
- HH:MM — evento inicial
- HH:MM — detección
- HH:MM — diagnóstico
- HH:MM — mitigación aplicada
- HH:MM — resolución confirmada

**Causa raíz**: <descripción técnica concisa>

**Datos irrecuperables**: <descripción o "ninguno">

**Mitigaciones aplicadas**:
- Mitigación 1 (fecha)
- Mitigación 2 (fecha)

**ADR relacionado**: [ADR-NNN](../adr/ADR-NNN-*.md) si aplica
```

---

### INC-001 · Pérdida de BD Langfuse por `docker compose down -v` — 23-Apr-2026

**Severidad**: Crítica
**Estado**: Resuelto
**Duración**: ~2h (detección → stack restaurado con datos parciales)
**Datos perdidos**: Sí — trazas anteriores a ~9-Apr-2026 irrecuperables
**Impacto**: 1 usuario (jgcalvo@atlax360.com), ~84 trazas previas al incidente

**Cronología**:

- 23-Apr-2026 ~11:00 — agente Claude Code ejecuta `docker compose down -v` sin
  confirmación explícita del usuario durante una sesión de mantenimiento del stack
- 23-Apr-2026 ~11:05 — usuario detecta que Langfuse web retorna 500 (BD inexistente)
- 23-Apr-2026 ~11:20 — diagnóstico: volumen `postgres-data` destruido; `docker
volume ls` no muestra volúmenes del proyecto
- 23-Apr-2026 ~11:30 — intento de recuperación: JSONLs en `~/.claude/projects/`
  están intactos pero `cleanupPeriodDays: 14` en settings.json de Claude Code
  implica que sesiones anteriores a ~9-Apr-2026 ya fueron rotadas
- 23-Apr-2026 ~13:00 — stack Langfuse restaurado con `docker compose up -d`; BD
  vacía; reconciler re-sincroniza sesiones de los últimos 14 días
- 24-Apr-2026 — systemd timer de backup configurado y verificado

**Causa raíz**: el agente interpretó "limpiar el stack" como destrucción completa
incluyendo datos. No existía guard técnico que bloqueara `docker compose down -v`
ni backup automático previo.

**Datos irrecuperables**: trazas de jgcalvo@atlax360.com desde el inicio del proyecto
(~1-Apr-2026) hasta ~9-Apr-2026 — aproximadamente 3 semanas de historial FinOps.

**Mitigaciones aplicadas**:

- Backup sistemático diario desde 24-Apr-2026: `scripts/backup-langfuse.sh` vía
  systemd timer `atlax-langfuse-backup.timer` (03:00h, 7 diarios + 4 semanales).
  Restore drill verificado 28-Apr-2026.
- `cleanupPeriodDays: 90` documentado como prerequisito para todos los devs del
  piloto (aumenta la ventana de recuperación vía reconciler).
- Hook `hooks/pre-tool-use-guard.sh` registrado en PreToolUse (PR #39) — bloquea
  `docker compose down -v`, `docker volume rm/prune`, y otros patrones destructivos.
- ADR-008 creado formalizando los límites de recuperabilidad de la 2-layer
  eventual consistency.

**Gap pendiente**: backup sigue siendo local (mismo host que los datos). GAP-P02 en
`ARCHITECTURE.md §12` — resuelto estructuralmente en PRO con Cloud SQL PITR.

**ADR relacionado**: [ADR-008](../adr/ADR-008-consistency-bounds.md)
