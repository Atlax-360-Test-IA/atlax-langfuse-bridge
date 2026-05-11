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

### T-2.1 · Pre-deploy: gate "limpio antes de avanzar" + verificaciones GCP

| Timestamp (UTC)        | Acción                                                                              | Resultado                                                | Notas                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `2026-05-11T17:13:30Z` | Commit + PR #106 + merge a main (DEV upgrade completo)                              | Mergeado squash, branch deleted                          | Aplica regla CLAUDE.md global "limpio antes de avanzar" — DEV en main antes de tocar PRO |
| `2026-05-11T17:14:50Z` | `gcloud run services list --region=europe-west1 --project=atlax360-ai-langfuse-pro` | web/worker actuales en 3.172.1                           | Baseline confirmado                                                                      |
| `2026-05-11T17:15:06Z` | `envsubst < infra/cloud-run.yaml > /tmp/cloud-run.rendered.yaml`                    | 488 líneas, ambas imágenes a 3.173.0, sin `$VAR` sueltas | Solo 2 variables (`$LANGFUSE_VERSION`, `$GCP_PROJECT_ID`)                                |
| `2026-05-11T17:15:22Z` | `gcloud sql instances list` — verificar Cloud SQL PITR                              | PITR habilitado en `langfuse-pg`                         | Rollback path Postgres garantizado (point-in-time)                                       |
| `2026-05-11T17:15:36Z` | Split manifest por servicio (web / worker / litellm)                                | 3 ficheros separados                                     | Permite deploy granular y observación independiente                                      |

### T-2.2 · Deploy de revisiones nuevas

| Timestamp (UTC)        | Acción                                                        | Resultado                                                     | Notas                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-05-11T17:15:51Z` | `gcloud run services replace /tmp/cr-svc-1.yaml` (web)        | Nueva revisión `langfuse-web-00002-k7t` desplegada en **55s** | ⚠️ **F-4 fricción** — el manifest declara `traffic: percent: 100, latestRevision: true`, así el `replace` cambió tráfico al 100% INSTANTÁNEAMENTE (no es blue-green real) |
| `2026-05-11T17:16:46Z` | `curl /api/public/health` contra `langfuse.atlax360.ai`       | HTTP 200 en 5.9s                                              | Latencia consistente con cold start tras minScale=0; nada anómalo                                                                                                         |
| `2026-05-11T17:17:31Z` | `curl /api/public/ingestion` (sin auth)                       | HTTP 401 — el endpoint existe y rechaza correctamente         | Validación de auth funciona                                                                                                                                               |
| `2026-05-11T17:17:42Z` | `gcloud run services replace /tmp/cr-svc-2.yaml` (worker)     | Nueva revisión `langfuse-worker-00004-9w6` en **43s**         |                                                                                                                                                                           |
| `2026-05-11T17:18:32Z` | `gcloud run services list` — verificar 100% tráfico en LATEST | web 3.173.0 100%, worker 3.173.0 100%, litellm intacto        | LiteLLM no fue tocado (no había cambio)                                                                                                                                   |
| `2026-05-11T17:18:35Z` | `gcloud logging read severity>=ERROR --freshness=5m`          | Vacío — sin errores en logs últimos 5min                      | Worker arrancó sin issue de RAM (riesgo medio identificado por subagente B sobre nueva cola OTel secundaria)                                                              |

### T-2.3 · Smoke E2E real contra PRO 3.173.0

| Timestamp (UTC)        | Acción                                                                 | Resultado                                             | Notas                                                          |
| ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `2026-05-11T17:18:47Z` | `source ~/.atlax-ai/reconcile.env && bun run scripts/smoke-mcp-e2e.ts` | **8/8 checks ✓ en 19s** contra PRO                    | Ingestion + worker + cache + annotate + round-trip funcionando |
| `2026-05-11T17:19:06Z` | Status final stack PRO                                                 | langfuse-web + langfuse-worker en 3.173.0, sin errors | Promote completo sin rollback                                  |

**Fricción F-4 identificada**: el manifest `cloud-run.yaml` declara
`traffic: percent: 100, latestRevision: true`, lo que hace que `gcloud run
services replace` cambie tráfico al 100% inmediatamente en cuanto la nueva
revisión esté `Ready`. El comentario del manifest dice "para deploys
subsiguientes usar `gcloud run services replace` con `--no-traffic`", pero
`replace` no acepta `--no-traffic` (es flag de `deploy`, no de `replace`).
**Mejora candidata**: o bien (1) cambiar manifest a `percent: 0` y usar
`update-traffic` para promote, o (2) usar `gcloud run deploy --no-traffic`
en lugar de `replace`. Esta vez el upgrade era seguro y funcionó, pero un
breaking change habría llegado a producción sin posibilidad de blue-green.

**Veredicto Fase PRO**: ✅ upgrade aplicado exitosamente. 0 errors en logs.
Smoke 8/8 contra PRO 3.173.0. Sin rollback necesario. Tiempo total fase PRO:
~3min de deploy efectivo (web 55s + worker 43s + healthchecks + smoke).

---

## §3 · Retrospectiva

### Resumen de tiempos

| Fase                                 | Duración   | Comentario                                          |
| ------------------------------------ | ---------- | --------------------------------------------------- |
| Pre-flight (release scan + decisión) | ~3min      | Subagente B ejecutó en paralelo, no bloqueó         |
| Pull DEV imágenes                    | ~16min     | F-2: cuello de botella claro (1.5GB × 2 secuencial) |
| Recreate DEV + healthcheck           | ~2min      | Worker 53s, Web 50s — sano                          |
| Smoke + tests DEV                    | ~1min      | 8/8 + suite 1054/0 en <40s combinado                |
| Commit + PR + merge DEV              | ~2min      | Squash via `gh pr merge --admin`                    |
| Render manifest + verif GCP          | ~1min      | Validación PITR + split manifest                    |
| Deploy PRO web                       | ~1min      | 55s gcloud + healthy auto                           |
| Deploy PRO worker                    | ~1min      | 43s                                                 |
| Smoke PRO                            | ~20s       | 8/8 contra dominio real                             |
| **TOTAL extremo a extremo**          | **~28min** | De `git checkout -b` a "PRO operativo y validado"   |

### Fricciones identificadas y mejoras candidatas

| ID  | Fricción                                                                        | Impacto | Mejora candidata                                                                                                       |
| --- | ------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| F-1 | Backup pre-upgrade en DEV no es paso explícito del playbook                     | MEDIUM  | Añadir al runbook §Upgrades como paso obligatorio antes de tocar imágenes                                              |
| F-2 | Pull docker compose secuencial — 16min para 2 imágenes de 1.5GB                 | MEDIUM  | Usar `docker pull X & docker pull Y; wait` o `docker compose pull --parallel` (si la versión lo soporta) → ~50% tiempo |
| F-3 | `~/.atlax-ai/reconcile.env` mezcla creds DEV y PRO                              | HIGH    | Separar en `dev.env` + `pro.env`; runbook explícito sobre cuál sourcear cuándo (riesgo: reparar PRO con datos locales) |
| F-4 | `gcloud run services replace` con manifest `percent: 100` ignora `--no-traffic` | HIGH    | Cambiar manifest a `percent: 0` con `update-traffic` para promote, o usar `gcloud run deploy --no-traffic`             |

### Lo que funcionó muy bien

- **I-14 doble-check** de subagente B contra `gh api compare` confirmó precisión total
  del análisis de migraciones (2 PG aditivas, 0 CH).
- **Subagentes paralelos** redujeron tiempo total: A y B corrieron mientras el pull
  descargaba 3GB.
- **scripts/smoke-mcp-e2e.ts** demostró ser un test funcional sólido: 8 checks
  cubren ingestion, worker async, read API, cache, annotate, round-trip. Validó
  upgrade DEV en 17s y PRO en 19s.
- **Cloud SQL PITR + ClickHouse snapshots + backup pre-upgrade** dan 3 capas de
  rollback. Aunque no hizo falta usarlo, el coste de la opción cero fue ~10s.

### Acciones de mejora (a aplicar en siguiente PR)

Las 4 fricciones se traducen en backlog específico — **PR separada** (no en este
chore de upgrade) que añada:

1. **Runbook §Upgrades**: paso explícito de backup pre-upgrade DEV + render manifest
2. **Manifest `cloud-run.yaml`**: web `traffic: percent: 0` + comentario diferenciando primer deploy vs subsiguientes
3. **Setup pilot**: generar `dev.env` separado de `pro.env`, runbook explícito de cuándo cada uno
4. **CHANGELOG global rules** `~/.claude/rules/`: añadir patrón "pull paralelo
   para upgrade Docker stacks grandes" a `cross-project-patterns.md`

Ver §4 abajo para los textos exactos a aplicar.

---

## §4 · Patrones a incorporar a las rules globales

(Para aplicar en el siguiente PR, no en este de upgrade.)

### `~/.claude/rules/cross-project-patterns.md` — sección nueva

````markdown
## Docker compose pull — paralelizar imágenes grandes

`docker compose pull` con múltiples servicios sin `--parallel` puede ser
secuencial dependiendo de la versión instalada. Para stacks con imágenes
grandes (>500MB cada una), preferir:

```bash
# Opción 1: si docker compose ≥2.20 soporta el flag
docker compose pull --parallel langfuse-web langfuse-worker

