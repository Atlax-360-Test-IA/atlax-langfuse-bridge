# ADR-010 · Plan de milestones LiteLLM M1→M3

- **Status**: Accepted
- **Date**: 2026-05-07
- **Scope**: atlax-langfuse-bridge
- **Implements**: I-7 (tier determinista), relacionado con S17-B, S19-A, S19-B, S20-A

## Context

LiteLLM actúa como gateway HTTP OpenAI-compatible entre los workloads no-interactivos
de Atlax360 (Orvian, Harvest, Kairos) y la API de Anthropic. Permite centralizar
autenticación, presupuestos por workload y observabilidad unificada en Langfuse.

La activación se diseña en tres milestones para minimizar el riesgo de adopción
y permitir validación incremental antes de exponer el gateway a más clientes.

Claude Code interactivo (hook Stop + seats Premium) NO pasa por LiteLLM — esto es
intencional y está formalizado en [ADR-007](ADR-007-litellm-optin.md).

## Decision

### M1 — Gateway operativo con master key (Sprint 17, completado)

**Criterio de entrada**: stack docker-compose levantado, `ANTHROPIC_API_KEY` + `LITELLM_MASTER_KEY` + `LITELLM_SALT_KEY` configuradas.

**Alcance**:

- Un único modelo expuesto: `claude-sonnet-4-6`
- Autenticación: master key única (`Bearer sk-atlax-master-...`)
- Callback Langfuse activo (`success_callback: ["langfuse"]`)
- Sin virtual keys, sin presupuestos por workload

**Criterio de salida (DoD)**:

- `GET http://localhost:4001/health` → 200 OK
- `POST /chat/completions` con `model: claude-sonnet-4-6` → respuesta válida
- Trace visible en Langfuse con tag `source:litellm-gateway`
- Smoke test automatizado en `tests/litellm-m1-smoke.test.ts` en verde

**Estado**: ✅ Completado (PR #51, 2026-05-07)

### M2 — Full model lineup + callback verificado (Sprint 19)

**Criterio de entrada**: M1 operativo en producción ≥72h sin errores.

**Alcance**:

- Tres modelos expuestos: `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-7`
- Callback Langfuse verificado: cada request genera observation con `calculatedTotalCost > 0`
- Tag `source:litellm-gateway` presente en todos los traces
- Sin virtual keys todavía (master key único)

**Criterio de salida (DoD)**:

- Los tres modelos responden en smoke test
- Observation en Langfuse tiene `usageDetails` con tokens + `costDetails` con coste calculado
- Test `tests/litellm-m2-callback.test.ts` en verde (requiere stack levantado)

**Estado**: 🔄 En curso (S19-A completado: config expandido; S19-B pendiente verificación)

### M3 — Virtual keys + presupuestos por workload (Sprint 20)

**Criterio de entrada**: M2 operativo ≥1 semana sin errores de callback.

**Alcance**:

- Virtual keys por workload (`/key/generate` vía admin API)
- Soft budget mensual por key (configurable en USD)
- Rechazo 429 al superar presupuesto
- Atribución de coste por `user_api_key_user_id` en Langfuse
- Endpoint `/admin/dashboard` operativo para gestión de keys

**Criterio de salida (DoD)**:

- Admin puede crear key con `max_budget: 50` (USD/mes)
- Request con key agotada recibe `429 Budget exceeded`
- Trace en Langfuse tiene `user_api_key_user_id` correcto
- Test funcional: emitir N requests hasta agotar budget → verificar 429

**Estado**: 📋 Planificado (Sprint 20, Q2 2026)

## Rationale

### Por qué tres milestones y no big-bang

El gateway LiteLLM introduce un SPOF potencial en el path de las llamadas API.
La adopción incremental permite detectar problemas en cada etapa antes de comprometer
workloads críticos. M1 valida la conectividad, M2 valida la observabilidad, M3
introduce la lógica de acceso multi-tenant.

### Por qué M3 no incluye multi-vendor todavía

Multi-vendor (OpenAI, Vertex, Bedrock) es un ítem POST-V1. Requiere M3 estable
con al menos dos workloads en producción durante 30+ días para validar que el
routing y la atribución de coste funcionan con Anthropic antes de añadir complejidad.

### Criterio de promoción M→M+1

Antes de iniciar el milestone siguiente:

1. El milestone actual lleva ≥72h sin errores en logs (`docker compose logs litellm`)
2. Langfuse muestra traces con `calculatedTotalCost > 0` en las últimas 24h
3. Smoke test del milestone anterior en verde en CI

## Consequences

- **Positivo**: adopción gradual reduce riesgo; cada milestone es independientemente
  validable.
- **Positivo**: virtual keys en M3 permiten presupuestos por equipo sin cambiar
  el código del cliente (solo cambiar la API key en la config del workload).
- **Negativo**: M3 requiere que la BD `litellm` esté provisionada antes del sprint.
  Verificar antes de iniciar Sprint 20.
- **Neutro**: LiteLLM usa su BD interna de costes (no `shared/model-pricing.ts`).
  Divergencia entre traces `cc-*` y traces `source:litellm-gateway` es esperada
  y documentada en I-6.
