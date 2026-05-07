# Sprint 17 · Hardening pricing + activación LiteLLM M1

- **Fechas**: 2026-05-12 → 2026-05-18 (1 semana)
- **Goal del sprint**: cualquier sesión Claude Code con Opus 4.7 aparece en Langfuse con `calculatedTotalCost > 0` y LiteLLM responde `200 OK` en `/health/liveliness` con stack arrancado en frío
- **Sprint owner**: jgcalvo
- **Capacity humano de review**: ~10 horas / semana
- **Estado**: Draft (pendiente kick-off)

## Contexto

Primer sprint del roadmap Q2-Q3 2026. Doble objetivo:

1. **Cerrar gaps de la sesión 2026-05-07**: Opus 4.7 no estaba en `MODEL_PRICING` (riesgo de coste 0 silencioso para futuros traces de Opus 4.7), divergencia silenciosa de pricing bridge↔dashboard, falta ADR formal del límite de quotas de seats.
2. **Arrancar LiteLLM M1**: completar las 3 env vars faltantes que dejan al gateway operativo en modo single-key-master.

Todos los items son LOW blast radius. **Paralelización viable**: hasta 5 agentes concurrentes con archivos disjuntos.

## Goal verificable

Al cierre del sprint, ejecutar:

```bash
# 1. Cualquier trace de Opus 4.7 tiene calculatedTotalCost > 0
curl -s -u "$LF_PK:$LF_SK" "$LF_HOST/api/public/observations?limit=10&type=GENERATION" \
  | jq '[.data[] | select(.model | startswith("claude-opus-4-7")) | .calculatedTotalCost] | min'
# Esperado: > 0

# 2. LiteLLM responde 200 OK
curl -s -o /dev/null -w "%{http_code}" http://localhost:4001/health/liveliness
# Esperado: 200

# 3. Test cross-pricing pasa en CI
bun test tests/cross-project-pricing.test.ts
# Esperado: pass

# 4. ADR-009 mergeado
ls docs/adr/ADR-009-*.md
# Esperado: existe

# 5. Invariante I-14 documentado
grep "I-14" CLAUDE.md ARCHITECTURE.md
# Esperado: presente en ambos
```

Si los 5 comandos pasan → sprint exitoso.

## Items del sprint

### S17-A · Añadir Opus 4.7 a MODEL_PRICING con test

| Campo               | Valor                                           |
| ------------------- | ----------------------------------------------- |
| **Owner**           | jgcalvo                                         |
| **Size**            | S (1d)                                          |
| **Blast radius**    | LOW                                             |
| **Scope tag**       | `atlax-langfuse-bridge`                         |
| **Dependencies**    | none                                            |
| **Hallazgo origen** | A1 (gap latente detectado en sesión 2026-05-07) |
| **ADRs afectados**  | ninguno aplica                                  |
| **Invariantes**     | I-6 (model-pricing central)                     |

#### Descripción

Anthropic publicó Opus 4.7 el 17-abr-2026 como flagship (mismo precio que Opus 4.6: $5/$25 input/output por MTok). Nuestro `shared/model-pricing.ts` solo tiene `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4-5`. La función `getPricing()` matchea por substring, así que `claude-opus-4-7` cae al patrón `claude-opus-4` y obtiene el pricing correcto **por accidente**. Pero no hay test que lo asegure — si Anthropic cambia el formato del modelo o el pricing diverge, fallaremos silenciosamente.

#### Archivos afectados

- `shared/model-pricing.ts`
- `shared/model-pricing.test.ts`

#### DoR

- [x] Archivos afectados listados
- [x] Invariantes referenciados (I-6)
- [x] ADRs referenciados (ninguno aplica)
- [x] Blast radius clasificado (LOW)
- [x] Criterio de done verificable por CI (test fallará si Opus 4.7 no tiene pricing)
- [x] Sin dependencias implícitas
- [x] Toca `shared/` → revisado por humano

#### DoD

- [ ] Test añadido: `getPricing("claude-opus-4-7")` y `getPricing("claude-opus-4-7-20260422")` devuelven `{input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25}`
- [ ] Test añadido: `getPricing("claude-opus-4-99")` (futuro hipotético) devuelve el pricing de `claude-opus-4` por substring fallback (documenta el comportamiento)
- [ ] `bun run check` pasa
- [ ] PR mergeado vía squash
- [ ] Si pricing diverge realmente del de Opus 4.6 al confirmar con docs Anthropic: actualizar key separada

#### Riesgos

