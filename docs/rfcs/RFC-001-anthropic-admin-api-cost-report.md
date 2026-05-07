# RFC-001 · Integración Anthropic Admin API — cost_report en el reconciler

- **Status**: Accepted (decisión: Opción A — comparación workspace/día, NO per-sesión)
- **Fecha**: 2026-05-07
- **Autor**: jgcalvo
- **Scope**: atlax-langfuse-bridge
- **Decisión requerida**: antes de iniciar S18-B

---

## Contexto

El reconciler (`scripts/reconcile-traces.ts`) calcula el coste de cada sesión Claude Code usando
`shared/model-pricing.ts` — una estimación local basada en el conteo de tokens del JSONL.

Anthropic ofrece la **Admin API** (`api.anthropic.com/v1/usage`) que expone el coste real
facturado para workspaces con API key. Esta fuente sería más precisa que la estimación local
para sesiones que usan Claude Code en modo API key (no seats Premium).

**Hallazgo H1** de la sesión 2026-05-07: el `atlax-claude-dashboard` ya consume el endpoint
`cost_report` de la Admin API con 8 endpoints documentados. El bridge podría beneficiarse de
la misma fuente sin duplicar la llamada si hay coordinación cross-project.

---

## Problema que resuelve

- Las sesiones con API key tienen un coste estimado que puede diferir del coste real facturado.
- No hay forma actual de saber si la diferencia es relevante (>5%) o ruido (rounding).
- Las sesiones de seats Premium **no tienen coste real accesible vía API** (H2/A3 confirmados);
  la estimación local es la única fuente disponible y esto es intencional.

---

## Opciones evaluadas

### Opción A — Bridge llama Admin API directamente

El reconciler adquiere `ANTHROPIC_ADMIN_API_KEY` y llama `/v1/usage` para obtener el coste
real de sesiones API-key. Compara contra la estimación local y emite un log de divergencia
si `|real - estimated| / estimated > 5%`.

**Pros:**

- Independiente del dashboard; no hay acoplamiento cross-project.
- Fuente de verdad para sesiones API-key sin intermediario.

**Contras:**

- Requiere `ANTHROPIC_ADMIN_API_KEY` en la máquina del dev (security surface adicional).
- La API Admin de Anthropic devuelve agregados por workspace, no por session_id —
  requiere correlación temporal para atribuir coste a una sesión específica.
- La granularidad mínima del endpoint es diaria, no por sesión.

### Opción B — Bridge consume endpoint del dashboard

El dashboard ya tiene el coste real; el bridge llama al dashboard vía HTTP para obtener
`actualCostCents` por workspace+fecha.

**Pros:**

- Una sola fuente de verdad; no duplica la llamada Admin API.
- El bridge no necesita `ANTHROPIC_ADMIN_API_KEY`.

**Contras:**

- Acoplamiento fuerte bridge→dashboard (violación del principio de independencia I-13 adjacent).
- El dashboard puede estar caído o en mantenimiento (SPOF).
- Latencia añadida en el reconciler.
- El dashboard expone datos a nivel de workspace, no de session_id — mismo problema de granularidad.

### Opción C — Tag `cost-source:estimated` sin integrar cost_report (diferido)

Etiquetar cada trace con `cost-source:estimated` (para seats) o `cost-source:api-key-estimated`
(para API key) y **no integrar** el cost_report en este sprint. La integración real queda
pendiente hasta que la Admin API exponga granularidad de sesión.

**Pros:**

- Cero riesgo técnico; cero dependencias externas nuevas.
- El tag es retrocompatible (se puede enriquecer con `cost-source:api-real` si la API mejora).
- Elimina el riesgo de S18-B que puede convertir el sprint en bloqueante.

**Contras:**

- No resuelve el problema de coste real para sesiones API-key a corto plazo.
- Coste estimado sigue siendo la única fuente para todos los perfiles.

---

## Análisis de granularidad del endpoint Admin API

El endpoint `GET /v1/usage` devuelve:

