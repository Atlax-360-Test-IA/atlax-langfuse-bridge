# ADR-016 · Vertex AI via LiteLLM Gateway para atribución per-dev

- **Status**: Accepted
- **Date**: 2026-05-11
- **Implements**: —
- **Scope**: applicable (proyectos Atlax con uso de Vertex AI y necesidad de FinOps per-dev)
- **Supersedes**: decisión provisional PV1-D1 V1 (BigQuery export) de `post-v1-backlog.md`

## Context

Varios miembros del equipo usan Claude Code con `CLAUDE_CODE_USE_VERTEX=1` para aprovechar
las cuotas del Seat Team Premium en Vertex AI. Esto creaba un punto ciego FinOps: todas las
llamadas a Vertex se originan desde el service account compartido del proyecto GCP
(`atlax360-ai-langfuse-pro`), por lo que ninguna herramienta de observabilidad podía
atribuir el coste a un developer individual.

El backlog POST-V1 (PV1-D1) documentó tres opciones:

- **V1** — GCP Billing Export → BigQuery. Sin cambios en el bridge, latencia ~24h,
  sin granularidad de sesión.
- **V2** — Modelos Vertex en LiteLLM Gateway. Virtual keys per-dev proporcionan
  atribución real en Langfuse. Requiere SA con `roles/aiplatform.user`.
- **V3** — OpenTelemetry en workloads Vertex. Máxima granularidad, máximo esfuerzo.

La decisión inicial era "arrancar con V1 (bajo esfuerzo) y escalar a V2 cuando el piloto
LiteLLM tuviera ≥3 devs activos". Durante la sesión de trabajo del 2026-05-11 se decidió
**implementar V2 directamente**, omitiendo V1, por las razones descritas abajo.

## Decision

**Enrutar el tráfico Vertex AI a través del LiteLLM Gateway** añadiendo modelos
`vertex_ai/*` al `model_list` de `docker/litellm/config.yaml`. Los devs que antes
usaban `CLAUDE_CODE_USE_VERTEX=1` pasan a usar:

```bash
export ANTHROPIC_BASE_URL=https://litellm.atlax360.ai
export ANTHROPIC_API_KEY=sk-litellm-<virtual-key-personal>
# eliminar: CLAUDE_CODE_USE_VERTEX=1, GOOGLE_APPLICATION_CREDENTIALS
```

LiteLLM traduce internamente Anthropic Messages API → Vertex AI usando las credenciales
del SA del proyecto (`litellm@atlax360-ai-langfuse-pro`), al que se concede
`roles/aiplatform.user`. Los callbacks Langfuse existentes registran el trace con el
`user_id` de la virtual key, resolviendo la atribución.

