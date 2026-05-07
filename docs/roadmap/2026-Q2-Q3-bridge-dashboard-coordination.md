# Roadmap Q2-Q3 2026 · `atlax-langfuse-bridge` con coordinación cross-project

- **Horizonte**: 8 sprints semanales (Sprint 17 → Sprint 24)
- **Fechas**: 12-may-2026 → 06-jul-2026
- **Modelo de trabajo**: 1 humano (jgcalvo) + Sonnet 4.6/Opus 4.7 (orquestadores) + subagentes paralelos
- **Capacity**: ~10 horas humano de review high-quality / semana
- **Status**: Draft v1.0 — pendiente validación del usuario

> Documento generado en sesión 2026-05-07 tras experimento de paralelización
> agéntica (`docs/experiments/2026-05-07-parallel-subagent-experiment.md`) y
> análisis cross-project (`docs/unification-analysis.md`).

---

## 0. Contexto y framing

### 0.1 Scope actual del piloto

**Hoy (mayo 2026)**: 13 devs de Atlax con seats Premium Anthropic. Heterogeneidad multi-área + multi-perfil. Foco: validar la torre FinOps con un piloto manejable.

**Post-v1 (no en este roadmap, pero diseñamos hacia ahí)**: ampliación a toda la organización Atlax (200+ usuarios), multi-IDE (Cursor, Cline, Continue), multi-vendor (OpenAI, Gemini, Vertex, Bedrock), multi-perfil (no solo dev: PM, QA, ops, design).

**Esto cambia prioridades**: items que asumen monocultura Anthropic-CLI bajan en prioridad. Items que preparan multi-vendor (LiteLLM como router) suben de "nice-to-have" a infraestructura central.

### 0.2 Estado de partida (post sesión 2026-05-07)

