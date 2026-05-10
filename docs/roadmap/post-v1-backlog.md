# Backlog POST-V1 · atlax-langfuse-bridge

> **S24-C** — Lista priorizada de items para después del cierre v1 (post Sprint 24).
> Fecha: 2026-05-07. Criterio de entrada al backlog: ≥3 devs en piloto LiteLLM activos
> durante 2 semanas consecutivas (exit criteria de `docs/operations/pilot-kpis.md`).

---

## Prioridad ALTA — Unblocking para escala del piloto

### PV1-A1 · Upgrade imagen LiteLLM a versión con `user_api_key_user_id` fix

- **Por qué**: `user_api_key_user_id` es null en v1.83.7 — atribución de coste por dev
  en Langfuse está rota para el gateway. Fix existe upstream.
- **Impacto**: atribución correcta en Langfuse → KPI "sesiones por dev" funciona
- **Effort**: S (1d) — cambiar tag de imagen en `docker/docker-compose.yml` + validar test S20-C
- **Dep**: ninguna
- **Test a actualizar**: `tests/litellm-m3-virtual-keys.test.ts` — el assert `== null`
  cambiará a valor real (intencionado, documentado en S20-C)

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

### PV1-D1 · Vertex traces + cost capture (Seat Team quota management)

- **Por qué**: varios miembros del equipo están alcanzando cuotas semanales de Seat Team.
  El bridge hoy solo captura trazas de Anthropic API directa — el tráfico Vertex queda ciego.
  Necesitamos visibilidad de coste y uso de Vertex para gestionar proactivamente las cuotas
  y tomar decisiones de routing (Seat Team vs Vertex vs API-key directa).
- **Impacto**: visibilidad FinOps completa para todos los canales Claude del equipo;
  KPI "quota headroom" medible; base para routing inteligente en LiteLLM M4
- **Effort**: V1 = S (2-3d) — GCP Billing Export to BigQuery, sin cambios en bridge
- **Opciones de implementación**:
  - **V1 (NOW)**: GCP Billing Export → BigQuery. Activar export en proyecto Atlax Billing.
    Crear dataset `atlax360-billing.vertex_usage`. Conectar Looker Studio o query manual.
    No requiere cambios en código del bridge. Latencia de datos: ~24h (billing export delay).
    Coste: ~$0 (BigQuery storage + queries mínimas). Sin granularidad de sesión — solo por día/modelo.
  - **V2**: LiteLLM route Vertex calls through gateway. Añadir `vertex_ai/` models en
    `litellm-config.yaml`. Trazas Vertex aparecen en Langfuse con callback existente.
    Requiere SA Vertex en Secret Manager + modelo pricing Vertex en `shared/model-pricing.ts`.
    Latencia real. Dep: PV1-B1 validado.
  - **V3**: Custom OpenTelemetry instrumentation en workloads Vertex. Máxima granularidad
    pero máximo esfuerzo — out of scope hasta que V2 esté validado.
- **Decisión 2026-05-10**: arrancar con **V1** (GCP Billing Export). Bajo esfuerzo, visibilidad
  inmediata. V2 cuando el piloto LiteLLM tenga ≥3 devs activos. V3 fuera de scope v1.
- **Pasos V1**:
  1. En `console.cloud.google.com/billing` → Billing Export → BigQuery export: activar
     "Detailed usage cost" + "Pricing" en proyecto billing de Atlax360
  2. Dataset destino: `atlax360-billing.gcp_billing_export` (crear si no existe)
  3. Query de ejemplo para Vertex usage:
     ```sql
     SELECT
       DATE(usage_start_time) AS date,
       service.description AS service,
       sku.description AS sku,
       SUM(cost) AS total_cost_usd,
       SUM(usage.amount) AS total_usage,
       usage.unit AS unit
     FROM `atlax360-billing.gcp_billing_export.gcp_billing_export_v1_*`
     WHERE service.description LIKE '%Vertex%'
       AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
     GROUP BY 1, 2, 3, 6
     ORDER BY 1 DESC, 4 DESC
     ```
  4. Conectar Looker Studio al dataset para dashboard visual (opcional pero recomendado)
- **Dep**: acceso billing admin en proyecto GCP de Atlax360 (jgcalvo o frsalas)
- **Riesgo V1**: datos agregados por día, sin granularidad de sesión ni usuario.
  Suficiente para gestión de cuotas pero no para atribución individual.
- **Criterio de upgrade a V2**: ≥3 devs usando Vertex regularmente + necesidad de
  atribución por dev en Langfuse

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

### PV1-C1 · Cobertura test `scripts/reconcile-traces.ts` → ≥60 %

- **Por qué**: cobertura actual ~37 % líneas. Las ramas de error son difíciles de testear
  sin fixtures de Langfuse reales. Patron: subprocess con mock HTTP (mismo que PR #61).
- **Effort**: M (2-3d) — añadir test suite análogo a `langfuse-sync-unit.test.ts`
- **Dep**: ninguna

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