- **Riesgo**: que Opus 4.7 tenga cache pricing diferente a Opus 4.6 sin documentar. **Mitigación**: doble-check contra docs.anthropic.com antes de implementar.
- **Fuera de scope**: añadir Haiku 4.5.1 u otros modelos no anunciados.

---

### S17-B · Completar 3 env vars LiteLLM en compose + smoke test M1

| Campo               | Valor                                            |
| ------------------- | ------------------------------------------------ |
| **Owner**           | jgcalvo                                          |
| **Size**            | S (1d)                                           |
| **Blast radius**    | LOW                                              |
| **Scope tag**       | `atlax-langfuse-bridge`                          |
| **Dependencies**    | none                                             |
| **Hallazgo origen** | GAP H4-A / análisis A5                           |
| **ADRs afectados**  | ADR-007 (decisión LiteLLM como gateway opcional) |
| **Invariantes**     | ninguno aplica                                   |

#### Descripción

LiteLLM está desplegado en `docker-compose.yml` con profile `litellm` pero arranca `unhealthy` por falta de 3 env vars: `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, `ANTHROPIC_API_KEY`. Activarlo en M1 (modo single-key, solo master) y validar que responde a healthcheck.

**M1 alcanza**: gateway operativo con `master_key` único, sin virtual keys aún. M2 (Sprint 19) añadirá callback Langfuse. M3 (Sprint 20) añadirá virtual keys + budgets.

#### Archivos afectados

- `docker/.env` (no commiteado — añadir solo a documentación)
- `docker/env.example` (template para devs nuevos)
- `docker/litellm/config.yaml` (mantener config actual mínima, sin expansion de modelos hasta Sprint 19)
- `tests/litellm-m1-smoke.test.ts` (nuevo)
- `docs/operations/runbook.md` (sección "Activar LiteLLM M1")

#### DoR

- [x] Archivos afectados listados
- [x] Invariantes referenciados (ninguno aplica)
- [x] ADRs referenciados (ADR-007)
- [x] Blast radius clasificado (LOW)
- [x] Criterio de done verificable por CI (smoke test consulta `/health/liveliness`)
- [x] Sin dependencias implícitas
- [x] No toca `shared/`

#### DoD

- [ ] `env.example` actualizado con las 3 vars + comentarios sobre cómo generarlas
- [ ] Runbook con sección "Activar LiteLLM M1" — comando único `bun run scripts/litellm-m1-up.sh` o equivalente
- [ ] Smoke test: arranca stack con `--profile litellm`, espera health, hace 1 request a `/v1/messages` con master key, valida respuesta 200
- [ ] `bun run check` pasa
- [ ] PR mergeado

#### Riesgos

- **Riesgo**: el smoke test requiere `ANTHROPIC_API_KEY` real para no fallar al hacer la llamada upstream. **Mitigación**: usar mock de Anthropic en el smoke (LiteLLM devuelve respuesta del proxy interno, no necesita llegar a Anthropic real). O skip del test en CI si no hay key.
- **Fuera de scope**: callback Langfuse, virtual keys, expansion de modelos. Eso es M2/M3.

---

### S17-C · Test cross-validación pricing bridge↔dashboard

| Campo               | Valor                                                    |
| ------------------- | -------------------------------------------------------- |
| **Owner**           | jgcalvo                                                  |
| **Size**            | S (1d)                                                   |
| **Blast radius**    | LOW                                                      |
| **Scope tag**       | `applicable` (si el dashboard adopta CP-1 en su roadmap) |
| **Dependencies**    | S17-A (Opus 4.7 añadido al pricing del bridge)           |
| **Hallazgo origen** | GAP H3-A / DASH "MODEL_PRICING divergente"               |
| **ADRs afectados**  | ninguno aplica                                           |
| **Invariantes**     | I-6                                                      |

#### Descripción

`atlax-claude-dashboard` tiene su propio `MODEL_PRICING` en `packages/shared/src/constants/pricing.ts` con esquema distinto pero valores que **deben coincidir** en input/output USD/MTok. Ambos tienen el mismo gap (sin Opus 4.7) confirmando que la divergencia silenciosa es real.

Añadir test en el bridge que lea ambos archivos (path relativo conocido), parsee, y verifique que los precios input/output coinciden en ±1%. Falla CI si divergen.

#### Archivos afectados

- `tests/cross-project-pricing.test.ts` (nuevo)

Path read-only que el test consulta:

- `~/work/atlax-claude-dashboard/packages/shared/src/constants/pricing.ts`

#### DoR

- [x] Archivos afectados listados
- [x] Invariantes referenciados (I-6)
- [x] ADRs (ninguno aplica)
- [x] Blast radius (LOW)
- [x] Criterio de done verificable por CI
- [x] Sin dependencias implícitas
- [x] No toca `shared/`

#### DoD

- [ ] Test ejecuta con `bun test tests/cross-project-pricing.test.ts`
- [ ] Test usa `os.homedir() + "/work/atlax-claude-dashboard/packages/shared/src/constants/pricing.ts"` (sin paths personales hardcoded)
- [ ] Test skip-eable con env var `SKIP_CROSS_PROJECT_TESTS=true` (para CI sin acceso al dashboard)
- [ ] Test verifica modelos comunes: Opus 4.6, Opus 4.7, Sonnet 4.6, Haiku 4.5
- [ ] PR mergeado

#### Riesgos

- **Riesgo**: el path del dashboard puede cambiar. **Mitigación**: test es soft-fail si el archivo no existe (skip + warning, no fail).
- **Fuera de scope**: actualizar el pricing del dashboard. Eso es responsabilidad del dashboard owner.

---

### S17-D · ADR-009: límite estructural quota seats Premium

| Campo               | Valor                                                          |
| ------------------- | -------------------------------------------------------------- |
| **Owner**           | jgcalvo                                                        |
| **Size**            | S (1d)                                                         |
| **Blast radius**    | LOW                                                            |
| **Scope tag**       | `atlax-langfuse-bridge`                                        |
| **Dependencies**    | none                                                           |
| **Hallazgo origen** | GAP H2-A / análisis A3 (5 hipótesis testadas, todas refutadas) |
| **ADRs afectados**  | ADR-009 nuevo                                                  |
| **Invariantes**     | ninguno aplica directamente                                    |

#### Descripción

A3 confirmó con doble fuente independiente que la quota incluida en seats Premium **no es consultable vía API** y solo se conoce post-hoc en factura mensual. Esto es un límite estructural impuesto por Anthropic, no un bug nuestro.

Formalizar en ADR-009 para que futuras decisiones de roadmap no asuman que se puede saber. Incluir workaround documentado: reconciliación post-hoc contra CSV de factura (ya soportado en dashboard via `chatCoworkDaily` upload).

#### Archivos afectados

- `docs/adr/ADR-009-seats-quota-structural-limit.md` (nuevo)
- `CLAUDE.md` (sección de ADRs)
- `ARCHITECTURE.md` (referencia al ADR si aplica)

#### DoR

- [x] Archivos listados
- [x] Invariantes (ninguno aplica directamente)
- [x] ADRs referenciados (ADR-009 nuevo)
- [x] Blast radius (LOW)
- [x] Criterio de done verificable por CI (test sdd-links verifica que ADR-009 existe y está referenciado)
- [x] Sin dependencias implícitas
- [x] No toca `shared/`

#### DoD

- [ ] ADR-009 escrito en formato Nygard (Status, Context, Decision, Consequences)
- [ ] Status: Accepted
- [ ] Scope tag: `applicable` (aplica a cualquier proyecto Atlax con seats Anthropic)
- [ ] Implements: ninguno (es ADR de límite, no de invariante)
- [ ] Referenciado desde CLAUDE.md y ARCHITECTURE.md
- [ ] `tests/sdd-links.test.ts` pasa
- [ ] PR mergeado

#### Riesgos

- **Riesgo**: que Anthropic cambie políticas y publique la API. **Mitigación**: ADR documenta fecha de validación; reabrir si cambia.
- **Fuera de scope**: implementar reconciliación post-hoc. Eso es feature del dashboard, no del bridge.

---

### S17-E · Documentar invariante I-14: paralelismo agéntico

| Campo               | Valor                                                             |
| ------------------- | ----------------------------------------------------------------- |
| **Owner**           | jgcalvo                                                           |
| **Size**            | S (1d)                                                            |
| **Blast radius**    | LOW                                                               |
| **Scope tag**       | `all` (aplica a todos los proyectos Atlax con desarrollo centaur) |
| **Dependencies**    | none                                                              |
| **Hallazgo origen** | experimento 2026-05-07 (`docs/experiments/`) + GAP H5-A           |
| **ADRs afectados**  | ADR-011 nuevo (formaliza la decisión)                             |
| **Invariantes**     | I-14 nuevo                                                        |

#### Descripción

El experimento del 2026-05-07 demostró límites duros del paralelismo agéntico: 5-7 agentes read-only viable, 2-3 write coordinado, doble-check obligatorio contra fuente primaria. Codificar como invariante I-14 para que futuras sesiones lo respeten sin que jgcalvo deba recordarlo cada vez.

#### Archivos afectados

- `CLAUDE.md` (añadir I-14)
- `ARCHITECTURE.md` (añadir fila al §10 con mapeo I-14 → tests/experimento)
- `docs/adr/ADR-011-parallel-subagent-limits.md` (nuevo, scope `all`)
- `tests/sdd-invariants.test.ts` (extender para verificar I-14 está documentado)

#### DoR

- [x] Archivos listados
- [x] Invariantes referenciados (I-14 nuevo)
- [x] ADRs (ADR-011 nuevo)
- [x] Blast radius (LOW)
- [x] Criterio de done verificable por CI (sdd-invariants.test detecta I-14)
- [x] Sin dependencias implícitas
- [x] No toca `shared/`

#### DoD

- [ ] I-14 documentado en CLAUDE.md con: nombre, descripción, Por qué, Código de referencia (link al doc del experimento), Scope tag `all`
- [ ] ADR-011 escrito formato Nygard
- [ ] ARCHITECTURE.md §10 actualizado con fila I-14 → tests/sdd-invariants
- [ ] `tests/sdd-invariants.test.ts` extendido para asertir presencia de I-14
- [ ] `bun run check` pasa
- [ ] PR mergeado

#### Riesgos

- **Riesgo**: I-14 es difícil de testear automáticamente (es una regla operativa, no de código). **Mitigación**: el test verifica que está documentado, no que se cumple en runtime.
- **Fuera de scope**: implementar detección automática de violaciones (ej. >7 agentes en paralelo). Posible item en sprint posterior.

---

### S17-F · Detección de generations sin coste calculado (post-fix blind spot)

| Campo               | Valor                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| **Owner**           | jgcalvo                                                                        |
| **Size**            | M (2-3d)                                                                       |
| **Blast radius**    | MEDIUM                                                                         |
| **Scope tag**       | `atlax-langfuse-bridge`                                                        |
| **Dependencies**    | S17-A (no bloquea pero conviene)                                               |
| **Hallazgo origen** | Operación 2026-05-07 evening: backfill manual reveló blind spot del reconciler |
| **ADRs afectados**  | ADR-006 (two-layer consistency) — añadir nota                                  |
| **Invariantes**     | I-2 (idempotencia traceId)                                                     |

#### Descripción

Tras el fix de schema (PR #45) se descubrió que `classifyDrift` solo compara turns/cost/end del trace pero NO inspecciona si las `generations` internas tienen `calculatedTotalCost > 0`. Resultado: traces sincronizados pre-fix con shape antiguo (calculatedTotalCost=0) quedan permanentemente con coste 0 a menos que tengan otro drift detectable. Esto se detectó cuando el usuario reportó "solo veo costes desde 5-may" tras el fix.

Solución one-shot ya aplicada (script `backfill-historical-traces.ts`). Esta tarea formaliza la detección estructural para que el reconciler periódico cubra el caso por sí solo en futuro.

#### Archivos afectados

- `shared/drift.ts` (añadir `COST_NOT_CALCULATED` al tipo `DriftStatus`)
- `shared/drift.test.ts`
- `scripts/reconcile-traces.ts` (consultar generation y verificar `calculatedTotalCost`)
- `shared/langfuse-client.ts` (posible nuevo `getGenerationsForTrace`)
- `tests/reconcile-traces.test.ts` (caso nuevo)
- `docs/adr/ADR-006-two-layer-consistency.md` (nota sobre nueva clase de drift)

#### DoR

- [x] Archivos afectados listados
- [x] Invariantes referenciados (I-2)
- [x] ADRs (ADR-006 nota)
- [x] Blast radius (MEDIUM — toca `shared/`)
- [x] Criterio de done verificable por CI (test que crea generation con calculatedTotalCost=0 y verifica que reconciler lo detecta)
- [x] Sin dependencias implícitas
- [x] Toca `shared/` → revisado por humano antes de asignar

#### DoD

- [ ] Tipo `DriftStatus` extendido con `COST_NOT_CALCULATED`
- [ ] `classifyDrift` consulta también la primera generation y verifica `calculatedTotalCost > 0` cuando `localCost > 0`
- [ ] Test unitario cubre el nuevo caso
- [ ] Test e2e: trace con shape v3 correcto pero generation sin pricing registrado → ¿qué hace? (decidir: skip, warn, o reparar)
- [ ] Documentación en runbook: cómo distinguir el nuevo estado en logs
- [ ] PR mergeado

#### Riesgos

- **Riesgo**: añadir consultas a generation por cada trace duplica el coste del reconciler. **Mitigación**: solo consultar generation si turns/cost coinciden (es decir, post-checks). O hacerlo solo en una pasada ad-hoc.
- **Fuera de scope**: detectar drift en metadatos de generation (tags, modelos). Solo coste.

---

## Reglas de paralelización del sprint

Los 6 items (5 LOW + 1 MEDIUM) tocan archivos disjuntos:

| Item  | Archivos exclusivos                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S17-A | `shared/model-pricing.ts`, `shared/model-pricing.test.ts`                                                                                                                                               |
| S17-B | `docker/.env`, `docker/env.example`, `tests/litellm-m1-smoke.test.ts`, `docs/operations/runbook.md`                                                                                                     |
| S17-C | `tests/cross-project-pricing.test.ts`                                                                                                                                                                   |
| S17-D | `docs/adr/ADR-009-*.md`, `CLAUDE.md` (sección ADRs), `ARCHITECTURE.md`                                                                                                                                  |
| S17-E | `CLAUDE.md` (sección invariantes), `ARCHITECTURE.md`, `docs/adr/ADR-011-*.md`, `tests/sdd-invariants.test.ts`                                                                                           |
| S17-F | `shared/drift.ts`, `shared/drift.test.ts`, `scripts/reconcile-traces.ts`, `shared/langfuse-client.ts`, `tests/reconcile-traces.test.ts`, `docs/adr/ADR-006-two-layer-consistency.md` (nota, no rewrite) |

**Conflictos detectados**:

- S17-D y S17-E ambos tocan `CLAUDE.md` y `ARCHITECTURE.md`. **No paralelizables entre sí**.
- S17-F toca `shared/drift.ts` y `scripts/reconcile-traces.ts`. Disjunto del resto, paralelizable.

**Estrategia de ejecución**:

1. Ejecutar S17-A, S17-B, S17-C, S17-F en paralelo (4 agentes, archivos disjuntos) — todos LOW excepto S17-F que es MEDIUM
2. Ejecutar S17-D secuencial (toca `CLAUDE.md`)
3. Ejecutar S17-E secuencial después de S17-D (también toca `CLAUDE.md`)

Wall-clock estimado: 1.5 días paralelo (S17-F arrastra al ser MEDIUM) + 1 día secuencial S17-D + 1 día secuencial S17-E = 3.5 días review. Cabe en la semana con buffer reducido.

## Trigger automático de RFC

Ningún item del sprint dispara RFC. Los disparadores (≥2 módulos en `shared/`, cambio contrato API, nuevo I-N que afecte arquitectura, edge/core) no aplican:

- S17-E introduce I-14 pero NO afecta a la arquitectura edge/core (I-13 sigue intacto)
- Ningún item cambia contrato de API
- S17-A toca solo `shared/model-pricing.ts` (1 módulo)

## Trigger de Spike

Ningún item dispara spike. Todas las respuestas técnicas son conocidas o tienen 1 sola opción válida.

## Métricas del sprint (a llenar al cierre)

_Se completan al cerrar el sprint (domingo 18-may)_

| Métrica                                    | Target | Real |
| ------------------------------------------ | ------ | ---- |
| Items planificados                         | 6      | _-_  |
| Items completados                          | 6      | _-_  |
| Items pospuestos                           | 0      | _-_  |
| PRs mergeados                              | 6      | _-_  |
| Tests añadidos                             | ≥6     | _-_  |
| ADRs nuevos                                | 2      | _-_  |
| RFCs creados                               | 0      | _-_  |
| Spikes ejecutados                          | 0      | _-_  |
| Tokens consumidos (subagentes)             | _est_  | _-_  |
| Wall-clock paralelo vs secuencial estimado | _est_  | _-_  |

## Retrospectiva (al cierre)

_A completar al cerrar el sprint_

### ¿Qué funcionó?

- _-_

### ¿Qué no funcionó?

- _-_

### Acciones para Sprint 18

- _-_

### Hallazgos para roadmap maestro

- _-_

---

## Apéndice — Próximo paso

Tras el merge del PR de planning (este sprint y los docs):

1. Crear branch `sprint-17/<item-name>` por cada item
2. Ejecutar S17-A, S17-B, S17-C en paralelo (lanzar 3 agentes con archivos disjuntos)
3. Ejecutar S17-D y S17-E en serie tras los 3 anteriores
4. Cerrar PRs individuales con squash
5. Retro al cierre (domingo 18-may)