- 581 tests / 979 expects en verde
- Fix de coste Langfuse v3 mergeado (PR #45)
- Backup automático Postgres operativo
- Reconciliador systemd cada 15min
- LiteLLM en compose pero apagado (faltan 3 env vars)
- Pricing local en `shared/model-pricing.ts` con 3 modelos Anthropic — **gap detectado: falta Opus 4.7**
- Dashboard hermano (`atlax-claude-dashboard`) en producción Cloud Run, sin planning formal documentado, ya consume 8 endpoints de Anthropic Admin API

### 0.3 Hallazgos críticos que orientan el roadmap

| Hallazgo                                                          | Implicación para el roadmap                            |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| Coste real via API existe SOLO para uso API-key, no seats         | Bridge sigue estimando para seats; reconcilia post-hoc |
| Dashboard ya consume 8 endpoints, incluido `cost_report`          | NO duplicar; coordinar puntualmente                    |
| Quotas seats no consultables vía API (H1-H5 refutadas)            | ADR formal documentando límite                         |
| LiteLLM 80% configurado, falta activación gradual                 | Pista para multi-IDE/multi-vendor post-v1              |
| Paralelismo agéntico: 5-7 agentes read-only, 2-3 write coordinado | Reglas operativas codificadas en sprint-template       |
| `MODEL_PRICING` divergente entre proyectos sin alarma             | Test de cross-validación + runbook                     |
| 5 jobs del dashboard sin documentación en su ARCHITECTURE.md      | Deuda del dashboard, NO entra en este roadmap          |

### 0.4 Reglas operativas para el roadmap

- **Sprint = 1 semana** (lun-dom)
- **Sizing**: S (1d) / M (2-3d) / L (4d+ → spike + impl)
- **Capacity por sprint**: 5-7 items LOW + 2-3 items MEDIUM + máximo 1 item HIGH
- **Blast radius matrix**: ver `sprint-template.md`
- **Doble-check contra fuente primaria**: innegociable para schemas/IDs/APIs (lección del experimento)
- **DoR + DoD obligatorios** según `sprint-template.md`

---

## 1. Mapa de sprints

| Sprint | Fechas          | Tema dominante                                 | Items objetivo |
| ------ | --------------- | ---------------------------------------------- | -------------- |
| 17     | 12-may → 18-may | Hardening pricing + activación LiteLLM M1      | 5              |
| 18     | 19-may → 25-may | Coste real (cost_report integrado) + ADR seats | 5              |
| 19     | 26-may → 01-jun | LiteLLM M2 (callback Langfuse) + cross-pricing | 4              |
| 20     | 02-jun → 08-jun | LiteLLM M3 (virtual keys + budgets)            | 4              |
| 21     | 09-jun → 15-jun | Onboarding piloto multi-IDE (M3 → primer dev)  | 4              |
| 22     | 16-jun → 22-jun | Observabilidad del bridge + métricas piloto    | 4              |
| 23     | 23-jun → 29-jun | Spike unificación HTTP bridge↔dashboard        | 3              |
| 24     | 30-jun → 06-jul | Cierre v1 + preparación POST-V1                | 4              |

**Total**: 33 items planificados. Capacity buffer: 10-15% para imprevistos.

---

## 2. Sprint 17 · Hardening pricing + activación LiteLLM M1 (12-may → 18-may)

**Goal verificable**: Cualquier sesión Claude Code de Opus 4.7 aparece en Langfuse con `calculatedTotalCost > 0` y LiteLLM responde `200 OK` en healthcheck con stack arrancado en frío.

### Items

| ID    | Título                                               | Size | Blast | Hallazgo origen | Deps  |
| ----- | ---------------------------------------------------- | ---- | ----- | --------------- | ----- |
| S17-A | Añadir Opus 4.7 a `MODEL_PRICING` con test           | S    | LOW   | A1, gap latente | none  |
| S17-B | Completar 3 env vars LiteLLM en compose + smoke test | S    | LOW   | A5 / GAP H4-A   | none  |
| S17-C | Test cross-validación pricing bridge↔dashboard       | S    | LOW   | GAP H3-A        | S17-A |
| S17-D | ADR-009: límite estructural quota seats Premium      | S    | LOW   | GAP H2-A / A3   | none  |
| S17-E | Documentar invariante I-14 (paralelismo agéntico)    | S    | LOW   | GAP H5-A        | none  |

**Detalles → `docs/roadmap/sprint-17.md`** (creado a continuación)

### Riesgos del sprint

- **S17-B** puede revelar más vars faltantes una vez arranca LiteLLM. Tiempo buffer: si pasa de S a M, mover S17-E a Sprint 18.
- **S17-C** asume acceso read-only al path del dashboard. Si la ruta cambia, requiere ajuste del test.

### Paralelización viable

Los 5 items son LOW + tocan archivos disjuntos. Pueden ejecutarse en paralelo según el patrón validado en el experimento. Estimación: ~4× speedup.

---

## 3. Sprint 18 · Coste real + ADR seats (19-may → 25-may)

**Goal verificable**: El reconciler de cualquier dev tagea cada trace con `cost-source:estimated|api-real` según la fuente disponible. Sesiones API-key tienen `actualCostCents` poblado.

### Items

| ID    | Título                                                     | Size | Blast  | Hallazgo origen | Deps  |
| ----- | ---------------------------------------------------------- | ---- | ------ | --------------- | ----- |
| S18-A | RFC-001: contrato bridge↔Anthropic Admin API (cost_report) | S    | LOW    | GAP H1-A        | none  |
| S18-B | Integrar `cost_report` en `scripts/reconcile-traces.ts`    | M    | MEDIUM | GAP H1-A        | S18-A |
| S18-C | Tag `cost-source:` en hook + reconciler                    | S    | LOW    | GAP H1-B        | S18-B |
| S18-D | Detección divergencia >5% → degradation log                | S    | LOW    | GAP H1-C        | S18-B |
| S18-E | Script `sync-pricing.sh` + entrada en runbook              | S    | LOW    | GAP H3-B/H3-C   | S17-C |

### Riesgos

- **S18-B** introduce dependencia de `ANTHROPIC_ADMIN_API_KEY`. Si no se obtiene, el item se transforma en spike y el sprint se redimensiona.
- **S18-A** dispara RFC porque cambia un contrato de API hacia outbound nuevo.

### Trigger automático de RFC

S18-A dispara RFC porque toca contrato nuevo de API outbound. **Crear `docs/rfcs/RFC-001.md`** al inicio del sprint. Validación con humano antes de S18-B.

---

## 4. Sprint 19 · LiteLLM M2 + cross-pricing consolidación (26-may → 01-jun)

**Goal verificable**: Un request a LiteLLM con virtual key dummy genera observation en Langfuse con `calculatedTotalCost > 0`.

### Items

| ID    | Título                                                             | Size | Blast  | Hallazgo origen   | Deps  |
| ----- | ------------------------------------------------------------------ | ---- | ------ | ----------------- | ----- |
| S19-A | Expandir `litellm/config.yaml` con Sonnet 4.6, Haiku 4.5, Opus 4.7 | S    | LOW    | GAP H4-B revisado | S17-B |
| S19-B | Activar callback Langfuse + verificar shape de observation         | M    | MEDIUM | A5 / GAP H4-B     | S19-A |
| S19-C | ADR-010: milestone plan LiteLLM M1→M3 con criterios de promoción   | S    | LOW    | GAP H4-C          | S19-B |
| S19-D | Tests de regresión schema Langfuse v3 (anti-regresión schema fix)  | S    | LOW    | experimento hoy   | none  |

### Notas

- **S19-D** previene futuros casos como el bug del schema arreglado hoy. Test que afirma que `usageDetails` y `costDetails` tienen las keys correctas.
- LiteLLM en este punto ya está logueando observations pero sin auth multi-usuario. Ese paso es M3 (Sprint 20).

---

## 5. Sprint 20 · LiteLLM M3 — virtual keys + budgets (02-jun → 08-jun)

**Goal verificable**: Admin (jgcalvo) puede emitir una virtual key con budget mensual de $50, y al exceder el budget LiteLLM rechaza requests con 429.

### Items

| ID    | Título                                                             | Size | Blast  | Hallazgo origen | Deps  |
| ----- | ------------------------------------------------------------------ | ---- | ------ | --------------- | ----- |
| S20-A | Endpoint `/key/generate` operativo + UI admin verificada           | M    | MEDIUM | A5 / GAP H4-C   | S19-B |
| S20-B | Test funcional: virtual key con budget agotado → 429               | M    | MEDIUM | DoD             | S20-A |
| S20-C | Atribución de cost por user_api_key_user_id verificada en Langfuse | S    | LOW    | A5              | S20-A |
| S20-D | Mutex en `shared/tools/sandbox.ts` (anti-write concurrente)        | M    | MEDIUM | GAP H5-B        | none  |

### Riesgos

- **S20-A** depende de la BD `litellm` ya provisionada. Verificar antes de empezar el sprint.
- **S20-D** es el último item HIGH-touchy del primer mes — si se complica, mover a Sprint 21.

---

## 6. Sprint 21 · Onboarding piloto multi-IDE (09-jun → 15-jun)

**Goal verificable**: Al menos 1 dev del piloto (no jgcalvo) usa LiteLLM como gateway para Claude Code Y para Cline en VSCode, con coste atribuido en Langfuse a su virtual key.

### Items

| ID    | Título                                                   | Size | Blast | Hallazgo origen | Deps  |
| ----- | -------------------------------------------------------- | ---- | ----- | --------------- | ----- |
| S21-A | Doc `docs/operations/litellm-onboarding.md`              | M    | LOW   | GAP H4-D        | S20-A |
| S21-B | Spike: integración Cline con LiteLLM (1 dev voluntario)  | S    | LOW   | A5              | S21-A |
| S21-C | Extender `pilot-onboarding.sh` con flag `--litellm-mode` | M    | LOW   | GAP O-5         | S21-A |
| S21-D | Definición formal de KPIs del piloto                     | S    | LOW   | GAP O-6         | none  |

### Métricas esperadas al cierre

- Devs con virtual key activa: ≥3
- Sesiones con `source:litellm-gateway` en Langfuse: >100
- Devs reportando issues de adopción: documentadas en runbook

---

## 7. Sprint 22 · Observabilidad del bridge (16-jun → 22-jun)

**Goal verificable**: Existe un dashboard interno en Langfuse que muestra salud del propio bridge: tasa de drift detectado/reparado, latencia del hook, fallos de reconciler en últimas 24h.

### Items

| ID    | Título                                                     | Size | Blast  | Hallazgo origen | Deps         |
| ----- | ---------------------------------------------------------- | ---- | ------ | --------------- | ------------ |
| S22-A | Tag `source:reconciler` en traces emitidos por reconciler  | S    | LOW    | GAP O-4         | none         |
| S22-B | Métricas del propio bridge (degradation events) → Langfuse | M    | MEDIUM | GAP O-3         | none         |
| S22-C | Audit deps `bun-types` + `typescript`                      | S    | LOW    | GAP O-2         | none         |
| S22-D | Dashboard Langfuse documentado: KPIs piloto + salud bridge | M    | LOW    | GAP H2-C / O-6  | S22-A, S22-B |

### Notas

- Sprint con baja complejidad técnica pero alto valor de visibilidad.
- Posible ítem extra si capacity sobra: bump Langfuse stack si hay nueva versión.

---

## 8. Sprint 23 · Spike: contrato HTTP bridge↔dashboard (23-jun → 29-jun)

**Goal verificable**: Decisión arquitectónica formalizada en RFC sobre si bridge expone HTTP de lectura para dashboard. Si sí: contrato de API documentado. Si no: razón documentada.

### Items

| ID    | Título                                                             | Size         | Blast | Hallazgo origen | Deps  |
| ----- | ------------------------------------------------------------------ | ------------ | ----- | --------------- | ----- |
| S23-A | **Spike**: viabilidad bridge → HTTP read-only para dashboard       | M            | LOW   | DASH 7          | none  |
| S23-B | RFC-002: contrato HTTP bridge↔dashboard (decisión)                 | S            | LOW   | S23-A           | S23-A |
| S23-C | Si decisión es "implementar": esqueleto de Hono server (sprint 24) | _proyectado_ | _-_   | _-_             | S23-B |

### Por qué este sprint es spike-heavy

Es la primera vez que hay coordinación técnica real entre proyectos. Antes de comprometerse, validar con datos:

- ¿El dashboard realmente necesita lectura del bridge, o le basta con Anthropic Admin API + CSV?
- ¿Qué endpoints concretos necesitaría?
- ¿Quién es el caller (job de Cloud Scheduler? frontend en SSR?)
- ¿Latencia aceptable?

El spike da respuesta. El RFC formaliza. La implementación (si procede) va en Sprint 24.

---

## 9. Sprint 24 · Cierre v1 + preparación POST-V1 (30-jun → 06-jul)

**Goal verificable**: El bridge tiene un README v1 completo, los KPIs del piloto están medidos, y el backlog POST-V1 está priorizado.

### Items

| ID    | Título                                                             | Size | Blast | Hallazgo origen | Deps                   |
| ----- | ------------------------------------------------------------------ | ---- | ----- | --------------- | ---------------------- |
| S24-A | README v1: documentación cara a usuarios externos                  | M    | LOW   | meta            | _todos los anteriores_ |
| S24-B | Métricas piloto medidas + reporte stakeholders                     | M    | LOW   | GAP O-6         | S22-D                  |
| S24-C | Backlog POST-V1 priorizado (multi-IDE, multi-vendor, multi-perfil) | S    | LOW   | scope expansion | none                   |
| S24-D | Scope review mensual mayo (regla global)                           | S    | LOW   | GAP O-7         | none                   |

---

## 10. Cross-project — Items que dependen de coordinación con `atlax-claude-dashboard`

> Read-only respecto al dashboard. Estos items NO se ejecutan en este roadmap;
> se documentan para que el owner del dashboard decida si los adopta y cuándo.

### CP-1 · Test de cross-validación pricing en CI del dashboard

- **Origen bridge**: S17-C (test que lee el `pricing.ts` del dashboard)
- **Acción dashboard**: añadir el mismo test simétrico (lee `model-pricing.ts` del bridge) para que la divergencia se detecte desde ambos lados
- **Sin esto**: el test del bridge cubre la mitad del problema solamente
- **Effort estimado**: S (1d)

### CP-2 · Exponer endpoint `/api/v1/sessions/:id/actual-cost` en dashboard

- **Origen bridge**: S18-B (reconciler quiere consumir cost_report sin re-hacer la llamada a Anthropic)
- **Alternativa**: el bridge llama directamente a Anthropic Admin API (más simple, requiere `ANTHROPIC_ADMIN_API_KEY` en máquina dev)
- **Decisión pendiente**: qué fuente prefiere el bridge — directa o vía dashboard
- **Resolución sugerida**: spike S23-A debe contestar esto antes de Sprint 18

### CP-3 · Alerta Slack burn-rate >80% (CROSS-PROJECT)

- **Origen bridge**: S18-D + tag de Langfuse
- **Acción dashboard**: el dashboard ya tiene sistema de alertas Slack (CHANGELOG mencionado por DASH). Añadir trigger basado en señal del bridge.
- **Effort estimado**: M (2-3d) en dashboard
- **Pre-requisito**: bridge expone la señal en Langfuse de forma queryable

### CP-4 · Dashboard observabilidad de sesiones (post Sprint 23 spike)

- **Origen bridge**: S23-A spike
- **Acción dashboard**: si el spike concluye que el dashboard necesita lectura del bridge, añadir router `/api/v1/observability` que consume HTTP del bridge o directamente Langfuse API
- **Effort estimado**: L (1-2 sprints en dashboard)
- **Decisión bloqueante**: RFC-002 (S23-B)

### Coordinación operativa

- Los items CP-N van en un canal separado (issue/email/slack) hacia el owner del dashboard cuando se cierre el sprint origen del bridge.
- No se publican PRs en el dashboard desde este roadmap.

---

## 11. Anti-items — qué NO entra en estos 8 sprints

| Anti-item                                                     | Razón                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Migrar hook/reconciler a Cloud Run                            | Viola I-13 (ADR-002). Edge por diseño.                                                |
| Unificación monorepo bridge + dashboard                       | I-13 + cadencias incompatibles (44 PRs vs 15). Análisis en `unification-analysis.md`. |
| LiteLLM para tráfico OAuth de seats (Claude Code interactivo) | ADR-007: SPOF + latencia. Decisión firme.                                             |
| Browser extension → Chrome Web Store                          | Requiere decisión corporativa de MDM fuera del scope.                                 |
| Pricing package npm compartido bridge↔dashboard               | Esquemas distintos. H3-A/B/C cubren el riesgo real.                                   |
| Multi-vendor en LiteLLM (OpenAI, Vertex, Bedrock) antes de v1 | POST-V1. Requiere M3 estable + 2 workloads en producción.                             |
| Quota de seat Premium en tiempo real via API                  | API no expone este dato (H1-H5 de A3). Workaround imposible.                          |
| Audit logs detallados por dev                                 | Requiere Enterprise tier de Anthropic. Fuera de scope financiero.                     |

---

## 12. Backlog POST-V1 (visión, no compromiso)

Items que entrarán al backlog tras cierre del Sprint 24, ordenados por impacto:

1. **Multi-IDE adoption** (Cursor, Continue, Cline) con LiteLLM
2. **Multi-vendor routing** (OpenAI GPT-5.4, Vertex Sonnet 4.6, Bedrock Haiku)
3. **Multi-perfil tracking** (PMs, QA, ops usando Claude.ai web — fuera de Claude Code)
4. **Eventual unification spike** (revisar si M3-mejorado sigue siendo óptimo en 6 meses)
5. **Dashboard ↔ bridge observability bidireccional** (resultado de S23-A)
6. **Compliance tier**: si Atlax escala a Enterprise, integrar Compliance API

---

## 13. Métricas de éxito del roadmap (medibles al final del Sprint 24)

| KPI                                                    | Target | Cómo se mide                               |
| ------------------------------------------------------ | ------ | ------------------------------------------ |
| % traces con `calculatedTotalCost > 0`                 | ≥99%   | Query Langfuse                             |
| % traces con `cost-source:api-real` (sesiones API-key) | ≥80%   | Query Langfuse                             |
| Devs en piloto LiteLLM-mode                            | ≥5     | Conteo virtual keys activas en último 7d   |
| ADRs nuevos                                            | ≥3     | `git log` en `docs/adr/`                   |
| RFCs creados                                           | ≥2     | `git log` en `docs/rfcs/`                  |
| Spikes ejecutados                                      | ≥2     | `git log` en `docs/spikes/`                |
| Tests añadidos                                         | ≥50    | `bun test --coverage` baseline vs final    |
| Sprints completados sin slippage                       | ≥6/8   | Retro de cada sprint                       |
| Items POST-V1 priorizados con owner                    | ≥10    | Lista en `docs/roadmap/post-v1-backlog.md` |

---

## 14. Riesgos del roadmap (revisión al cierre de cada sprint)

| Riesgo                                                              | Probabilidad | Impacto | Mitigación                                          |
| ------------------------------------------------------------------- | ------------ | ------- | --------------------------------------------------- |
| `ANTHROPIC_ADMIN_API_KEY` no obtenida → S18 se posterga             | Media        | Alto    | Plan B: bridge llama Anthropic directo (sprint 18)  |
| Adopción de LiteLLM por devs <30% en Sprint 21                      | Media        | Medio   | Spike de UX onboarding antes de forzar adopción     |
| Anthropic publica nuevos modelos durante Q2-Q3 sin avisar           | Alta         | Bajo    | I-6 + sync-pricing.sh + scope review mensual        |
| Dashboard cambia de planning sin coordinación                       | Media        | Medio   | Comunicación cross-project en cierre de cada sprint |
| Capacity humana de review <10h/semana (vacaciones, otros proyectos) | Alta         | Medio   | Buffer en cada sprint, items LOW son bumpables      |
| Decisión de Atlax sobre Enterprise tier afecta el plan              | Baja         | Alto    | Re-planning si ocurre                               |

---

## 15. Decisiones pendientes (a resolver durante la ejecución)

1. **¿`ANTHROPIC_ADMIN_API_KEY` viene del dashboard o se solicita aparte para el bridge?** — Resolver al inicio de Sprint 18.
2. **¿El bridge debe consumir directo Anthropic API o vía proxy del dashboard?** — Resolver en spike S23-A.
3. **¿Adoptamos sizing C×R formal a partir de Sprint 20?** — Decisión durante retro Sprint 19.
4. **¿`docs/rfcs/` se crea ahora o cuando dispare el primer RFC?** — Lazy creation. RFC-001 dispara la creación en Sprint 18.
5. **¿`docs/spikes/` se crea ahora o cuando dispare el primer spike?** — Lazy creation. Spike S23-A lo dispara.

---

## Apéndice A — Trazabilidad hallazgos → items

| Hallazgo (sesión 2026-05-07)                 | Items derivados                                                      |
| -------------------------------------------- | -------------------------------------------------------------------- |
| H1 cost_report Anthropic API                 | S18-A, S18-B, S18-C, S18-D                                           |
| H2 quotas seats no consultables              | S17-D (ADR-009)                                                      |
| H3 bridge↔dashboard complementarios          | S17-C, S18-E, CP-1, CP-2, CP-3, CP-4                                 |
| H4 LiteLLM activación gradual                | S17-B, S19-A, S19-B, S19-C, S20-A, S20-B, S20-C, S21-A, S21-B, S21-C |
| H5 paralelismo agéntico límites              | S17-E (I-14), S20-D, sprint-template.md                              |
| Gap latente Opus 4.7 en MODEL_PRICING (A1)   | S17-A                                                                |
| Anti-regresión schema Langfuse (experimento) | S19-D                                                                |
| Métricas piloto + onboarding (DASH + GAP-O)  | S21-D, S22-D, S24-B                                                  |

## Apéndice B — Próximos pasos inmediatos

1. **Crear `docs/roadmap/sprint-17.md`** con detalle de los 5 items en formato `sprint-template.md` ✅ (próximo paso de esta sesión)
2. **Validar este roadmap con el usuario** antes de mergear el PR
3. **Commitear roadmap + sprint-17 + extensiones experimento** en una rama
4. **Abrir PR para revisión final**
5. **Tras merge: arrancar Sprint 17 el lunes 12-may-2026**
