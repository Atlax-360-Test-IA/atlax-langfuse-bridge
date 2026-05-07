# Análisis de unificación: atlax-langfuse-bridge ↔ atlax-claude-dashboard

**Fecha**: 2026-05-07
**Estado**: análisis preliminar, NO ES UNA DECISIÓN
**Autor**: agente de investigación (researcher)

---

## Resumen ejecutivo (5 líneas)

Los dos proyectos son **complementarios, no rivales**: el bridge captura datos desde el
filesystem del dev (JSONL de Claude Code) y los envía a Langfuse; el dashboard los obtiene
del Anthropic Admin API y los presenta a managers. La única duplicación real es el objeto
`MODEL_PRICING` — dos versiones con esquema diferente y sin consumidores cruzados. La fusión
completa viola I-13 (ADR-002) que prohíbe por diseño que el hook/reconciler migren a Cloud Run.
La recomendación es **M4 mejorado** hoy, con evaluación de M3 si el pricing diverge en ≥2
actualizaciones consecutivas.

---

## 1. Estado actual de cada proyecto

### atlax-langfuse-bridge — v0.5.4

- **Propósito**: FinOps observability. Captura uso de Claude Code por sesión y lo envía a Langfuse
  v3 self-hosted.
- **Componentes**:
  - `hooks/langfuse-sync.ts` — hook Stop síncrono; lee JSONL local, agrega tokens+coste, POST a Langfuse.
  - `scripts/reconcile-traces.ts` — cron asíncrono (systemd/launchd); detecta drift y re-ejecuta el hook.
  - `shared/` — aggregate, model-pricing, langfuse-client, drift, degradation, jsonl-discovery, hash-cache.
  - `scripts/mcp-server.ts` — MCP stdio para query/annotate de trazas Langfuse.
  - `browser-extension/` — intercepta SSE de claude.ai para tier y coste en tiempo real.
- **Runtime**: Bun, cero dependencias de producción (ADR-001). DevDeps solo: `bun-types`, `typescript`, `zod`.
- **Despliegue**: edge (máquina del dev) + Langfuse self-hosted Docker local; PRO target = Cloud Run para
  Langfuse stack únicamente.
- **Test suite**: 581 tests / 981 assertions (Sprint 16).
- **Audiencia**: plataforma interna — 38 devs de Atlax360 como usuarios finales.

### atlax-claude-dashboard — v0.1.0

- **Propósito**: FinOps reporting. Sincroniza datos del Anthropic Admin API y BigQuery a PostgreSQL;
  presenta métricas de adopción y coste vía UI web; genera recomendaciones de tier.
- **Componentes**:
  - `apps/api/` — Hono REST API (puerto 3000). 10 routers v1.
  - `apps/dashboard/` — Next.js 16 + SWR + shadcn/ui (puerto 3001).
  - `apps/cli/` — CLI de sync y admin.
  - `packages/core/` — anthropic sync, recommender, alerts (Slack/GChat/WhatsApp), CSV parsers, BigQuery.
  - `packages/db/` — Drizzle ORM + PostgreSQL 17. 16 tablas, 16+ migraciones con down.sql.
  - `packages/shared/` — types, constants (incluyendo `MODEL_PRICING`), env schemas.
- **Runtime**: Bun (workspaces) + Next.js + Drizzle + PostgreSQL + biome.
- **Despliegue**: Cloud Run (API) + Vercel (dashboard) + Cloud SQL + Cloud Scheduler (7 cron jobs UTC).
- **Test suite**: E2E contra puerto 3099 con PostgreSQL real. Tests unitarios en packages.
- **Audiencia**: managers y equipo platform — vista agregada, no per-session.

---

## 2. Solapamientos y duplicación

### 2.1 Duplicación confirmada: `MODEL_PRICING`

