# Runbook Operativo — atlax-langfuse-bridge

> Procedimientos operativos del sistema. Para arquitectura, ver
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md). Para instalación inicial, ver
> [`README.md`](../../README.md).

## Índice

- [Env files DEV vs PRO](#env-files-dev-vs-pro)
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
- [Reconciliación de coste contra Anthropic Admin API (S18-B/D)](#reconciliación-de-coste-contra-anthropic-admin-api-s18-bd)
- [Actualizar pricing tras nuevo modelo Anthropic](#actualizar-pricing-tras-nuevo-modelo-anthropic)
- [Upgrades de Langfuse](#upgrades-de-langfuse)

---

## Env files DEV vs PRO

### Estructura

Existen dos ficheros de credenciales separados, con `chmod 600`:

| Fichero               | Entorno | Host                           |
| --------------------- | ------- | ------------------------------ |
| `~/.atlax-ai/dev.env` | DEV     | `http://localhost:3000`        |
| `~/.atlax-ai/pro.env` | PRO     | `https://langfuse.atlax360.ai` |

**Diferencia clave**: `dev.env` apunta al stack Langfuse local (localhost). `pro.env`
apunta a la instancia de producción con credenciales reales.

### Activar entorno antes de ejecutar reconciler o scripts

SIEMPRE sourcear el fichero correcto antes de cualquier operación:

```bash
# Entorno PRO (producción)
source ~/.atlax-ai/pro.env
bun run scripts/reconcile-traces.ts

# Entorno DEV (local)
source ~/.atlax-ai/dev.env
bun run scripts/reconcile-traces.ts
```

Si `setup.sh` o `pilot-onboarding.sh` ya configuraron el shell RC, también
puedes usar los aliases:

```bash
atlax-env-pro   # equivale a: source ~/.atlax-ai/pro.env
atlax-env-dev   # equivale a: source ~/.atlax-ai/dev.env
```

Los aliases son intencionales — **no se auto-cargan en el shell RC** para evitar
cross-contamination (riesgo de reparar PRO con datos JSONL locales usando
credenciales equivocadas).

### Migrar desde el fichero legacy `reconcile.env`

Si tu máquina tiene el fichero anterior `~/.atlax-ai/reconcile.env`, usa el
script de migración incluido:

```bash
# Preview (sin cambios)
bash setup/migrate-env-files.sh --dry-run

# Migración real
bash setup/migrate-env-files.sh
```

El script detecta el host configurado y renombra automáticamente:

- `localhost` / `127.0.0.1` → `dev.env`
- `https://*` → `pro.env`

Si no puede clasificar el host, deja el fichero intacto y muestra instrucciones
de migración manual.

### Crear ficheros manualmente

```bash
# DEV
umask 077
cat > ~/.atlax-ai/dev.env <<EOF
LANGFUSE_HOST=http://localhost:3000
LANGFUSE_PUBLIC_KEY=pk-lf-PENDIENTE
LANGFUSE_SECRET_KEY=sk-lf-PENDIENTE
WINDOW_HOURS=24
EOF
chmod 600 ~/.atlax-ai/dev.env

# PRO
cat > ~/.atlax-ai/pro.env <<EOF
LANGFUSE_HOST=https://langfuse.atlax360.ai
LANGFUSE_PUBLIC_KEY=pk-lf-<real>
LANGFUSE_SECRET_KEY=sk-lf-<real>
WINDOW_HOURS=24
EOF
chmod 600 ~/.atlax-ai/pro.env
```

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

## Operaciones de LiteLLM Gateway PRO

> El gateway PRO está disponible en `https://litellm.atlax360.ai` (Cloud Run).
> Para el stack local de desarrollo, ver la sección de docker a continuación.

### Resetear spend de un dev (admin)

Cuando un dev agota su virtual key budget antes del ciclo de 30 días:

```bash
# Obtener la master key del gateway PRO
LITELLM_MASTER_KEY=$(gcloud secrets versions access latest \
  --secret=litellm-master-key \
  --project=atlax360-ai-langfuse-pro)

# Listar key del dev por alias
curl -s "https://litellm.atlax360.ai/key/list?key_alias=<alias-del-dev>" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  | jq '.keys[0] | {key_hash: .token, current_spend: .spend}'

# Resetear spend a 0 (reemplaza <KEY_HASH> con el valor de token)
curl -s -X POST "https://litellm.atlax360.ai/key/update" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "<KEY_HASH>", "spend": 0}'
```

> ⚠️ No confundir con rotar la key. El dev no necesita actualizar su `ANTHROPIC_API_KEY` —
> solo se resetea el contador de spend.

### Rotar ANTHROPIC_API_KEY en Secret Manager + redeploy

Cuando la clave Anthropic corporativa se rota (mensual o tras compromiso):

```bash
# 1. Verificar que tienes la nueva clave lista (sk-ant-api03-...)
NEW_KEY="sk-ant-api03-NUEVA_CLAVE_AQUI"

# 2. Crear nueva versión del secret (no destruye la anterior)
echo -n "$NEW_KEY" | gcloud secrets versions add litellm-anthropic-api-key \
  --data-file=- \
  --project=atlax360-ai-langfuse-pro

# 3. Verificar que la versión se creó correctamente
gcloud secrets versions list litellm-anthropic-api-key \
  --project=atlax360-ai-langfuse-pro

# 4. Forzar nuevo despliegue (Cloud Run recarga secrets al arrancar nueva instancia)
gcloud run services update litellm \
  --region=europe-west1 \
  --project=atlax360-ai-langfuse-pro \
  --no-traffic

# 5. Promover con validación
gcloud run services update-traffic litellm \
  --to-revisions=LATEST=100 \
  --region=europe-west1 \
  --project=atlax360-ai-langfuse-pro

# 6. Smoke test post-rotación
bun run scripts/smoke-litellm-pro-e2e.ts
# Esperado: 4/4 checks passed
```

> ⚠️ Las virtual keys de los devs (orvian-prod, atalaya-prod) NO se invalidan al rotar
> `ANTHROPIC_API_KEY`. Solo el gateway interno se reconecta con la nueva clave.

### Continuidad operativa — roles y acceso

Para garantizar que el servicio puede mantenerse ante ausencia de cualquier operador:

| Rol                  | Persona                 | Acceso requerido                                            |
| -------------------- | ----------------------- | ----------------------------------------------------------- |
| Operador principal   | jgcalvo@atlax360.com    | Owner proyecto GCP `atlax360-ai-langfuse-pro`               |
| Segundo operador     | Asignar de equipo Atlax | Roles: `run.admin`, `secretmanager.admin`, `cloudsql.admin` |
| Acceso de emergencia | Cualquier admin org     | `resourcemanager.organizationAdmin` en org Atlax360         |

**Asignar segundo operador:**

```bash
# Reemplaza SEGUNDO_EMAIL con el email del segundo operador
SEGUNDO_EMAIL="segundo@atlax360.com"
PROJECT="atlax360-ai-langfuse-pro"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="user:$SEGUNDO_EMAIL" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="user:$SEGUNDO_EMAIL" \
  --role="roles/secretmanager.admin"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="user:$SEGUNDO_EMAIL" \
  --role="roles/cloudsql.admin"
```

**Secrets críticos que el segundo operador debe conocer (no los valores, pero sí dónde están):**

| Secret                      | Qué es                               | Rotación                  |
| --------------------------- | ------------------------------------ | ------------------------- |
| `litellm-master-key`        | Gate admin del gateway               | No rotar salvo compromiso |
| `litellm-salt-key`          | Cifra virtual keys — **NUNCA rotar** | Inmutable                 |
| `litellm-anthropic-api-key` | Clave Anthropic corporativa          | Mensual                   |
| `litellm-gchat-webhook-url` | Webhook alertas Google Chat          | Si se rota el espacio     |

---

## Operaciones de LiteLLM Gateway (local / dev)

> Para desarrollo local. Requiere `docker compose --profile litellm up -d`.

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

## Reconciliación de coste contra Anthropic Admin API (S18-B/D)

El reconciler puede comparar el coste estimado local contra el coste real
facturado por Anthropic. Se activa con la variable opcional `ANTHROPIC_ADMIN_API_KEY`.

### Setup

1. Crear Admin API key en `https://console.anthropic.com/settings/admin-keys` (requiere rol `admin` en la organización; no confundir con la API key estándar).
2. La key debe empezar por `sk-ant-admin*`. Las keys estándar (`sk-ant-api*`) reciben 404 en `/v1/organizations/*`.
3. Añadir a `~/.atlax-ai/reconcile.env` (modo 600):
   ```bash
   ANTHROPIC_ADMIN_API_KEY=sk-ant-admin01-...
   ```

### Comportamiento

Tras el scan habitual, si la key está set, el reconciler:

1. Acumula coste estimado por familia de modelo (`familyKey()` normaliza
   `claude-haiku-4-5-20251001` → `claude-haiku-4-5`).
2. Llama `GET /v1/organizations/cost_report` con rango UTC day-aligned.
3. Suma el coste real por modelo, normaliza con `familyKey` y compara.
4. Emite `cost-comparison` (info) con la tabla. Si la divergencia por modelo
   supera `COST_DIVERGENCE_THRESHOLD` (default 5%), emite `cost-divergence-detected` (warn).
5. Caso especial **seat-only**: si todas las filas tienen `realUSD: 0` mientras
   `estimatedUSD > 0`, emite un único `cost-comparison-seat-only` (info) — esto es
   esperado cuando todo el tráfico es OAuth/seats Premium (no facturados vía API).

### Filtros de ruido

- Filas con `< $0.10` en ambos lados se ignoran (ratios poco fiables).
- Threshold ajustable: `COST_DIVERGENCE_THRESHOLD=0.10` para 10%.

### Limitaciones documentadas

- **No hay granularidad de sesión.** El cost_report agrega por modelo + día.
  La señal sirve solo como verificación sistémica, no per-sesión.
- **Seats Premium no aparecen** en el cost_report. Es la condición operativa
  esperada para Atlax actualmente.
- El endpoint `usage_report/claude_code` agrega por usuario+día pero también
  está vacío para seats Premium (verificado empíricamente 2026-05-07).

Ver [RFC-001](../rfcs/RFC-001-anthropic-admin-api-cost-report.md) para el análisis completo.

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

## Upgrades de Langfuse

> Procedimiento canónico para upgrade DEV → PRO. Validado en upgrade 3.172.1 → 3.173.0
> (2026-05-11), traza completa en
> [`docs/operations/upgrade-trace-2026-05-11.md`](./upgrade-trace-2026-05-11.md).

### Pre-upgrade — verificación de release

1. Comprobar última versión upstream:
   ```bash
   gh api repos/langfuse/langfuse/releases --jq '.[0:3] | .[] | "\(.tag_name) | \(.published_at)"'
   ```
2. Comparar con la versión pineada en `docker/docker-compose.yml` y `infra/cloud-run.yaml`.
3. Revisar release notes — buscar:
   - Breaking changes / migraciones de schema
   - Nuevas env vars obligatorias
   - Cambios en defaults TLS / CORS / rate-limiting
4. Verificar migraciones nuevas:
   ```bash
   gh api repos/langfuse/langfuse/compare/vX.Y.Z...vA.B.C \
     --jq '.files[] | select(.filename | test("migration|schema.prisma")) | .filename'
   ```

### Fase DEV — validación local (OBLIGATORIA antes de PRO)

1. **Backup pre-upgrade** (PASO OBLIGATORIO — no skipear):

   ```bash
   bash scripts/backup-langfuse.sh
   ```

   Verifica que se generaron dumps en `~/.atlax-ai/backups/daily/` con tamaño esperado
   (pg: decenas de KB+, ch: cientos de KB+). El script sale con código 2 si falla; no
   continuar hasta que salga 0.

2. Bump versión en `docker/docker-compose.yml` (web + worker — 2 líneas).

3. Pull imágenes en paralelo (las imágenes de Langfuse pesan ~1.5GB cada una; el pull
   secuencial tarda ~16min en broadband doméstico):

   ```bash
   docker pull langfuse/langfuse:NEW_VERSION &
   docker pull langfuse/langfuse-worker:NEW_VERSION &
   wait
   ```

4. Recreate solo web + worker (preserva uptime de postgres/clickhouse/redis/minio):

   ```bash
   docker compose -f docker/docker-compose.yml up -d --no-deps langfuse-web langfuse-worker
   ```

5. Esperar healthy (poll, no sleep):

   ```bash
   for i in $(seq 1 24); do
     STATUS=$(docker inspect docker-langfuse-web-1 --format '{{.State.Health.Status}}' 2>/dev/null)
     [ "$STATUS" = "healthy" ] && break
     sleep 5
   done
   ```

6. Verificar migraciones aplicadas (Postgres):

   ```bash
   docker exec docker-postgres-1 psql -U langfuse -d langfuse -c \
     "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;"
   ```

7. **Smoke E2E** contra DEV:

   ```bash
   source ~/.atlax-ai/dev.env
   bun run scripts/smoke-mcp-e2e.ts
   ```

   Deben pasar 8/8 checks. Ver la sección [Smoke E2E](#smoke-e2e) en el runbook de
   LiteLLM para detalles del test funcional.

8. Suite completa:

   ```bash
   bun run check
   ```

9. Si todo verde, commit + PR + merge antes de tocar PRO (regla "limpio antes de avanzar").

### Fase PRO — promoción a producción

1. Verificar gcloud config:

   ```bash
   gcloud config get-value account  # debe ser jgcalvo@atlax360.com
   ```

2. Verificar Cloud SQL PITR activo (rollback path garantizado):

   ```bash
   gcloud sql instances list --project=atlax360-ai-langfuse-pro \
     --format='value(name,settings.backupConfiguration.pointInTimeRecoveryEnabled)'
   ```

3. Render manifest:

   ```bash
   export LANGFUSE_VERSION=NEW_VERSION
   export GCP_PROJECT_ID=atlax360-ai-langfuse-pro
   envsubst < infra/cloud-run.yaml > /tmp/cloud-run.rendered.yaml
   ```

   Verificar que no quedan variables sin resolver (`grep '\$' /tmp/cloud-run.rendered.yaml`
   solo debe mostrar variables de entorno de la propia aplicación, no `$LANGFUSE_VERSION`).

4. Split por servicio:

   ```bash
   awk 'BEGIN{n=0} /^apiVersion/{n++} {print > "/tmp/cr-svc-" n ".yaml"}' \
     /tmp/cloud-run.rendered.yaml
   ```

5. Deploy web primero (corre migraciones Postgres en arranque):

   ```bash
   gcloud run services replace /tmp/cr-svc-1.yaml \
     --region=europe-west1 --project=atlax360-ai-langfuse-pro
   ```

6. Smoke de health básico contra dominio:

   ```bash
   curl -s -o /dev/null -w "HTTP %{http_code}\n" https://langfuse.atlax360.ai/api/public/health
   ```

   Debe ser 200.

7. Deploy worker:

   ```bash
   gcloud run services replace /tmp/cr-svc-2.yaml \
     --region=europe-west1 --project=atlax360-ai-langfuse-pro
   ```

8. Verificar 0 errors en logs (5min freshness):

   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" AND severity>=ERROR' \
     --project=atlax360-ai-langfuse-pro --freshness=5m --limit=5
   ```

9. **Smoke E2E real** contra PRO:
   ```bash
   source ~/.atlax-ai/reconcile.env
   bun run scripts/smoke-mcp-e2e.ts
   ```
   Deben pasar 8/8 checks.

### Rollback (si algo falla en PRO)

```bash
# Listar revisiones disponibles
gcloud run revisions list --service=langfuse-web --region=europe-west1 \
  --project=atlax360-ai-langfuse-pro --limit=3

# Rollback a revisión previa (reemplazar NNNNN-XXX con el ID de la revisión anterior)
gcloud run services update-traffic langfuse-web \
  --to-revisions=langfuse-web-NNNNN-XXX=100 \
  --region=europe-west1 --project=atlax360-ai-langfuse-pro
```

Si las migraciones Postgres rompieron el schema: Cloud SQL PITR restore al punto
pre-upgrade. Ver también la sección [Rollback de Langfuse](#rollback-de-langfuse) para
procedimiento de rollback del stack local.

### Bump de pinning post-upgrade

Tras confirmar PRO operativo, actualizar todos los pines de versión:

- `docker/docker-compose.yml` — `image:` de web + worker
- `infra/cloud-run.yaml` — comment header de versión
- `infra/provision-pro.sh` — default `LANGFUSE_VERSION=`
- `CHANGELOG.md` — entrada bajo `[Unreleased]`

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