Modelos añadidos (PR #102):

| Nombre en gateway          | Modelo Vertex                 | Región       |
| -------------------------- | ----------------------------- | ------------ |
| `vertex-claude-sonnet-4-6` | `vertex_ai/claude-sonnet-4-6` | europe-west1 |
| `vertex-claude-haiku-4-5`  | `vertex_ai/claude-haiku-4-5`  | europe-west1 |
| `vertex-claude-opus-4-7`   | `vertex_ai/claude-opus-4-7`   | europe-west1 |

El tag `langfuse_default_tags` pasa de `["source:litellm-gateway", "infra:anthropic"]` a
`["source:litellm-gateway"]` — el provider se discrimina por el campo `model` del trace
(`anthropic/*` vs `vertex_ai/*`), que es más preciso que un tag estático.

## Rationale — por qué V2 directamente, sin pasar por V1

**V1 (BigQuery) no resolvía el problema real.** GCP Billing Export atribuye el coste al
proyecto GCP, no al developer. Todos los calls Vertex comparten el mismo SA — BigQuery
solo habría añadido latencia de 24h al mismo dato ciego que ya teníamos. Era visibilidad
de coste agregado del proyecto, no FinOps per-dev.

**V2 es la única opción con atribución real.** Al forzar el tráfico por el gateway, la
virtual key es el identificador del developer. El callback Langfuse ya existente registra
`user_api_key_alias` (nombre de la key) y, desde `v1.83.10-stable`, `user_api_key_user_id`.
Esto da exactamente lo que necesitábamos: "dev X consumió Y tokens en Vertex este mes".

**Coste adicional: $0.** No se añade infraestructura nueva — LiteLLM ya está desplegado
en Cloud Run como gateway. El SA ya existía; solo necesitaba `roles/aiplatform.user`.

**Complejidad para el dev: menor.** Sustituye tres variables de entorno
(`CLAUDE_CODE_USE_VERTEX=1`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`)
por dos (`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`), que son el patrón estándar de
cualquier cliente Claude.

## Consequences

### Positivas

- Atribución per-dev de tráfico Vertex en Langfuse: mismo modelo de observabilidad
  que el tráfico Anthropic directo.
- Los devs no necesitan credenciales GCP locales para usar Vertex — el SA del proyecto
  actúa de proxy.
- Budget enforcement por developer reutiliza la infraestructura M3 de LiteLLM
  (soft budget + alertas Slack) sin cambios adicionales.
- Residencia de datos EU: región `europe-west1` para todos los modelos Vertex,
  consistente con Cloud Run y ClickHouse GCE.

### Negativas / Riesgos

- **LiteLLM issue #15299**: los headers `anthropic-beta` no se reenvían a Vertex.
  Esto afecta features como `context-management-2025-06-27` (extended thinking budget).
  Mitigación: Claude Code usa estos headers internamente — si un dev necesita features
  beta sobre Vertex, debe mantener `CLAUDE_CODE_USE_VERTEX=1` en esa sesión y perder
  la atribución. No hay solución hasta que LiteLLM resuelva el issue.
- **Single point of failure**: si el gateway LiteLLM tiene downtime, el tráfico Vertex
  también cae. Mitigación: `minScale=1` en Cloud Run garantiza instancia siempre activa;
  el dev puede hacer fallback a `CLAUDE_CODE_USE_VERTEX=1` directo.
- **Model Garden consent por proyecto**: los modelos Claude en Vertex requieren aceptar
  TOS en la consola GCP (UI-only, sin API). Si se crea un nuevo proyecto GCP, este paso
  es manual y no automatizable por `provision-pro.sh`.
- **ID de modelo sin sufijo de fecha en Vertex**: Vertex expone `claude-haiku-4-5`
  (sin `-20251001`). El ID con sufijo devuelve 404. Diferencia respecto a la API Anthropic
  directa donde el sufijo es obligatorio. Documentado para evitar regresión en futuros
  bumps de modelo.

## Alternatives Considered

### V1 — GCP Billing Export → BigQuery

Descartada. Latencia ~24h, sin granularidad de sesión, sin atribución individual.
Útil para auditoría de costes de proyecto pero no para FinOps per-dev.

### V3 — OpenTelemetry custom en workloads Vertex

Descartada. Requiere instrumentación en cada workload, mantenimiento propio del
pipeline OTel, y no reutiliza nada de lo ya desplegado. Coste desproporcionado.

### Mantener `CLAUDE_CODE_USE_VERTEX=1` + BigQuery

El status quo. Cero coste, cero trabajo, cero visibilidad. Inaceptable cuando el
objetivo del bridge es precisamente FinOps per-dev.

## References

- PR #102: implementación (`docker/litellm/config.yaml` + IAM + Secret Manager v3 + Cloud Run revision `litellm-00006-lj5`)
- [ADR-007](./ADR-007-litellm-optin.md): decisión original de LiteLLM como gateway opt-in
- [ADR-010](./ADR-010-litellm-milestone-plan.md): plan de milestones M1→M3 del gateway
- `docs/roadmap/post-v1-backlog.md §PV1-D1`: análisis original de opciones V1/V2/V3
- LiteLLM issue #15299: `anthropic-beta` headers not forwarded to Vertex