| Aspecto               | `atlax-langfuse-bridge`                                                                               | `atlax-claude-dashboard`                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Fichero               | `shared/model-pricing.ts`                                                                             | `packages/shared/src/constants/pricing.ts`                                                     |
| Esquema               | `{ input, cacheWrite, cacheRead, output }` ($/Mtok)                                                   | `{ inputPerMtok, outputPerMtok, batchInput/Output }` ($/Mtok)                                  |
| Modelos cubiertos     | `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4-5` (substring match)                              | `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` (exact key)                         |
| Consumidores internos | aggregate.ts, langfuse-sync.ts, reconcile-traces.ts, browser-extension/pricing.js, validate-traces.ts | Solo tests (`types.test.ts`) — no hay consumidor de producción que use `MODEL_PRICING` de aquí |
| `SEAT_COSTS`          | No existe                                                                                             | `{ standard: { monthly: 22.72, annual: 20 }, premium: { monthly: 113.65, annual: 100 } }`      |

**Gravedad real**: BAJA. Los dos `MODEL_PRICING` tienen esquemas diferentes porque resuelven
problemas diferentes. El del bridge calcula coste de tokens individuales (incluyendo cacheWrite/cacheRead);
el del dashboard define precios de referencia para recomendaciones de tier (incluye batch pricing). No son
la misma función con el mismo output — son tablas de referencia para dominios distintos.

Adicionalmente: el `MODEL_PRICING` del dashboard no tiene ningún consumidor de producción activo (solo
tests). El coste real en el recommender viene de `thresholds` DB-configurables (Vertex rates via
`calculateVertexCost`), no de la constante hardcodeada.

El bridge tiene un test de cross-validación (`browser-extension/src/pricing.test.ts`) que verifica que
`browser-extension/pricing.js` (JS, no TS — MV3 constraint) es idéntico a `shared/model-pricing.ts`.
Esto es sincronía intra-proyecto, no inter-proyecto.

### 2.2 Posibles solapamientos adicionales: NINGUNO confirmado

| Área                  | Bridge                                       | Dashboard                                      | Solapamiento                                   |
| --------------------- | -------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Fuente de datos       | `~/.claude/projects/**/*.jsonl` (filesystem) | Anthropic Admin API + BigQuery                 | Cero. Fuentes ortogonales.                     |
| Almacenamiento        | Langfuse (ClickHouse + Postgres + Redis)     | PostgreSQL propio (17 tablas)                  | Cero. Bases de datos distintas.                |
| Cliente HTTP Langfuse | `shared/langfuse-client.ts` (custom)         | No existe (no referencia Langfuse en absoluto) | Cero.                                          |
| Cliente Anthropic     | No existe (no llama al Admin API)            | `packages/core/src/anthropic/client.ts`        | Cero.                                          |
| Lógica de alertas     | No existe                                    | `packages/core/src/alerts/`                    | Cero.                                          |
| Tier detection        | `scripts/detect-tier.ts` (lee `~/.claude/`)  | No existe (usa tiers del Admin API)            | Concepto compartido, implementación ortogonal. |
| CLI                   | No tiene CLI de usuario                      | `apps/cli/` (sync, recommend, status)          | Cero.                                          |
| UI                    | `browser-extension/popup.html` (extensión)   | `apps/dashboard/` (Next.js web)                | Cero. Canales distintos.                       |

### 2.3 Tipos de datos con nombres similares pero semántica distinta

`UserAggregatedData` (dashboard) agrega datos históricos de múltiples días desde PostgreSQL.
`AggregateResult` (bridge) agrega un solo JSONL de sesión en memoria. Mismo verbo "aggregate",
dominio completamente distinto.

---

## 3. Modelos de unificación

### M1 — Monorepo con paquetes compartidos (turborepo/nx)

**Descripción**: unificar en un solo repositorio con workspaces separados. Extraer un
paquete `@atlax/cost-core` con `MODEL_PRICING`, utilidades de fechas, etc.

**Pros**:

- Una sola `bun.lock` — sin drift de dependencias entre proyectos.
- CI unificada — un pipeline ve si un cambio en `cost-core` rompe el bridge o el dashboard.
- Mejor developer experience si un dev trabaja en ambos proyectos simultáneamente.

**Contras**:

- **El bridge tiene cero dependencias de producción por diseño** (ADR-001). Introducirlo en
  un monorepo con Next.js/Drizzle/Hono eleva el riesgo de que `bun install` arrastre deps
  al bundle del hook. Requiere configuración explícita de workspace isolation — carga de
  mantenimiento permanente.
- El bridge tiene un ciclo de release semanal (44 PRs en ~4 meses). El dashboard es más
  lento (15 PRs en el mismo período). Acoplar los repos impone sincronía de release donde
  hoy hay autonomía.
- El overlap de código compartido hoy es UN objeto (`MODEL_PRICING`) con semántica diferente.
  No justifica la infraestructura de un monorepo.
- Turborepo/Nx añaden una capa de tooling que ninguno de los dos proyectos necesita ahora.

**Veredicto**: sobredimensionado para el problema actual.

### M2 — Fusión completa (un solo proyecto con todas las features)

**Descripción**: combinar bridge + dashboard en un único repo y despliegue.

**Pros**:

- Máxima cohesión — un único punto de verdad para todo el FinOps stack de Atlax360.
- Sin duplicación de ningún tipo.

**Contras**:

- **Viola I-13 / ADR-002 structuralmente**: el hook Stop y el reconciler DEBEN vivir en la
  máquina del dev (leen `~/.claude/projects/**/*.jsonl`). Un servicio Cloud Run no puede
  acceder a ese filesystem. La fusión implicaría o (a) duplicar componentes edge/cloud dentro
  del mismo repo — peor que hoy — o (b) añadir un endpoint de upload en el dashboard que
  reciba JSONLs de cada dev — superficie SSRF, vector de seguridad documentado en ADR-002.
- El bridge está en v0.5.4 con 581 tests y arquitectura estable. El dashboard es v0.1.0
  en activo desarrollo. Fusionar ahora implica que bugs de crecimiento del dashboard
  afectan a infraestructura de observabilidad en producción (38 devs).
- Stacks incompatibles: bridge es zero-deps + Docker Compose (Langfuse); dashboard es
  Next.js + Drizzle + PostgreSQL + Cloud Run + Vercel. El espacio de despliegue conjunto
  sería la unión de ambos — más complejo que cualquiera por separado.
