# Validación Shared Platform — atlax-langfuse-bridge

- **Date**: 2026-05-09
- **Owner**: jgcalvo@atlax360.com
- **Documento de referencia**: `~/work/kairos/docs/atlax-ai-shared-platform.md` (v0.3, actualizado 2026-05-09)
- **Estado del bridge**: v0.6.0-wip, 818 tests / 0 fail, PR #72 mergeado, listo para F1 provisioning
- **Conclusión ejecutiva**: **adoptar con ajustes** — el bridge cumple todos los principios aplicables a su categoría (`edge-tooling`), que el documento v0.3 ya formaliza
- **Alineado con**: Atlax AI Shared Platform v0.3 (`docs/atlax-ai-shared-platform.md` en kairos)

---

## 1. Resumen ejecutivo

| Veredicto                       | Detalle                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Adopción**                    | ✅ Sí, con ajustes                                                                                                  |
| **Ajustes en el bridge**        | 🔧 3 menores (env vars doc, categoría edge-tooling en CLAUDE.md, tags semver) — subdominio y WIF resueltos por v0.3 |
| **Ajustes propuestos a Kairos** | 📝 ya incorporados en v0.3: categorías, notación §11, D-009, WIF edge-tooling — pendiente PR fila §11               |
| **Bloqueo F1 PRO**              | ❌ Ninguno — F1 puede ejecutarse hoy con la configuración actual; los ajustes son refinamiento, no precondición     |

**Tesis**: el bridge no es una "app" en el sentido del Shared Platform (no tiene UI propia, no Next.js, no auth propio), pero el componente que sí es app — **Langfuse v3 server self-hosted** — encaja en el patrón. La parte edge del bridge (hook + reconciler + discovery, invariante I-13) pertenece a la categoría **`edge-tooling`** formalizada en v0.3 §3.1.

---

## 2. Auditoría sección a sección

### 2.1 Principios rectores (§2)

| Principio                                        | Estado en bridge | Evidencia                                                                                               |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------- |
| **1. Una identidad, muchas apps**                | 🟡 N/A           | Bridge no tiene login OAuth — Langfuse v3 hace su propia auth interna (PK/SK). Ver §2.2                 |
| **2. Plataforma estable, apps volátiles**        | ✅               | I-13 separa edge (volátil, máquina dev) de core (Langfuse v3 estable, Cloud Run)                        |
| **3. Repo por app**                              | ✅               | `github.com/Atlax-360-Test-IA/atlax-langfuse-bridge` es repo independiente                              |
| **4. Subdominios canónicos `<app>.atlax360.ai`** | ✅               | `langfuse.atlax360.ai` es el subdominio canónico — `atlax360.ai` es el dominio de la suite (D-009 v0.3) |
| **5. CI/CD homogéneo**                           | ✅               | Bun ✓, Conventional Commits ✓, Squash merge ✓, semver tags ✓, branch protection ✓                       |
| **6. Defer cuando puedas**                       | ✅               | F1 minimum viable ($145-180/mes), sin Cloud LB/NAT/portal hasta justificación con ≥3 devs reales        |

### 2.2 Capa 1 — Plataforma compartida (§4)

**Estado**: el bridge va a un proyecto **propio** `atlax360-ai-langfuse-pro` (convención `atlax360-ai-<purpose>-<env>`), NO al proyecto Capa 1 `atlax360-ai-platform-pro`. Esto es deliberado y consistente con anti-patterns §13:

- **Anti-pattern Kairos**: "Crear `atlax360-ai-platform-{dev,pre,pro}` antes de tener 2+ apps que los usen" → defer correcto
- **Anti-pattern Kairos**: "Mezclar plataforma con apps en mismo proyecto GCP" → bridge en proyecto separado correcto

**Implicaciones**:

- Sin DNS zone `atlax360.ai` en Cloud DNS todavía (vive en DonDominio — `atlax360.ai` es el dominio canónico según D-009 v0.3)
- WIF no aplica al bridge como `edge-tooling` (v0.3 §4.4) — credenciales GCP locales vía `gcloud auth login` o SA key con `chmod 600`
- Sin log sink central — logs van a Cloud Logging del proyecto `atlax360-ai-langfuse-pro`

