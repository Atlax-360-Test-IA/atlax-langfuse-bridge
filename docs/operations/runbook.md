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

## Mantenimiento

- **Backup local recurrente**: `cron` o `systemd` que ejecute
  `pg_dump` + `clickhouse-backup` → `~/atlax-backups/`
- **Rotación de logs**: journalctl gestiona automático (configurable en `journald.conf`)
- **Monitoreo de espacio docker**: `docker system df` mensual; `docker system prune` si crece
