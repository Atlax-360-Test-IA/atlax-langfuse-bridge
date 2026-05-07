# RFC-002 — Contrato HTTP bridge↔dashboard: decisión de no implementar

- **Status**: Accepted
- **Date**: 2026-05-07
- **Sprint**: S23-B
- **Autor**: jgcalvo
- **Spike origen**: `docs/spikes/S23-A-bridge-http-viability.md`
- **Scope**: `atlax-langfuse-bridge` (decisión NO afecta a `atlax-claude-dashboard`)

---

## Contexto

El roadmap Q2-Q3 2026 (Sprint 23) planificó un spike para evaluar si el bridge debería exponer un servidor HTTP de lectura para que `atlax-claude-dashboard` consumiera datos de sesión granulares. La hipótesis era que el dashboard podría necesitar información que solo el bridge tiene (tier, IDE, proyecto git, rama) y que no está disponible en la Anthropic Admin API.

## Pregunta que responde este RFC

> ¿Debe `atlax-langfuse-bridge` implementar un servidor HTTP read-only para que `atlax-claude-dashboard` lo consuma?

## Decisión

**No implementar.** Ni para v1 ni near-term.

## Razonamiento

### 1. No hay demanda actual probada

El spike S23-A confirmó que `atlax-claude-dashboard` opera 100% sobre su propio Postgres (Cloud SQL), alimentado por 7 jobs de Cloud Scheduler que sincronizan desde Anthropic Admin API y GCP BigQuery. No existe ninguna referencia al bridge, Langfuse, ni `session_id` en el código del dashboard. Todos los KPIs actuales del dashboard están cubiertos sin el bridge.

### 2. Viola el invariante I-13 en espíritu

I-13 establece que el reconciler, el hook, y los scripts de discovery son "edge" — viven en la máquina del dev y nunca migran a Cloud Run. Un servidor HTTP persistente en la máquina del dev no es accesible desde Cloud Run (donde vive el dashboard API). Hacer el bridge accesible externamente requeriría exponerlo en un servidor (Cloud Run), lo que contradice I-13 directamente.

### 3. Introduce SPOF sin valor proporcional

El bridge actual es un script cron idempotente: si falla, el reconciler lo reintenta. Un servidor HTTP añadiría un punto de fallo adicional (uptime del server, auth, networking) en un sistema donde la simplicidad operativa es un valor explícito (ADR-001, ADR-006).

### 4. Alternativa superior disponible

Si el dashboard alguna vez necesita datos de sesión granulares (drill-down por dev, proyecto, rama), la vía correcta es consultar directamente la **Langfuse API** (`GET /api/public/traces`). Langfuse ya expone:

- Auth Basic (public/secret key)
- Paginación
- Filtros por `name`, `userId`, `tags`, `fromTimestamp`
- Metadata arbitraria (tier, IDE, proyecto git, rama)

El dashboard consumir Langfuse directamente es más simple, más robusto, y no requiere cambios en el bridge.

### 5. El piloto no justifica la inversión

Con 13 devs en el piloto y 1 dev activo (jgcalvo), el drill-down por sesión individual no es una funcionalidad de alta demanda hoy. Implementar un servidor HTTP para un caso de uso hipotético en un piloto pequeño es sobre-ingeniería.

## Alternativas descartadas

| Alternativa                                                   | Razón de descarte                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Bridge expone HTTP en Cloud Run                               | Viola I-13 directamente                                                             |
| Bridge expone HTTP en máquina dev, dashboard lo llama por VPN | Latencia, NAT, complejidad de networking — inaceptable en producción                |
| Bridge escribe a Postgres compartido con el dashboard         | Introduce acoplamiento de esquema entre proyectos con cadencias de deploy distintas |
| Bridge exporta CSV diario que el dashboard importa            | Complejidad de orquestación sin garantías de consistencia                           |

## Resolución del CP-4 del roadmap

El item CP-4 ("Dashboard observabilidad de sesiones — resultado de S23-A") queda resuelto así:

> Si el dashboard necesita datos de sesión granulares post-v1, la arquitectura es `dashboard → Langfuse API`, no `dashboard → bridge HTTP`. El bridge no cambia. El dashboard añade un cliente Langfuse en su `packages/core/src/`.

Esto se documenta en el backlog POST-V1 como item **CP-4-v2**.

## Consecuencias

### Inmediatas (v1)

- El bridge **no implementa** ningún servidor HTTP
- No se crea ningún ADR de servidor HTTP (la decisión de no implementar no requiere ADR)
- El roadmap del dashboard no cambia

### Post-v1 (si la demanda aparece)

- Añadir cliente Langfuse en `atlax-claude-dashboard/packages/core/src/langfuse/`
- El dashboard consulta `GET /api/public/traces?userId=X&name=claude-code-session`
- No requiere cambios en el bridge

## Referencias

- Spike: `docs/spikes/S23-A-bridge-http-viability.md`
- Invariante: `CLAUDE.md §I-13`
- ADR-001 (cero deps, simplicidad operativa): `docs/adr/ADR-001-bun-cero-deps.md`
- ADR-006 (two-layer consistency): `docs/adr/ADR-006-two-layer-consistency.md`
- Roadmap §8 (Sprint 23): `docs/roadmap/2026-Q2-Q3-bridge-dashboard-coordination.md`