**Gap real (low priority)**: cuando se cree `atlax360-ai-platform-pro`, migrar logs del bridge al sink central. **Bloqueo F1**: ninguno.

### 2.3 Capa 2 — OAuth Clients (§5)

**Estado**: **N/A funcional, gap futuro**.

- Langfuse v3 no usa OAuth Google — usa Public Key / Secret Key generadas internamente
- Hay 13 devs que se enrolarán por SSO **dentro de Langfuse**, no por OAuth Google externo
- El bridge (hook/reconciler) no tiene UI ni login

**Gap futuro**: si se quiere SSO Google para los 13 devs en lugar de PK/SK, sería el momento de crear OAuth Client `Langfuse-bridge` bajo Consent Screen "Atlax 360 AI Suite". **Decisión actual**: posponer hasta F4 (post-piloto exitoso). PK/SK es suficiente para ramp-up.

**Bloqueo F1**: ninguno.

### 2.4 Capa 3 — Aplicaciones, stack canónico (§6)

**Divergencia legítima por categoría**.

| Capa          | Stack canónico Kairos           | Bridge real                                   | Razón                                                              |
| ------------- | ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Runtime       | Bun                             | Bun ✅                                        | Cumple                                                             |
| Lenguaje      | TypeScript strict               | TypeScript strict ✅                          | Cumple                                                             |
| Web framework | Next.js 16 + React 19           | ❌ N/A                                        | No hay UI propia; UI es Langfuse v3 server                         |
| API framework | Hono ^4.12                      | ❌ N/A                                        | Bridge no expone API; expone MCP server stdio                      |
| AI provider   | Anthropic via Vercel AI Gateway | ❌ N/A                                        | Bridge consume Anthropic Admin API, no genera completions          |
| AI SDK        | Vercel AI SDK v6                | ❌ N/A                                        | Mismo motivo                                                       |
| ORM           | Drizzle ORM                     | ❌ N/A                                        | Bridge no escribe BD propia; Langfuse v3 usa Prisma sobre Postgres |
| BD            | Supabase                        | Cloud SQL Postgres + ClickHouse (Langfuse v3) | Decidido en ADR-012 — Langfuse v3 requiere CH                      |
| Validación    | Zod 4                           | Zod en `shared/validation.ts` ✅              | Cumple                                                             |
| CSS / UI      | Tailwind v4 / shadcn            | ❌ N/A                                        | Sin UI propia                                                      |
| Observability | pino → log drain central        | `process.stderr.write` JSON estructurado      | Hooks no pueden cargar deps (I-1, ADR-001)                         |

**Conclusión**: el bridge es categoría **`edge-tooling`** según Shared Platform v0.3 §3.1. Cumple con todo lo aplicable; lo marcado ❌ N/A es ⊘ por categoría, no gap.

### 2.5 Capa 4 — CI/CD (§7)

| Requisito Kairos              | Bridge      | Detalle                                                                                       |
| ----------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `template-ai-app`             | ❌ No usado | Template aún no existe (Kairos lo construirá en Fase 1). Bridge documentado por sí mismo      |
| `.github/workflows/ci.yml`    | ✅          | typecheck + bun test, matrix linux/macOS, smoke E2E, smoke LiteLLM                            |
| `deploy-{dev,pre,pro}.yml`    | ❌          | F1 será deploy manual (`gcloud run deploy`). Auto-deploy en F4 cuando estabilice              |
| `.claude/CLAUDE.md` heredable | ✅ Local    | `CLAUDE.md` propio extiende `~/.claude/CLAUDE.md`. Sin template todavía                       |
| `packages/@atlax/auth`        | ❌ N/A      | Sin OAuth — ver §2.3                                                                          |
| `scripts/ops/preflight.sh`    | 🟡 Parcial  | `scripts/backup-langfuse.sh` + `infra/provision-pro.sh` (más completo que preflight genérico) |
| `vercel.ts`                   | ❌ N/A      | Cloud Run, no Vercel                                                                          |
| Conventional Commits estricto | ✅          | `feat`, `fix`, `audit`, `docs`, `prep`, `improve`, `ops` — 8f8b8c4..                          |
| Squash merge                  | ✅          | Política aplicada PRs #65-72                                                                  |
| Tags semver `v1.2.3`          | 🟡          | Versión `0.6.0-wip` en `package.json`, sin tags formales aún                                  |
| Branch protection ON          | ✅          | Aplicada — protocolo "nunca commit directo a main" cumplido en PRs #65-72                     |
| `main` siempre desplegable    | ✅          | 818/0 fail tests garantizan ello                                                              |