```json
{
  "data": [
    {
      "timestamp": "2026-05-07T00:00:00Z",
      "input_tokens": 1234567,
      "output_tokens": 234567,
      "cache_creation_input_tokens": 89012,
      "cache_read_input_tokens": 345678,
      "model": "claude-sonnet-4-6",
      "cost_usd": 12.34
    }
  ]
}
```

**No hay `session_id` en la respuesta** — es un agregado por modelo y fecha (granularidad diaria).
Correlacionar con una sesión específica requeriría:

1. Saber el modelo usado en la sesión (disponible en el JSONL).
2. Saber la fecha de la sesión (disponible).
3. Dividir el coste diario del modelo entre todas las sesiones de ese modelo en ese día — estimación,
   no coste real por sesión.

**Conclusión**: la Admin API no resuelve el problema de coste real por sesión. Proporciona una
señal de reconciliación a nivel de workspace/día que es útil para detectar drift sistemático,
pero no para atribuir coste exacto a una sesión individual.

---

## Recomendación

**Opción C para S18-B/C/D** con las siguientes matizaciones:

1. **S18-C se implementa** (tag `cost-source:estimated` en hook + reconciler) — bajo riesgo, alto valor de visibilidad.
2. **S18-B se reformula** como detección de divergencia workspace-day, no sesión. El reconciler
   compara el coste total estimado del día con el coste real del workspace ese día. Si diverge >5%,
   emite `degradation` con metadata de contexto.
3. **S18-A genera este RFC**; S18-B queda bloqueado hasta que el humano decida si se obtiene
   `ANTHROPIC_ADMIN_API_KEY` y si la granularidad día-workspace es suficiente.
4. **S18-D** (detección divergencia) se puede implementar parcialmente con la señal workspace-day
   si se decide ir por Opción A.

---

## Decisión tomada (2026-05-07)

**Resolución**: Opción A implementada. `ANTHROPIC_ADMIN_API_KEY` obtenida.

**Path real del endpoint** (corregido vs. la suposición inicial del RFC):

- `GET /v1/organizations/cost_report` (no `/v1/usage`)
- `GET /v1/organizations/me` (validación)
- `GET /v1/organizations/usage_report/claude_code` (analytics — devuelve vacío para seats Premium)

**Granularidad real verificada empíricamente** (2026-05-07):

- Por **modelo** + **día UTC** + workspace + service_tier
- NO incluye `session_id` ni `user_email`
- Solo aparece tráfico **API key** — los seats Premium (OAuth) NO se facturan vía API y no aparecen

**Implementación en bridge**:

- `shared/anthropic-admin-client.ts` — cliente REST mínimo con timeout 30s
- `scripts/reconcile-traces.ts` — pasada post-scan que compara coste estimado por modelo (familyKey-normalizado) vs. cost_report y emite log estructurado
- Caso "seat-only" detectado y manejado como `info`, no `warn` (escenario operativo normal en Atlax)
- Threshold de divergencia configurable vía `COST_DIVERGENCE_THRESHOLD` (default 5%)

**Aprendizaje clave**: el cost_report SÍ es útil aunque no haya granularidad de sesión. Permite detectar drift sistémico cuando hay **mezcla** de tráfico API + seats. Si todo es seat, el bridge lo reporta explícitamente y no genera ruido.

---

## Pre-condiciones para implementar S18-B (si decisión = Sí)

- [ ] `ANTHROPIC_ADMIN_API_KEY` disponible y con permisos de lectura en `/v1/usage`
- [ ] Confirmación de que la granularidad diaria/workspace es suficiente para los KPIs del piloto
- [ ] Alineación con dashboard: ¿consumimos directo o via endpoint del dashboard?

---

## Referencias

- `shared/model-pricing.ts` — fuente de pricing estimado
- `scripts/reconcile-traces.ts` — reconciler que emitiría los nuevos tags
- `docs/roadmap/2026-Q2-Q3-bridge-dashboard-coordination.md` — S18-A..D, CP-2
- ADR-002 — edge/core split (I-13)
- Hallazgos H1-H5 de sesión 2026-05-07
