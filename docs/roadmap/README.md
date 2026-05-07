# Roadmap — atlax-langfuse-bridge

Esta carpeta contiene los documentos de planificación del proyecto. Estructura:

- `README.md` — este archivo (índice)
- `sprint-template.md` — plantilla canónica para definir un sprint nuevo
- `2026-Q2-Q3-bridge-dashboard-coordination.md` — roadmap maestro 8 sprints (12-may → 30-jun 2026)
- `sprint-NN-name.md` — un archivo por sprint (creado al arrancar cada uno)

## Convenciones

- **Sprint = 1 semana** (centaur cadence: humano + AI)
- **Numeración**: sigue la del proyecto (sprint 17 = primer sprint del roadmap actual, post Sprint 16)
- **Branch naming por sprint**: `sprint-NN/<topic>` para items del backlog del sprint
- **Item sizing**: S (1d), M (2-3d), L (4d+). Items L se descomponen en spike + impl.
- **Scope tag obligatorio** en cada item: `all | applicable | <project>`
- **Definition of Ready** (DoR) y **Definition of Done** (DoD) ver `sprint-template.md`

## Mantenimiento

- Cada sprint tiene su retro corta al final (sección "Retro" en su archivo)
- El roadmap maestro se reordena tras cada retro si la realidad cambió
- Hallazgos críticos durante el sprint se loguean en `docs/operations/runbook.md` o como ADR si arquitectónicos