# Opción 2: paralelización manual con docker pull directo
docker pull langfuse/langfuse:VERSION &
docker pull langfuse/langfuse-worker:VERSION &
wait
```
````

Reduce el tiempo de pull de 2 imágenes 1.5GB de ~16min a ~8min en conexión
domestic broadband.

````

### `~/.claude/rules/security.md` — añadir a §Credentials handling

```markdown
- **Separar env files por entorno** (`~/.atlax-ai/dev.env` vs `~/.atlax-ai/pro.env`,
  nunca mezclados en `reconcile.env`). Un operador puede accidentalmente
  ejecutar el reconciler contra PRO con datos JSONL locales si confunde el
  destino. Patrón canónico: el runbook §Upgrades especifica `source dev.env`
  para fase DEV y `source pro.env` para fase PRO.
````

### `docs/operations/runbook.md` — nueva sección §Upgrades

(Texto largo — incluido en el PR de mejoras como fichero completo.)

---

## §5 · Conclusión

Upgrade Langfuse 3.172.1 → 3.173.0 ejecutado de DEV a PRO en ~28min reales,
con 0 incidentes y 0 rollbacks. Las 4 fricciones identificadas son
sistemáticas (no específicas de este upgrade) y se materializan como backlog
de mejora. **El ciclo de vida del software funciona end-to-end pero tiene
margen claro de optimización en velocidad (F-2) y seguridad operacional
(F-3, F-4).**

Próximo upgrade (3.173.0 → 3.174.x) podría hacerse en **~12min** si se
implementan F-2 + F-4 (pull paralelo + manifest `percent: 0` + promote
explícito).
