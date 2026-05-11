# Backlog POST-V1 · atlax-langfuse-bridge

> **S24-C** — Lista priorizada de items para después del cierre v1 (post Sprint 24).
> Fecha: 2026-05-07. Criterio de entrada al backlog: ≥3 devs en piloto LiteLLM activos
> durante 2 semanas consecutivas (exit criteria de `docs/operations/pilot-kpis.md`).

---

## Prioridad ALTA — Unblocking para escala del piloto

### ~~PV1-A1 · Upgrade imagen LiteLLM a versión con `user_api_key_user_id` fix~~ ✅ DONE 2026-05-10

- **Completado**: `v1.83.7-stable` → `v1.83.10-stable` (PR #96). `user_api_key_user_id` ya propaga
  el `user_id` de la virtual key. Test S20-C actualizado: assert `== null` → `typeof === "string"`.
- **Redeploy Cloud Run**: ejecutar `gcloud run services replace infra/cloud-run.yaml` en `atlax360-ai-langfuse-pro`.

### PV1-A2 · Distribuir hook a los 13 devs con seat Premium

- **Por qué**: el único usuario activo es jgcalvo. El script está listo y es idempotente.
- **Impacto**: de 1 dev a 13 devs con visibilidad FinOps
- **Effort**: S (operativo) — ejecutar `setup/setup.sh` en cada máquina o distribuir via Ansible
- **Dep**: ninguna técnica; requiere coordinación de equipo

### PV1-A3 · Onboarding LiteLLM de ≥3 devs piloto (S21-B desbloqueado)

- **Por qué**: el gateway está operativo pero sin usuarios reales. S21-B (Cline) quedó
  bloqueado por falta de voluntario. Con devs reales se puede ejecutar.
- **Impacto**: valida el piloto multi-IDE formalmente; desbloquea los KPIs de adopción
- **Effort**: M (2-3d operativos) — onboarding + soporte + monitoreo primera semana
- **Dep**: PV1-A2

---

## Prioridad MEDIA — Extensión de capacidades

### PV1-B1 · Multi-IDE adoption (Cline, Continue, Cursor)

- **Por qué**: el gateway LiteLLM soporta cualquier cliente OpenAI-compatible. Falta
  documentación y testing con IDEs específicos.
- **Impacto**: cobertura de devs que no usan Claude Code CLI
- **Effort**: M por IDE (2-3d cada uno: prueba, doc, smoke test)
- **Dep**: PV1-A3 (al menos 1 dev en piloto con cada IDE)
- **Referencia**: ADR-010 §M3, `docs/operations/litellm-onboarding.md §IDEs alternativos`

### PV1-B2 · Multi-vendor routing en LiteLLM (OpenAI, Vertex, Bedrock)

- **Por qué**: Atlax tiene workloads en Vertex (Gemini) y puede necesitar GPT-5.4.
  LiteLLM ya soporta routing multi-vendor nativamente.
- **Impacto**: visibilidad FinOps unificada para todos los proveedores LLM
- **Effort**: M por vendor (config + pricing + test de callback Langfuse)
- **Dep**: PV1-B1 estable (piloto mono-vendor validado primero)
- **Riesgo**: pricing de proveedores no-Anthropic requiere tabla nueva en
  `shared/model-pricing.ts` o fuente externa

### ~~PV1-D1 · Vertex traces + cost capture (Seat Team quota management)~~ ✅ DONE 2026-05-11

- **Completado**: implementada la opción V2 directamente (omitiendo V1 BigQuery). PR #102.
  Modelos `vertex-claude-sonnet-4-6`, `vertex-claude-haiku-4-5`, `vertex-claude-opus-4-7`
  añadidos al gateway LiteLLM. SA `litellm@atlax360-ai-langfuse-pro` con `roles/aiplatform.user`.
  Secret Manager `litellm-config-yaml` versión 3. Cloud Run revisión `litellm-00006-lj5`.
- **Por qué se saltó V1**: GCP Billing Export atribuye al proyecto GCP, no al developer.
  V2 es la única opción con atribución real per-dev en Langfuse. Coste adicional: $0.
  Decisión formal: [ADR-016](../adr/ADR-016-vertex-via-litellm-gateway.md).
- **Pendiente operativo**: crear virtual keys individuales en `https://litellm.atlax360.ai`
  para cada dev que use Vertex, y actualizar su entorno con `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_API_KEY`. Sin esto la atribución cae en la master key.

### PV1-B3 · Dashboard → Langfuse API (drill-down por sesión)

- **Por qué**: RFC-002 decidió que el dashboard no necesita HTTP del bridge para v1.
  Post-v1, si surge demanda de drill-down por sesión (proyecto, rama, IDE), la vía
  es `atlax-claude-dashboard/packages/core/src/langfuse/` llamando a Langfuse API.
- **Impacto**: el dashboard muestra detalle de sesión individual (branch, proyecto git, tier)
- **Effort**: M (2-3d en dashboard) — cliente Langfuse + route `/api/v1/sessions/:id/detail`
- **Dep**: coordinación con owner de `atlax-claude-dashboard`; sin cambios en bridge
- **Referencia**: RFC-002 §CP-4-v2

### PV1-B4 · `cost-source:api-real` para devs con API-key directa

- **Por qué**: hoy 100% de los traces tienen `cost-source:estimated`. Con
  `ANTHROPIC_ADMIN_API_KEY` el reconciler puede verificar el coste real y taggear
  `cost-source:api-real`. S18-B implementó la integración; falta validación con datos reales.
- **Impacto**: KPI "divergencia estimado vs real" medible con datos reales
- **Effort**: S (1-2d) — validar con una dev que use API-key (no OAuth seat)
- **Dep**: tener al menos 1 dev con `ANTHROPIC_API_KEY` en el piloto

---

## Prioridad BAJA — Calidad y deuda técnica

### ~~PV1-C1 · Cobertura test `scripts/reconcile-traces.ts` → ≥60 %~~ ✅ DONE 2026-05-11

- **Completado**: cobertura subió de ~37% a ≥82% en PRs #99-#101 (sprint S25).
  `tests/reconcile-coverage.test.ts` (+16 tests) cubre ramas de error SAFE_SID_RE,
  cwd-missing, classifyDrift por coste, y path ANTHROPIC_ADMIN_API_KEY. Objetivo
  original (≥60%) superado.

### PV1-C2 · Multi-perfil tracking (PMs, QA, ops)

- **Por qué**: hoy solo devs con Claude Code CLI. PMs usan claude.ai web. La browser
  extension cubre parcialmente este caso.
- **Impacto**: visibilidad FinOps de toda la organización, no solo devs
- **Effort**: L (requiere validación de la browser extension en prod + onboarding no-dev)
- **Dep**: PV1-A2 (hook base estable)

### PV1-C3 · Scope review mensual automatizado

- **Por qué**: la regla global exige revisión mensual de tags `all/applicable/<project>`
  en ADRs e invariantes. Hoy es manual.
- **Effort**: S (1d) — script que lista ADRs sin Scope tag + genera borrador de revisión
- **Dep**: ninguna

### PV1-C4 · CP-1: test cross-validación pricing en CI del dashboard

- **Por qué**: S17-C añadió el test en el bridge. El dashboard no tiene el simétrico.
  Una divergencia de pricing solo se detecta desde el lado del bridge.
- **Effort**: S (1d) — añadir test en `atlax-claude-dashboard` que lee `model-pricing.ts` del bridge
- **Dep**: coordinación con owner del dashboard (cambio en repo hermano)
- **Referencia**: roadmap §10 CP-1

---

## Criterio de entrada al backlog activo

Antes de empezar cualquier item POST-V1, verificar:

1. Exit criteria del piloto cumplidos: ≥3 devs × 2 semanas consecutivas con KPIs verdes
   (ver `docs/operations/pilot-kpis.md §Criterios de éxito`)
2. PV1-A1 (upgrade LiteLLM) completado
3. PV1-A2 (hook en 13 devs) completado
4. Retrospectiva del roadmap Q2-Q3 documentada (actualizar este fichero)

---

_Definición formal: S24-C (Sprint 24, 2026-05-07)._