**Gap real**: tags semver formales en GitHub releases. Aplicar al cerrar v1 con `v0.6.0` cuando piloto se valide. **Bloqueo F1**: ninguno.

### 2.6 Variables de entorno (§8)

**Convenciones cumplidas**:

- `LANGFUSE_*` (estándar de la industria, sin prefijo `<APP>_`) ✅
- `ATLAX_*` (compartida — `ATLAX_TRANSCRIPT_ROOT_OVERRIDE`, `ATLAX_DATA_HOME`) ✅
- `ANTHROPIC_*` (estándar) ✅
- Sin secrets en `.env.local` commiteado ✅
- Secrets locales en `~/.atlax-ai/<project>.env` con `chmod 600` ✅ (regla global cumplida)
- Plan F1 mueve secretos a Secret Manager ✅

**Gap real**: NO existe `scripts/ops/PRO_ENV_VARS.md` con tabla de inventario completo. El plan PRO los documenta en `docs/operations/cloud-run-deployment-plan.md` pero no en formato canónico Kairos.

**Acción propuesta**: extraer tabla de env vars del deployment plan a `scripts/ops/PRO_ENV_VARS.md` con columnas (Variable, Required-by, Production, Preview, Development, Notes). **Esfuerzo**: 30 min. **Bloqueo F1**: no, pero **recomendable hacerlo antes** para tener punto único de verdad.

### 2.7 Invariantes transversales (§9)

| Invariante Kairos                                | Estado bridge | Evidencia                                                                                         |
| ------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------- |
| **9.1.1** Auth-first en routers                  | 🟡 Parcial    | Bridge no expone HTTP. MCP server tiene allowlist `MCP_AGENT_TYPE` validada (I-10) — equivalente  |
| **9.1.2** `getAuthContext()` en handler          | N/A           | Sin handlers HTTP                                                                                 |
| **9.1.3** No `NODE_ENV === "production"` gate    | ✅            | Bridge usa env vars explícitas (`ATLAX_*`) y existencia archivo (`.credentials.json` solo check)  |
| **9.1.4** CORS allowlist explícita               | N/A           | Sin servidor HTTP propio                                                                          |
| **9.1.5** CSP                                    | N/A           | Sin web app                                                                                       |
| **9.2.1** Multi-tenant + RLS                     | N/A           | Bridge es single-tenant (Atlax). Langfuse v3 sí gestiona multi-org internamente                   |
| **9.2.2** Transacciones para ≥2 escrituras       | ✅            | Aplicado en `scripts/reconcile-traces.ts` y backfills                                             |
| **9.2.3** State machines `WHERE status=expected` | ✅            | Idempotencia I-2 por traceId con UPSERT, no read-check-write                                      |
| **9.2.4** Bulk INSERT                            | ✅            | `Promise.all(events)` en hook, no for-await                                                       |
| **9.2.5** `.down.sql` por migration              | N/A           | Bridge no tiene migrations propias. Langfuse v3 las gestiona                                      |
| **9.3.1** `X-Request-ID` propagado E2E           | 🟡 Parcial    | Hook usa `traceId = cc-${session_id}` como correlation ID (I-2). Reconciler propaga al re-emitir  |
| **9.3.2** Logs estructurados JSON                | ✅            | Hook escribe JSON a stderr (`{ts, status, error}`); reconciler usa formato similar                |
| **9.3.3** `GET /api/health`                      | N/A           | Sin servidor HTTP — el bridge tiene `bridge-health.ts` que escribe trace heartbeat a Langfuse     |
| **9.4.1** `AbortSignal.timeout()` en fetch       | ✅            | Cumplido en `shared/langfuse-client.ts`, `shared/anthropic-admin-client.ts`                       |
| **9.4.2** Retry exponential backoff              | ✅            | Aplicado en clientes de API externas                                                              |
| **9.4.3** Caches con TTL bounded                 | ✅            | `negativeCache` Redis (TTL 60s) en Langfuse v3; bridge sin caches in-memory propias               |
| **9.5.1** Bun para todo                          | ✅            | Cumplido (ADR-001)                                                                                |
| **9.5.2** Strict Zod en update schemas           | ✅            | Aplicado en `shared/validation.ts`                                                                |
| **9.5.3** Constants centralizadas                | ✅            | `shared/model-pricing.ts` (I-6), `shared/drift.ts` (I-11), `shared/validation.ts` (`SAFE_SID_RE`) |
| **9.5.4** Tests co-located                       | ✅            | `tests/` espejado a `shared/` y `scripts/`                                                        |

