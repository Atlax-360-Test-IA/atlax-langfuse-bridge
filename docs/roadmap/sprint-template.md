# Sprint NN · {Nombre del sprint}

- **Fechas**: YYYY-MM-DD → YYYY-MM-DD (1 semana)
- **Goal del sprint** (1 frase): _qué cambia en el mundo cuando el sprint cierra_
- **Sprint owner**: jgcalvo (centaur: humano + Sonnet 4.6/Opus 4.7 orquestadores)
- **Capacity humano de review**: ~10 horas/semana de review de alta calidad
- **Estado**: Draft / In Progress / Closed

## Goal verificable

Criterio único, binario, observable que determina si el sprint cumplió:

> _Ejemplo: "Cualquier sesión Claude Code nueva tras 12-may aparece en Langfuse con `calculatedTotalCost > 0` automáticamente"._

## Items del sprint

Cada item sigue el formato siguiente (uno por sub-sección H3). El orden es de ejecución sugerido (HIGH primero, paralelizables después).

### S{NN}-{LETRA} · {Título imperativo del item}

| Campo               | Valor                                                     |
| ------------------- | --------------------------------------------------------- |
| **Owner**           | jgcalvo (default) / agente-X / orquestador                |
| **Size**            | S (1d) / M (2-3d) / L (4d+ → descomponer en spike + impl) |
| **Blast radius**    | LOW / MEDIUM / HIGH                                       |
| **Scope tag**       | all / applicable / atlax-langfuse-bridge                  |
| **Dependencies**    | _items que deben cerrarse primero, o "none"_              |
| **Hallazgo origen** | _ej. "GAP H1-A" / "experimento 2026-05-07" / "ad-hoc"_    |
| **ADRs afectados**  | _ej. ADR-002, ADR-009 / "ninguno aplica"_                 |
| **Invariantes**     | _ej. I-2, I-6 / "ninguno aplica"_                         |

#### Descripción

2-3 frases explicando QUÉ y POR QUÉ. No CÓMO (eso va en RFC si aplica).

#### Archivos afectados (sin wildcards)

- `path/to/file1.ts`
- `tests/file1.test.ts`

Si hay >5 archivos, el item es probablemente L → descomponer.

#### Definition of Ready (DoR) — checklist

- [ ] Archivos afectados listados explícitamente (sin wildcards)
- [ ] Invariantes relevantes (I-N) referenciados
- [ ] ADRs que aplican referenciados (o "ninguno aplica")
- [ ] Blast radius clasificado: LOW / MEDIUM / HIGH
- [ ] Criterio de done verificable por CI (test que falla hoy y pasa al terminar)
- [ ] Sin dependencias implícitas con otro item del mismo sprint
- [ ] Si toca `shared/`: aprobación explícita del humano antes de asignar

Si no se cumple cualquier check → item NO entra al sprint.

#### Definition of Done (DoD)

- [ ] Test escrito (al menos 1 test verifica el comportamiento, no solo el código)
- [ ] `bun run check` pasa (typecheck + suite completa)
- [ ] PR mergeado a main vía squash
- [ ] Si cambió un invariante / introdujo nuevo: actualizado `CLAUDE.md` y `ARCHITECTURE.md §10`
- [ ] Si cambió formato de API/schema: doble-check contra docs oficiales realizado
- [ ] Si introdujo nuevo módulo `shared/`: actualizada tabla en `ARCHITECTURE.md §4`
- [ ] Si toca cross-project: comentario en el otro repo señalando el cambio

#### Riesgos / no-objetivos

- **Riesgo**: _qué podría salir mal y cómo mitigarlo_
- **Fuera de scope**: _lo que NO se hará en este item para evitar scope creep_

#### Notas de ejecución

_Espacio para notas durante la ejecución (no requerido al planificar)_

---

## Reglas de paralelización del sprint

Aplicación de Blast Radius Matrix:

| Items LOW | Pueden ejecutarse hasta 5-7 en paralelo si tocan archivos disjuntos |
| Items MEDIUM | Hasta 2-3 en paralelo. Humano revisa diff antes de mergear. |
| Items HIGH | Secuenciales. Un solo item HIGH activo a la vez. Doble-check contra fuente primaria. |

**Regla de oro**: dos items que tocan el mismo archivo NUNCA se ejecutan en paralelo.

## Trigger automático de RFC

Si cualquier item del sprint cumple cualquiera de:

- Toca ≥2 módulos en `shared/`
- Cambia un contrato de API (request/response shape)
- Requiere un nuevo invariante I-N
- Afecta a la arquitectura edge/core (I-13)

→ se crea `docs/rfcs/RFC-NNN.md` antes de implementar. Sin RFC, el item no se implementa.

## Trigger de Spike

Si cualquier item cumple cualquiera de:

- Existen 2+ opciones técnicas válidas sin criterio claro
- Implementación requeriría leer >3 ficheros de docs externas
- Error de diseño costaría >1 sprint de refactor
- Toca una API externa nunca usada en el proyecto

→ se crea `docs/spikes/spike-NNN.md` con timebox de 1 día. El item se reabre tras el spike.

## Métricas del sprint (a llenar al cierre)

| Métrica                                    | Valor                        |
| ------------------------------------------ | ---------------------------- |
| Items planificados                         | _N_                          |
| Items completados                          | _N_                          |
| Items pospuestos / abandonados             | _N_ (con razón)              |
| PRs mergeados                              | _N_                          |
| Tests añadidos                             | _N_ tests / _N_ expect calls |
| ADRs nuevos                                | _N_ (lista)                  |
| Spikes ejecutados                          | _N_ (lista)                  |
| RFCs creados                               | _N_ (lista)                  |
| Tokens consumidos (subagentes)             | _aproximado_                 |
| Wall-clock paralelo vs secuencial estimado | _ratio_                      |

## Retrospectiva (al cierre)

### ¿Qué funcionó?

_3 puntos máximo_

### ¿Qué no funcionó?

_3 puntos máximo_

### Acciones para próximo sprint

_2-3 acciones concretas, no aspiracionales_

### Hallazgos para roadmap maestro

_Items emergentes que no estaban en el plan, ítems descubiertos como necesarios_

---

## Apéndice — Convenciones de naming

- **Branch**: `sprint-NN/<tipo>-<topic-corto>` (ej. `sprint-17/feat-cost-report-integration`)
- **Commit**: conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`)
- **PR title**: máx. 70 chars, conventional prefix
- **Item ID**: `S{NN}-{A,B,C,...}` (ej. `S17-A`, `S17-B`)

## Apéndice — Formato de PR para trazabilidad bidireccional

Cada PR de un item de sprint incluye:

```markdown
## Summary

- ...

## Item ID

S{NN}-{LETRA} — link al item en `docs/roadmap/sprint-NN-*.md#sNN-letra`

## Related

- ADR: ADR-NNN / none
- RFC: RFC-NNN / none
- Spike: spike-NNN / none
- Hallazgo origen: ...

## Test plan

- [ ] ...
```
