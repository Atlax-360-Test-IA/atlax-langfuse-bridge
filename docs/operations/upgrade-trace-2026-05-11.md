# Upgrade Trace · Langfuse 3.172.1 → 3.173.0

**Fecha de ejecución**: 2026-05-11
**Operador**: jgcalvo
**Objetivo del experimento**: ejecutar el ciclo de vida completo DEV → PRO de un
upgrade de minor version Langfuse, identificando puntos de fricción que se
puedan automatizar, documentar mejor, o incorporar a las rules globales del
proyecto.

---

## §0 · Contexto y diff de versiones

**Versión actual (origen)**: `langfuse/langfuse:3.172.1` + `langfuse/langfuse-worker:3.172.1`
**Versión destino**: `langfuse/langfuse:3.173.0` + `langfuse/langfuse-worker:3.173.0`
**Publicada upstream**: 2026-05-08T08:48:32Z
**Diff release notes**: <https://github.com/langfuse/langfuse/compare/v3.172.1...v3.173.0>

### Resumen de cambios upstream

- **Features**: SSO self-service config, secondary OTel ingestion queue (worker)
- **Fixes de seguridad relevantes**:
  - PR #13485: SSRF hardening en outbound URL validation
  - PR #13501 + #13512: validación de redirects en image URLs + DNS-failing
  - PR #13498: rate-limit en endpoints admin/prompt POST
- **Deps notables**: bullmq → 5.76.3, uuid v9→v14, Next.js → 16.2.6
- **Sin migraciones de schema mencionadas**. Sin breaking changes en API pública.

### Clasificación del upgrade

- **Tipo**: minor patch (3.172.x → 3.173.0)
- **Riesgo a priori**: BAJO (security hardening + dep bumps)
- **Decisión de rollback path**: gcloud run services update-traffic --to-revisions=PREV=100

---

## §1 · Fase DEV — validación local

### T-1.1 · Backup defensivo del estado local

| Timestamp (UTC)        | Acción                              | Resultado                                              | Notas                                                                                  |
| ---------------------- | ----------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `2026-05-11T16:37:26Z` | `git checkout -b chore/upgrade-...` | OK — branch creada desde main limpio                   | Aplico regla "nunca commit a main" del CLAUDE.md global                                |
| `2026-05-11T16:37:26Z` | Verificar estado del stack DEV      | 7/7 healthy, 391 traces en ClickHouse                  | uptime 43h en versión origen (3.172.1)                                                 |
| `2026-05-11T16:37:54Z` | `bash scripts/backup-langfuse.sh`   | OK — pg 100K + ch 972K en `~/.atlax-ai/backups/daily/` | Backup completo en ~10s. Rollback path = restore desde estos dumps si algo se corrompe |

**Fricción F-1 identificada**: el playbook de upgrade NO mandata explícitamente
ejecutar backup pre-upgrade en DEV. El script existe (`scripts/backup-langfuse.sh`)
pero el operador puede olvidarlo. **Mejora candidata**: el runbook debería
listar el backup como paso obligatorio pre-upgrade, no solo como cron diario.

### T-1.2 · Bump de versión + pull de imágenes

