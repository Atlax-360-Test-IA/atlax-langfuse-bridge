# ADR-011 · Límites operativos del paralelismo agéntico (Claude Code + subagentes)

- **Status**: Accepted
- **Date**: 2026-05-07
- **Implements**: I-14
- **Supersedes**: —
- **Superseded by**: —
- **Scope**: all (aplica a todos los proyectos Atlax con desarrollo centaur)
- **Related**: [ADR-001](./ADR-001-bun-cero-deps.md) (autonomía y simplicidad), [ADR-002](./ADR-002-edge-core-split.md) (separación edge/core)

## Context

El 2026-05-07 se ejecutó un experimento controlado de paralelismo agéntico en
`atlax-langfuse-bridge`. El objetivo era cuantificar el speedup real de lanzar
múltiples subagentes Claude Code en paralelo frente a la ejecución secuencial.

Resultados documentados en
`docs/experiments/2026-05-07-parallel-subagent-experiment.md`:

| Configuración                           | Speedup | Observaciones                                            |
| --------------------------------------- | ------- | -------------------------------------------------------- |
| N=3 agentes (read-only)                 | 2.18×   | Sin colisiones, resultados coherentes                    |
| N=5 agentes (read-only)                 | 3.90×   | Sin colisiones, un timeout recuperado                    |
| N=7 agentes (read-only)                 | 4.75×   | Límite práctico: contexto satura, 1 respuesta incompleta |
| N=2 agentes (write, archivos disjuntos) | 1.8×    | Viable con coordinación explícita                        |
| N=3 agentes (write, archivos disjuntos) | ~2.0×   | Viable, requiere revisión humana antes de merge          |
| N=2 agentes (write, mismo archivo)      | —       | **PROHIBIDO**: race condition garantizada                |

### Hallazgos críticos

1. **Límite de contexto**: con N≥7 agentes leyendo simultáneamente, el contexto
   del orquestador se satura y las respuestas de los últimos agentes se truncan.
   Límite práctico: **N≤5 para read-only, N≤3 para write coordinado**.

2. **Doble-check obligatorio**: un subagente (A4) sugirió usar `usage.totalCost`
   en lugar de `usageDetails`+`costDetails` para el payload Langfuse — incorrecto.
   El error fue detectado por el orquestador al verificar contra la documentación
   oficial. Sin doble-check, hubiera llegado a producción.

3. **Blast Radius Matrix**: la paralelización es segura solo cuando los archivos
   son disjuntos. Se formalizó una matriz LOW/MEDIUM/HIGH:
   - **LOW**: archivos completamente disjuntos → paralelo sin restricciones
   - **MEDIUM**: comparten módulo `shared/` o fichero de config → máx. N=2, revisión humana
   - **HIGH**: mismo archivo o contrato de API → secuencial obligatorio

4. **Speedup marginal decreciente**: el speedup se aplana a partir de N=5.
   El overhead de coordinación (context switches del orquestador, síntesis de
   resultados) hace que N>7 sea contraproducente.

### Alternativas consideradas

1. **Siempre secuencial**: máxima seguridad, sin riesgo de race conditions.
   - Descartado: factor 3-4× de pérdida de productividad en tareas paralelas
     como audits, tests de cobertura o migraciones de múltiples módulos.

2. **Paralelo sin límites**: máximo speedup teórico.
   - Descartado: el incidente A4 (schema incorrecto sugerido por subagente)
     confirma que más agentes = más superficie de error sin orquestación.

3. **Paralelo con límites y doble-check** (elegida):
   - Mantiene speedup real (2-4×) con riesgo controlado.
   - El orquestador siempre sintetiza y verifica resultados antes de aplicar.

## Decision

Formalizar los límites operativos del paralelismo agéntico como invariante I-14.
Aplicar en todos los proyectos Atlax donde se use Claude Code como orquestador
con subagentes.

**Reglas operativas:**

1. **N≤5 agentes read-only** en una misma tanda. Si se necesitan más, dividir en
   dos tandas secuenciales con síntesis intermedia.

2. **N≤3 agentes write** simultáneos, solo con archivos completamente disjuntos
   (verificado en la Blast Radius Matrix del sprint).

3. **Doble-check obligatorio**: el orquestador verifica toda sugerencia de código
   de subagente contra la fuente primaria (documentación oficial, spec, código
   existente) antes de aplicar. Sin doble-check, no se acepta output de subagente
   en `shared/` ni en contratos de API.

4. **Nunca dos agentes en el mismo archivo**: race condition garantizada.
   Si un archivo necesita cambios de dos items distintos, fusionar los cambios
   en un único agente o hacer secuencial.

5. **Síntesis siempre en el orquestador**: los subagentes devuelven resultados,
   el orquestador decide. Nunca delegar la decisión final a un subagente.

## Consequences

**Positivas:**

- Speedup real de 2-4× en sprints con items paralelos (confirmado por experimento).
- Doble-check previene regresiones del tipo A4 (schema incorrecto).
- Límites claros reducen la carga cognitiva del orquestador.

**Negativas:**

- Requiere que el orquestador mantenga una Blast Radius Matrix por sprint.
- El doble-check añade latencia en items que tocan `shared/` o contratos de API.
- N≤5 puede ser conservador para tareas puramente read-only — revisable si el
  experimento se replica con N=9 en un sprint futuro.

**Cómo aplicar:**

En cada sprint, antes de lanzar agentes en paralelo:

1. Listar archivos afectados por cada item.
2. Clasificar blast radius (LOW/MEDIUM/HIGH).
3. Solo lanzar en paralelo items LOW con archivos disjuntos.
4. Verificar output de cada subagente antes de mergear.
