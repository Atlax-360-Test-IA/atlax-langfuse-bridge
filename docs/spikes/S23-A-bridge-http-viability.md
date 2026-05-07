# Spike S23-A — Viabilidad bridge → HTTP read-only para dashboard

- **Sprint**: S23 (2026-05-07)
- **Autor**: jgcalvo
- **Duración**: 1 sesión de análisis
- **Output**: decisión para RFC-002

---

## Pregunta que responde este spike

> ¿Necesita `atlax-claude-dashboard` leer datos del bridge vía HTTP? ¿Qué endpoints concretos requeriría? ¿Merece la pena implementarlo?

---

## Metodología

1. Leer la arquitectura del dashboard (`atlax-claude-dashboard/ARCHITECTURE.md`)
2. Auditar las fuentes de datos de cada route del API del dashboard
3. Comprobar si existe alguna referencia al bridge, Langfuse, o reconciler en el código del dashboard
4. Evaluar si los datos que el bridge tiene son los que el dashboard necesita y no puede obtener de otra forma

## Hallazgos

### 1. El dashboard tiene su propia fuente de datos independiente

El dashboard (`atlax-claude-dashboard`) opera sobre **Postgres propio** (Cloud SQL) con tablas Drizzle:

| Tabla Drizzle          | Origen                                  | Job de sync                |
| ---------------------- | --------------------------------------- | -------------------------- |
| `claudeCodeDaily`      | Anthropic Admin API `/usage`            | `sync-claude-code`         |
| `claudeCodeModelUsage` | Anthropic Admin API `/usage` (desglose) | `sync-claude-code`         |
| `orgCostDaily`         | Anthropic Admin API `/cost_report`      | `sync-org-cost`            |
| `vertexCostDaily`      | GCP BigQuery billing                    | `sync-vertex-billing`      |
| `users`                | Anthropic Admin API `/users`            | `sync-users`               |
| `alertsLog`            | Generado internamente                   | `check-alerts`             |
| `recommendations`      | Generado internamente                   | `generate-recommendations` |

Los 7 jobs de Cloud Scheduler alimentan estas tablas directamente desde las APIs upstream.

### 2. No existe ninguna referencia al bridge en el código del dashboard

Búsqueda exhaustiva en `packages/core/src/`, `apps/api/src/routes/v1/`, y `packages/db/`:

- **0 referencias** a `langfuse`, `bridge`, `reconciler`, `session_id`, o `transcript_path`
- El dashboard no conoce la existencia del bridge

### 3. Los datos del bridge son complementarios, no sustitutos

El bridge emite traces a Langfuse con metadata rica (tier, entrypoint, gitBranch, cwd, estimatedCostUSD). El dashboard consume datos agregados de la Admin API (uso diario, coste diario, usuarios). Son proyecciones distintas del mismo conjunto de eventos:

| Dimensión    | Bridge (Langfuse)                     | Dashboard (Postgres)        |
| ------------ | ------------------------------------- | --------------------------- |
| Granularidad | Por sesión individual                 | Agregado diario por usuario |
| Coste        | Estimado por pricing local            | Real (Anthropic billing)    |
| Contexto     | Tier, IDE, proyecto git, rama         | N/A                         |
| Acceso       | Langfuse API (self-hosted)            | Postgres (Cloud SQL)        |
| Retención    | `cleanupPeriodDays` (90d por defecto) | Sin límite definido         |

### 4. Preguntas del roadmap respondidas

Las 4 preguntas que debía responder el spike (roadmap §8):

| Pregunta                                   | Respuesta                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| ¿El dashboard necesita lectura del bridge? | **No**. Tiene fuente propia (Admin API + Postgres) para todos sus KPIs actuales                    |
| ¿Qué endpoints concretos necesitaría?      | Ninguno en el scope v1. Post-v1: potencialmente `/sessions/{id}/detail` para drill-down por sesión |
| ¿Quién sería el caller?                    | No hay caller actual. Hipotético: job de enriquecimiento en Cloud Run                              |
| ¿Latencia aceptable?                       | Irrelevante: el caller hipotético sería async (job batch), no real-time                            |

### 5. Caso único donde podría añadir valor (post-v1)

El único escenario donde el bridge aportaría algo que el dashboard no puede obtener es el **drill-down por sesión individual**: el dashboard sabe que el dev X gastó $Y el día D, pero no sabe en qué proyecto git, en qué rama, o con qué IDE. Eso lo tiene el bridge en Langfuse.

Ese caso de uso es post-v1 y requeriría:

- Bridge expone HTTP read-only (e.g. `GET /api/v1/sessions?userEmail=X&date=Y`)
- Dashboard llama al bridge como fuente adicional para el drill-down
- Auth machine-to-machine (JOBS_SECRET o nuevo secret)

**Por qué no ahora**: complejidad de SPOF adicional + auth + deploy del bridge como servicio persistente (hoy es un cron script, no un server). El valor no justifica el coste en el contexto del piloto de 13 devs.

---

## Conclusión

**No implementar** HTTP server en el bridge para v1.

Las razones en orden de peso:

1. **No hay demanda actual**: el dashboard no necesita datos del bridge para sus KPIs existentes
2. **Añade SPOF**: el bridge pasaría de ser un script local idempotente a un servidor que debe estar arriba para que el dashboard funcione — viola I-13 (edge/core split) en espíritu
3. **Complejidad de deploy**: el bridge vive en máquinas dev, no en Cloud Run (I-13 prohíbe esto). Un HTTP server en máquina dev no es accesible desde Cloud Run
4. **Alternativa superior para post-v1**: si el dashboard alguna vez necesita datos de sesión granulares, la vía correcta es que el dashboard llame directamente a la **Langfuse API** (que ya tiene auth, paginación, y está en servidor) — no al bridge
5. **Solución al CP-4**: en lugar de bridge→dashboard HTTP, la arquitectura correcta es `dashboard → Langfuse API` directamente, lo que elimina al bridge como intermediario y da al dashboard toda la granularidad de sesión sin SPOF nuevo

---

## Decisión para RFC-002

> **No implementar** servidor HTTP en el bridge (v1 ni near-term). Si el dashboard necesita datos de sesión granulares (post-v1), la vía es `dashboard → Langfuse API`, no `dashboard → bridge HTTP`.

Ver RFC-002 para la decisión formalizada y el ADR-012 referenciado.