- Cadencias de release incompatibles: el bridge hace upgrades de Langfuse con frecuencia
  (PR #44, #37, #43 son solo infraestructura Docker). El dashboard no tiene esa carga.

**Veredicto**: no viable hoy. Requeriría rediseño arquitectónico fundamental.

### M3 — Paquete npm compartido publicado (proyectos separados)

**Descripción**: extraer la lógica de pricing y tipos comunes a un paquete
`@atlax/finops-shared` publicado internamente (GitHub Packages o registro privado).
Ambos proyectos lo consumen como dependencia.

**Pros**:

- Resuelve el problema de divergencia de `MODEL_PRICING` de forma limpia.
- Cada proyecto mantiene autonomía de release y stack.
- Actualización de pricing en un solo lugar propagada a ambos.

**Contras**:

- **El problema que resuelve es casi inexistente hoy**: el `MODEL_PRICING` del dashboard
  no tiene consumidores de producción activos. La divergencia real es: bridge usa
  `{ input, cacheWrite, cacheRead, output }` (4 campos, coste por turn); dashboard usa
  `{ inputPerMtok, outputPerMtok, batchInput, batchOutput }` (4 campos distintos, coste
  de tier). Son dominios diferentes aunque se llamen igual.
- Añade un paso de publicación/versionado al workflow de cualquier cambio de pricing.
  Con la frecuencia actual (actualización cada pocas semanas), es más fricción que valor.
- El bridge tiene la regla de cero deps de producción (ADR-001). Aunque `@atlax/finops-shared`
  sería solo datos (sin código ejecutable riesgoso), añadir una dependencia npm al hook
  requeriría un nuevo ADR y revisión de la regla.
- GitHub Packages o un registro privado añaden infraestructura de auth en CI de ambos proyectos.

**Veredicto**: viable en el futuro si el pricing diverge de forma material en ≥2 actualizaciones.
Hoy no justifica el overhead.

### M4 — Status quo mejorado (proyectos separados, sin código compartido)

**Descripción**: mantener los proyectos separados pero añadir un contrato explícito entre
ellos: documentar las diferencias de pricing en ambos READMEs, añadir un test de snapshot
en el bridge que alerte cuando Anthropic actualice precios (ya existe via `pricing.test.ts`),
y hacer lo mismo en el dashboard.

**Pros**:

- Cero coste de migración.
- Respeta I-13 / ADR-002 y la regla de cero deps del bridge.
- Cada proyecto puede evolucionar a su ritmo (el bridge es infraestructura madura; el
  dashboard está en crecimiento activo).
- La "duplicación" de `MODEL_PRICING` es tolerable: son dos objetos con propósito diferente
  que comparten el nombre. Si Anthropic actualiza precios, actualizar ambos es trabajo de
  5 minutos — no hay riesgo de desincronización silenciosa porque ambos tienen tests de snapshot.

**Contras**:

- Si el pricing se actualiza frecuentemente y alguien olvida actualizar uno de los dos,
  habrá divergencia. Riesgo mitigable con tests de snapshot en ambos proyectos.
- No hay un punto central de documentación de "cuánto cuesta cada modelo en Atlax360".

**Mejora concreta recomendada**: añadir una nota en `packages/shared/src/constants/pricing.ts`
del dashboard que apunte a `atlax-langfuse-bridge/shared/model-pricing.ts` como referencia
canónica de precios por token (distinto propósito, pero mismo origen de verdad: Anthropic).

**Veredicto**: opción correcta hoy.

---

## 4. Restricciones técnicas

### 4.1 I-13 (bridge) — hard constraint estructural

El hook (`langfuse-sync.ts`) y el reconciler (`reconcile-traces.ts`) **no pueden** moverse
a ningún servicio en la nube. Leen `~/.claude/projects/**/*.jsonl` — filesystem local del dev.
Esta restricción está documentada en ADR-002, enforced por 17 tests en
`tests/cloud-run-boundary.test.ts`, y es **no negociable** sin un rediseño que introduzca
un endpoint de upload (vector de seguridad documentado como descartado en ADR-002 §Context).

Cualquier modelo de unificación que mueva el bridge a Cloud Run viola I-13. M2 (fusión completa)
entra en conflicto directo con esto.

### 4.2 Constraint análoga del dashboard — soft constraint de stack

El dashboard **requiere PostgreSQL + Cloud Run + Vercel**. No tiene un equivalente de I-13
(ninguna restricción que le impida vivir junto a otro proyecto), pero su stack de despliegue
es incompatible con el modelo de "cero deps + filesystem local" del bridge.

### 4.3 Cadencias de release incompatibles

- Bridge: ~44 PRs en 4 meses. Sprints de hardening frecuentes, upgrades de infra Docker regulares.
- Dashboard: ~15 PRs en el mismo período. Crecimiento de features, sin overhead de infra Docker.

Fusión implicaría que cada upgrade de Langfuse (PR #44, #43, #37) afecta al pipeline del dashboard.

### 4.4 Esquemas de datos ortogonales

El bridge no tiene acceso al Anthropic Admin API. El dashboard no lee JSONLs locales. No hay
una ruta de datos que conecte los dos proyectos — son fuentes primarias distintas. No hay
"capa compartida" de datos que justifique infraestructura compartida.

### 4.5 `browser-extension/` — constraint MV3

La extensión de Chrome usa JS vanilla (no TypeScript compilado) por restricción de Manifest V3.
El paquete compartido tendría que publicarse tanto como ESM TS como como JS sin bundler — un
problema de packaging adicional en M3.

---

## 5. Recomendación

**Recomendación: M4 mejorado (separados + contrato explícito de pricing)**

No hay una respuesta "correcta" independiente del contexto. El análisis muestra que:

1. **La duplicación real es mínima**: un objeto `MODEL_PRICING` con esquema diferente, sin
   consumidores cruzados. No es la duplicación que justifica unificación.

2. **Los proyectos resuelven problemas diferentes en capas diferentes**: el bridge opera en
   capa edge (filesystem local del dev, latencia crítica — hook Stop no puede bloquearse);
   el dashboard opera en capa cloud (API sincs batch, UI web, reports). Son piezas de la misma
   historia FinOps, no el mismo componente bifurcado.

3. **I-13 es un hard constraint real**: no un detalle implementación. ADR-002 documenta que
   centralizar el hook requeriría un endpoint de upload o cambiar el modelo de eventos de
   Claude Code — ninguna de las dos opciones es razonable hoy.

4. **Acción inmediata recomendada**: añadir en `packages/shared/src/constants/pricing.ts` un
   comentario que documente que la fuente de verdad para precios por token está en el bridge,
   y que los campos de este objeto tienen una semántica diferente (batch, tier). Costo: 3 líneas.

5. **No hacer nada más por ahora** — la carga cognitiva de mantener dos objetos `MODEL_PRICING`
   separados es menor que la carga operativa de cualquier modelo de compartición.

---

## 6. Triggers para revisar esta decisión

Revisar en cuál de estas condiciones:

| Trigger                                                                                   | Modelo a considerar       |
| ----------------------------------------------------------------------------------------- | ------------------------- |
| `MODEL_PRICING` diverge en ≥2 actualizaciones consecutivas (uno se actualiza, el otro no) | M3 (paquete compartido)   |
| El dashboard empieza a leer trazas de Langfuse directamente (nueva feature)               | M1 (monorepo)             |
| El bridge añade un endpoint HTTP propio (rompe zero-deps)                                 | Reevaluar todo            |
| Atlax360 escala a >100 devs y el onboarding del bridge es un cuello de botella            | M2 con rediseño de upload |
| Un tercer proyecto Atlax necesita pricing de modelos Claude                               | M3 (paquete compartido)   |
| Claude Code expone webhook stream oficial (elimina dependencia del filesystem)            | M2 viable                 |

La revisión más probable en 6-12 meses: **M3 si el pricing se vuelve un problema de coordinación**. El trigger mensual de Scope Review (Atlax Design System D-009) es el momento adecuado para evaluar si esta decisión cambió de `<project>` a `applicable`.

---

## Fuentes consultadas

| Archivo                                                                                       | Rol                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `/home/jgcalvo/work/atlax-langfuse-bridge/shared/model-pricing.ts:1-42`                       | Pricing del bridge — esquema y lógica     |
| `/home/jgcalvo/work/atlax-claude-dashboard/packages/shared/src/constants/pricing.ts:1-33`     | Pricing del dashboard — esquema diferente |
| `/home/jgcalvo/work/atlax-langfuse-bridge/shared/aggregate.ts:1-127`                          | Core de agregación de sesiones            |
| `/home/jgcalvo/work/atlax-langfuse-bridge/docs/adr/ADR-002-edge-core-split.md:1-165`          | Hard constraint I-13 / edge vs cloud      |
| `/home/jgcalvo/work/atlax-langfuse-bridge/docs/adr/ADR-001-bun-cero-deps.md`                  | Constraint cero deps de producción        |
| `/home/jgcalvo/work/atlax-claude-dashboard/ARCHITECTURE.md:1-72`                              | Stack y despliegue del dashboard          |
| `/home/jgcalvo/work/atlax-claude-dashboard/packages/core/src/recommender/vertex-cost.ts:1-44` | Coste Vertex en recommender               |
| `/home/jgcalvo/work/atlax-claude-dashboard/packages/core/src/recommender/engine.ts:1-95`      | Lógica recommender                        |
| `/home/jgcalvo/work/atlax-langfuse-bridge/browser-extension/src/pricing.test.ts:1-102`        | Cross-validation intra-bridge             |
| `/home/jgcalvo/work/atlax-langfuse-bridge/CLAUDE.md` (invariantes I-1..I-13)                  | Invariantes no negociables del bridge     |
| `/home/jgcalvo/work/atlax-claude-dashboard/CLAUDE.md` (stack, despliegue, audit patterns)     | Reglas y stack del dashboard              |
| `git log` de ambos proyectos (últimos 20 commits cada uno)                                    | Cadencia de release real                  |
