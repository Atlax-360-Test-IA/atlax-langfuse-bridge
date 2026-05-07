# ADR-009 · Límite estructural de quota en seats Anthropic Premium

- **Status**: Accepted
- **Date**: 2026-05-07
- **Implements**: — (límite externo, no invariante interno)
- **Supersedes**: —
- **Superseded by**: —
- **Scope**: applicable (proyectos Atlax con seats Anthropic Premium Team)
- **Related**: [ADR-004](./ADR-004-tier-system.md) (detección de tier), [ADR-006](./ADR-006-two-layer-consistency.md) (consistency hook + reconciler)

## Context

Atlax360 opera con seats Anthropic **Premium Team** ($100/seat/mes con plan anual).
Cada seat incluye una quota de tokens incluidos. A partir de mayo 2026, el equipo
tiene 10 seats activos (10 devs con Claude Code habilitado).

Durante la sesión del 2026-05-07 se investigó (hipótesis A3) si era posible
obtener la quota incluida por seat vía API de Anthropic para:

1. Alertar proactivamente cuando un dev se acerca al límite mensual.
2. Proyectar cuándo el equipo necesitará más seats vs. aceptar overage.
3. Integrarlo en el dashboard FinOps para mostrar "uso/quota" en lugar de solo "uso".

### Hallazgo: la quota no es consultable por API

Se verificó con dos fuentes independientes:

- **Documentación oficial Anthropic** (mayo 2026): la API de Claude no expone
  endpoints de quota, límites de rate, ni consumo acumulado por cuenta o seat.
- **Comportamiento observado**: las respuestas HTTP de la API Anthropic no incluyen
  headers `X-RateLimit-Limit-*` ni campos similares para quota de seats.

La única fuente de quota disponible es la **factura mensual** (CSV descargable desde
`console.anthropic.com`) que llega post-hoc tras el cierre del mes.

Este es un límite estructural impuesto por Anthropic, no un bug ni una feature
pendiente de implementar.

### Alternativas consideradas

1. **Polling heurístico** (acumular tokens propios y estimar quota):
   - Pros: funciona sin API de Anthropic
   - Contras: solo cubre tokens que el propio bridge registra. Devs sin hook instalado
     tienen consumo invisible. Además, la quota varía por modelo (Opus consume más
     rápido de la quota incluida que Haiku).
   - **Descartado**: demasiado impreciso para ser accionable.

2. **Reconciliación post-hoc contra CSV de factura**:
   - Pros: datos autoritativos, ya parcialmente soportado en dashboard (upload de
     `chatCoworkDaily` CSV).
   - Contras: latencia de 1 mes. No permite alertas proactivas.
   - **Elegida** como workaround a corto plazo.

3. **Esperar a que Anthropic publique la API**:
   - La API de quota está en la hoja de ruta de Anthropic (mencionada en changelog Q1 2026)
     pero sin fecha de GA.
   - **Postura**: revisar en cada sprint mensual. Si la API aparece, reabrir este ADR.

## Decision

**No implementar** consulta de quota vía API de Anthropic mientras no exista el endpoint.

El dashboard FinOps mostrará **solo uso real** (USD gastados, tokens consumidos) sin
comparativa contra quota. La alerta proactiva de "acercándose al límite" queda pospuesta
hasta que Anthropic publique la API o se valide el approach de reconciliación CSV.

## Consequences

**Positivas:**

- No se introduce código que dependa de un endpoint inexistente (evita errores silenciosos).
- El dashboard muestra datos correctos aunque incompletos.

**Negativas:**

- Los devs no pueden ver cuánto de su quota mensual han consumido en tiempo real.
- El equipo de gestión no puede proyectar overage hasta recibir la factura mensual.

**Workaround documentado:**
El dashboard soporta upload del CSV de factura Anthropic (`chatCoworkDaily`).
Descargarlo el primer día de cada mes y subir al dashboard es el proceso manual actual.

## Validez y revisión

Este ADR es válido mientras Anthropic no publique una API de quota consultable.
Revisar en la sesión de Scope Review mensual (primer día de cada mes).
Si se detecta la API: crear ADR-NNN que supersede a este y reabrir el feature en roadmap.

**Última validación**: 2026-05-07