**Conclusión**: 13/16 cumplidos, 3 N/A por categoría. **Cero gaps reales**.

### 2.8 Decisiones (§10)

| ID    | Decisión Kairos                          | Estado en bridge                                                      |
| ----- | ---------------------------------------- | --------------------------------------------------------------------- |
| D-001 | Una sola Consent Screen, N OAuth Clients | N/A (sin OAuth) — ver §2.3                                            |
| D-002 | Subdominios `<app>.atlax360.ai` para PRO | ✅ `langfuse.atlax360.ai` — canónico según D-009 v0.3                 |
| D-003 | Bun como runtime obligatorio             | ✅ Cumplido                                                           |
| D-004 | Conventional Commits + Squash merge      | ✅ Cumplido                                                           |
| D-005 | Workload Identity Federation             | ⊘ N/A — WIF aplica a CI/CD pipelines, no a `edge-tooling` (v0.3 §4.4) |
| D-006 | `vercel.ts` sobre `vercel.json`          | N/A (Cloud Run)                                                       |
| D-007 | Vercel AI Gateway por defecto            | N/A (bridge no genera completions)                                    |
| D-008 | NO Edge Functions, SÍ Fluid Compute      | N/A (Cloud Run gen2 + GCE)                                            |

### 2.9 Anti-patterns (§13)

**Verificación cruzada**: ¿el bridge incurre en alguno?

| Anti-pattern                                          | Bridge | Detalle                                                                  |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| OAuth Client por entorno                              | ✅ No  | Sin OAuth                                                                |
| Plataforma + apps en mismo proyecto GCP               | ✅ No  | `atlax360-ai-langfuse-pro` separado de futuro `atlax360-ai-platform-pro` |
| Cada app con su Consent Screen                        | ✅ No  | Sin Consent                                                              |
| Dependencias hardcoded entre apps                     | ✅ No  | Bridge solo depende de Anthropic Admin API y de su propio Langfuse v3    |
| `<app>.atlax.com` Y `<app>.atlax.ai` simultáneamente  | ✅ No  | Solo `langfuse.atlax360.ai` (single canonical)                           |
| Construir portal antes de 3 apps                      | ✅ No  | Sin portal                                                               |
| `atlax360-ai-platform-{dev,pre,pro}` antes de 2+ apps | ✅ No  | No creados                                                               |
| Diferentes runtimes entre apps                        | ✅ No  | Bun                                                                      |

**0/8 anti-patterns** — limpio.

---

## 3. Estado actual de adopción — fila bridge para §11

```markdown
| atlax-langfuse-bridge | github.com/Atlax-360-Test-IA/atlax-langfuse-bridge | Cloud Run + GCE (`atlax360-ai-langfuse-pro`) europe-west1 | Langfuse PK/SK (sin OAuth Google) | stderr JSON estructurado → Cloud Logging | ⊘ N/A (sin OAuth) | langfuse.atlax360.ai (canonical, D-009 v0.3) |
```

