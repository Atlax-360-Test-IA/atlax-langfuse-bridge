# ADR-007 · LiteLLM como gateway opt-in, no en el flujo CLI principal

- **Status**: Accepted
- **Date**: 2026-04-06 (retroactiva)
- **Implements**: — (decisión de arquitectura, no formaliza invariante)

## Context

> _Sección a completar en Fase C: workloads que necesitan gateway (Orvian,
> Atalaya, MCP servers) vs workloads CLI directo (38 devs Atlax)._

LiteLLM proxy ofrece capacidades atractivas: virtual keys per-workload, soft
budget alerts, callback unificado a Langfuse. Tentación inicial: rutar todo
el tráfico Claude Code por LiteLLM para tener control central.

Análisis: forzar al CLI de Claude Code a pasar por LiteLLM rompe el flujo
OAuth de los seats (los devs autentican con su email corp en Anthropic). Además
añade un punto único de fallo (LiteLLM down → 38 devs sin Claude Code).

## Decision

> _Sección a completar en Fase C: detalle de qué workloads pasan por LiteLLM,
> separación de pricing, gates de docker compose._

LiteLLM gateway es **opt-in** vía `docker compose --profile litellm up -d`. Sin
el profile, el stack Langfuse arranca sin LiteLLM.

Workloads que pasan por LiteLLM:

- **Orvian / Atalaya / MCP servers** (workloads no-interactivos con presupuesto compartido)
- **Tests E2E** que verifican el callback Langfuse

Workloads que NO pasan por LiteLLM:

- **Claude Code CLI de los 38 devs** (OAuth directo a Anthropic)
- **Hook `Stop`** y reconciler (escriben directamente a `LANGFUSE_HOST`)

Pricing: LiteLLM usa sus propios precios internos para budget alerts.
`shared/model-pricing.ts` sigue siendo SSoT para hook/reconciler (I-6).

## Consequences

> _Sección a completar en Fase C: qué workloads ganan y qué quedan fuera,
> coexistencia de dos sistemas de pricing._

**Pros**:

- Cero impacto sobre los 38 devs si LiteLLM cae
- Virtual keys + soft budget útiles para workloads cuantificables
- Callback Langfuse unifica trazas en mismo project

**Contras**:

- Dos sistemas de pricing (LiteLLM interno + `shared/model-pricing.ts`) — riesgo de drift
- LiteLLM Salt key inmutable (cambiar = invalidar todas las virtual keys ya emitidas)

**Decisión consciente**: la coexistencia de dos pricing systems es aceptable
porque LiteLLM solo cubre workloads cuantificables, no el flujo CLI. El drift
entre ambos no afecta el reporting FinOps principal.