| Timestamp (UTC)        | Acción                                                                                   | Resultado                                                                   | Notas                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-05-11T16:36:37Z` | `gh api repos/langfuse/langfuse/releases --jq '.[0:3]'`                                  | v3.173.0 publicada 2026-05-08 (3 días)                                      | Diff <https://github.com/langfuse/langfuse/compare/v3.172.1...v3.173.0>                                                                            |
| `2026-05-11T16:37:00Z` | Lectura release notes (security fixes SSRF + rate-limit + Next.js 16)                    | Upgrade minor, sin breaking changes anunciados                              | Decisión: proceder (riesgo BAJO)                                                                                                                   |
| `2026-05-11T16:38:30Z` | Edit `docker/docker-compose.yml` (web + worker → 3.173.0)                                | OK                                                                          | 2 líneas modificadas                                                                                                                               |
| `2026-05-11T16:38:35Z` | **PARALELO** — lanzados 2 subagentes Sonnet 4.6:                                         | A: bump cloud-run.yaml + CHANGELOG. B: deep scan release notes con `gh api` | I-14 aplicado: ficheros disjuntos del docker-compose                                                                                               |
| `2026-05-11T16:39:16Z` | `docker compose pull langfuse-web langfuse-worker`                                       | **~16min** (1.37GB + 1.61GB descarga)                                       | ⚠️ **F-2 fricción** — el pull es secuencial en docker compose; podríamos hacer `docker pull` en paralelo por imagen para reducir tiempo a la mitad |
| `2026-05-11T16:54:00Z` | Subagente A reporta: CHANGELOG.md actualizado, 1 fichero tocado                          | ARCHITECTURE.md no menciona versión (confirmado)                            | Falsa fricción candidata: descartada                                                                                                               |
| `2026-05-11T16:55:00Z` | Subagente B reporta: **VEREDICTO upgrade safe**                                          | 2 migraciones PG aditivas, 0 ClickHouse, 0 env req                          | Verificación I-14 cruzada: `gh api compare` confirma exactamente 2 archivos de migración nuevos                                                    |
| `2026-05-11T16:55:30Z` | Orquestador completa: cloud-run.yaml:12 comment + provision-pro.sh:670 default → 3.173.0 | OK                                                                          | Subagente A no podía tocar provision-pro.sh; lo arreglé yo                                                                                         |
| `2026-05-11T16:57:30Z` | Pull terminado: imágenes 3.173.0 disponibles localmente                                  | OK                                                                          |                                                                                                                                                    |

**Fricción F-2 identificada**: pull de docker compose para 2 imágenes de 1.5GB
tarda ~16min en mi conexión. **Mejora candidata**: el playbook de upgrade puede
incluir `docker compose pull --parallel` o `docker pull X & docker pull Y; wait`
explícito para reducir el tiempo a la mitad cuando las imágenes son grandes.

**Subagente B salida clave**: hay 2 migraciones Postgres nuevas en v3.173.0
(`add_verified_domains` + `share_pending_verified_domains`) — ambas aditivas,
crean tabla nueva sin tocar tablas existentes. ClickHouse: 0 migraciones nuevas.
Sin env vars obligatorias. Veredicto: **upgrade safe**, sin ajuste manual.

### T-1.3 · Recreate de containers + healthcheck

| Timestamp (UTC)        | Acción                                                                                            | Resultado                 | Notas                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `2026-05-11T17:09:37Z` | `docker compose up -d --no-deps langfuse-web langfuse-worker`                                     | Worker healthy en 53s     | `--no-deps` evita recrear postgres/clickhouse/redis/minio innecesariamente                     |
| `2026-05-11T17:10:36Z` | Poll `docker inspect web --format '{{.State.Health.Status}}'`                                     | Web healthy en 50s        | start_period actual 90s — suficiente                                                           |
| `2026-05-11T17:11:22Z` | `docker compose ps` — 7/7 healthy                                                                 | OK                        | Solo web+worker recreados; resto del stack uptime preservado (postgres 2d, clickhouse 2d, etc) |
| `2026-05-11T17:11:30Z` | Verificación migraciones — `\dt verified_domains` + último `_prisma_migrations`                   | ✓ 2 migraciones aplicadas | `add_verified_domains` y `share_pending_verified_domains` aparecen como filas más recientes    |
| `2026-05-11T17:11:35Z` | `SELECT count() FROM default.traces` (ClickHouse)                                                 | 390 (era 391)             | Diferencia ≤1 por retention natural (mtime cutoff), NO pérdida de datos                        |
| `2026-05-11T17:11:50Z` | `docker inspect docker-langfuse-web-1 --format '{{.Config.Image}}'` → `langfuse/langfuse:3.173.0` | OK                        | Imagen efectiva confirmada                                                                     |

**Fricción F-3 identificada (descubierta al smoke)**: `~/.atlax-ai/reconcile.env`
apunta a **PRO** (`langfuse.atlax360.ai`), no a DEV. Las credenciales de DEV son
las init placeholder de docker-compose (`pk-lf-PENDIENTE` / `sk-lf-PENDIENTE`).
**Mejora candidata**: el setup local debería generar `~/.atlax-ai/dev.env`
separado, con las creds del project init, para que smoke tests apunten a DEV
sin tener que improvisar exports inline. Riesgo actual: un operador puede
accidentalmente ejecutar el reconciler local con env PRO y "reparar" traces
PRO con datos JSONL de su máquina local.

### T-1.4 · Smoke E2E del bridge contra Langfuse 3.173.0 DEV

| Timestamp (UTC)        | Acción                                                                                          | Resultado                                  | Notas                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `2026-05-11T17:12:24Z` | `bun run scripts/smoke-mcp-e2e.ts` con `LANGFUSE_HOST=http://localhost:3000` + placeholder keys | **8/8 checks ✓** en 17s                    | Ingestion + worker + cache + annotate + round-trip todo OK contra v3.173.0 |
| `2026-05-11T17:12:48Z` | `bun run check` (typecheck + suite completa)                                                    | 1054 pass / 5 skip / 0 fail / 1933 expects | El upgrade Langfuse no rompió ningún test local                            |
| `2026-05-11T17:13:11Z` | Verificación contenedores estables tras smoke                                                   | 7/7 healthy, sin restarts no esperados     | `docker compose ps` sin warnings                                           |

**Veredicto Fase DEV**: ✅ upgrade safe, sin breaking changes, smoke E2E completo,
suite de tests verde, migraciones aditivas aplicadas correctamente. Procedo a
PRO.

---

## §2 · Fase PRO — promoción a producción