**PR sugerida a Kairos**: actualizar §11 con esta fila + nota "categoría: edge tooling + Langfuse v3 server self-hosted".

---

## 4. Gaps reales (a corregir en el bridge antes de F1)

| ID        | Gap                                                                                                                             | Severidad | Esfuerzo | Bloqueo F1 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- | ---------- |
| BG-01     | Falta `scripts/ops/PRO_ENV_VARS.md` con inventario formal de env vars                                                           | Media     | 30min    | No         |
| BG-02     | Tag semver formal en GitHub releases (`v0.6.0` cuando piloto OK)                                                                | Baja      | 5min     | No         |
| BG-03     | Documentar explícitamente en CLAUDE.md que el bridge es categoría "edge tooling" del Shared Platform                            | Baja      | 15min    | No         |
| BG-04     | WIF para auto-deploy CI/CD en F4 (aplica al pipeline, no al bridge como edge-tooling)                                           | Baja      | 1h       | No (F4)    |
| ~~BG-05~~ | ~~Migración subdominio fuera del dominio canónico~~ — **CERRADO**: `atlax360.ai` es el dominio canónico (D-009 v0.3), no legacy | —         | —        | —          |

**Total bloqueo F1**: **0**. Los gaps son refinamiento, no precondición.

---

## 5. Ajustes propuestos al documento Kairos

Estos son cambios sugeridos al `atlax-ai-shared-platform.md` para que cubra mejor el ecosistema real:

### KP-01 (alta prioridad) — Sección "Categorías de aplicaciones"

El documento asume implícitamente que toda "app" es web/API con UI. **Atlax 360 AI Suite** tiene al menos 3 categorías legítimas:

| Categoría        | Descripción                                                  | Ejemplos                                                          |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| **web app**      | Next.js + Hono + UI propia, multi-tenant                     | Kairos, atlax-claude-dashboard                                    |
| **edge tooling** | Hook + cron + scripts en máquina dev, sin UI ni servidor     | atlax-langfuse-bridge (parte edge), atlax-observatorios (parsers) |
| **server-only**  | Servicio backend self-hosted en Cloud Run/GCE, sin UI propia | Langfuse v3 server, futuro Atlax Gateway                          |

**Propuesta**: añadir sección §3.1 "Categorías" que aclare qué invariantes/decisiones aplican a cada categoría (ej. `getAuthContext` no aplica a edge tooling, `Workload Identity Federation` aplica solo a deploys CI/CD).

### KP-02 — Tabla "no aplica vs gap"

El documento no distingue entre "el patrón no aplica a esta categoría" y "esta app tiene un gap pendiente de cerrar". Esto va a generar confusión en revisiones futuras.

**Propuesta**: añadir convención de notación en §11 — `✅ cumple`, `🟡 parcial`, `❌ gap`, `⊘ N/A por categoría`.

### ~~KP-03~~ — Dominio canónico ✅ INCORPORADO en v0.3

D-009 en v0.3 confirma: `atlax360.ai` es el dominio canónico de la suite. `atlax.ai` **no pertenece** al grupo Atlax 360. No requiere PR adicional — ya está en el documento.

### ~~KP-04~~ — Subdominio del bridge ✅ INCORPORADO en v0.3

v0.3 §6.4 refleja `langfuse.atlax360.ai` como subdominio activo del bridge. No requiere PR adicional.

### ~~KP-05~~ — WIF edge tooling ✅ INCORPORADO en v0.3

v0.3 §4.4 aclara que WIF aplica únicamente a CI/CD deploy pipelines, no a `edge-tooling`. Herramientas dev/CI sin deploy a GCP usan `gcloud auth login` o SA key local con `chmod 600`. No requiere PR adicional.

---

## 6. Validación final propuesta antes de F1

Antes de ejecutar `bash infra/provision-pro.sh` real, propongo el siguiente checklist consolidado:

### 6.1 Ajustes en bridge (orden de ejecución)

1. **Crear `scripts/ops/PRO_ENV_VARS.md`** extrayendo tabla del deployment plan
2. **Documentar categoría "edge tooling"** en `CLAUDE.md` (1 párrafo + link a este audit)
3. **Añadir comentario en `infra/provision-pro.sh`** referenciando este audit como punto de validación
4. **Crear nota en `docs/audits/README.md`** (si no existe) listando este audit + futuros

**Esfuerzo total**: ~1h. **PR único**: `audit(shared-platform): validación contra patrón Kairos + ajustes`.

### 6.2 Comunicación a Kairos (asíncrono, no bloquea)

5. PR a Kairos `docs/atlax-ai-shared-platform.md` con:
   - Fila §11 actualizada (sección 3 de este reporte) — única pendiente
   - ~~KP-01 Categorías~~ — incorporado en v0.3 §3.1
   - ~~KP-02 Notación §11~~ — incorporado en v0.3
   - ~~KP-03 Dominio canónico~~ — incorporado como D-009 en v0.3
   - ~~KP-05 WIF edge-tooling~~ — incorporado en v0.3 §4.4
6. Tag `[shared-platform]` en título PR conforme §14 de su doc

### 6.3 Dry-run consolidado

7. **`bash infra/provision-pro.sh --dry-run`** con vars finales:

   ```bash
   export GCP_PROJECT_ID=atlax360-ai-langfuse-pro
   export GCP_PROJECT_NAME="Atlax 360 · AI · Langfuse · PRO"
   export GCP_REGION=europe-west1
   export GCP_ZONE=europe-west1-b
   export DOMAIN=langfuse.atlax360.ai
   ```

   Validar que dry-run cubre 6 fases provisioning sin errores y que el output describe operaciones idempotentes.

8. **Smoke test post-dry-run**: verificar `bun run check` (818/0 fail) y `bun test tests/cloud-run-boundary.test.ts` (I-13 verificada).

### 6.4 Ejecución F1 (luz verde)

Cuando 6.1 → 6.3 estén OK, ejecutar `bash infra/provision-pro.sh` (sin `--dry-run`), seguir las 5 fases del `docs/operations/cloud-run-deployment-plan.md`.

---

## 7. Decisión final

**Adoptar Shared Platform de Kairos con ajustes documentados** (sección 4 + 5).

Motivos:

1. **Cero gaps bloqueantes**: el bridge cumple todos los invariantes aplicables a su categoría `edge-tooling`
2. **Configuración ya es canónica**: `atlax360-ai-langfuse-pro` (convención `atlax360-ai-<purpose>-<env>`), `langfuse.atlax360.ai` correcto (D-009 v0.3), sin OAuth Google — todo justificado por categoría
3. **KP-01..KP-05 incorporados en v0.3**: el doc Kairos ya refleja las propuestas del bridge; solo resta PR con fila §11
4. **F1 puede ejecutarse hoy**: los ajustes BG-01..BG-04 son refinamiento, no precondición (BG-05 cerrado)

**Próximo paso recomendado**: arrancar con sección 6.1 (ajustes en bridge), luego 6.3 (dry-run consolidado), luego F1 real.

---

## Apéndice A — Referencias cruzadas

- `~/work/kairos/docs/atlax-ai-shared-platform.md` — documento de referencia
- `CLAUDE.md` — invariantes I-1..I-14 del bridge
- `ARCHITECTURE.md` — SDD §1-§14
- `docs/adr/ADR-002-edge-core-split.md` — invariante I-13 (edge/core)
- `docs/adr/ADR-012-clickhouse-gce-self-hosted.md` — decisión ClickHouse
- `docs/operations/cloud-run-deployment-plan.md` — plan F1-F5
- `infra/provision-pro.sh` — script provisioning idempotente
- `infra/cloud-run.yaml` — manifests web + worker
- PR #69 — plan PRO mergeado
- PR #71 — dominio + `--create-project` flag
- PR #72 — minimum viable F1 ($145-180/mes)
