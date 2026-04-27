# ADR-001 · Bun runtime con cero dependencias en producción

- **Status**: Accepted
- **Date**: 2026-04-01 (retroactiva)
- **Implements**: I-6 (modelo de pricing central)

## Context

> _Sección a completar en Fase C: por qué se eligió Bun, alternativas
> consideradas (Node + tsx, Deno), restricciones del entorno (38 devs en
> Linux/WSL/macOS, hook con timeout 10s duro de Claude Code)._

El hook `Stop` de Claude Code tiene timeout 10s. Cualquier latencia de startup
(carga de deps, JIT, parsing) reduce el budget útil. La resolución del módulo
con dependencias npm añade tiempo de cold-start que el hook no puede absorber.
Adicionalmente, dependencias en producción aumentan el supply-chain risk.

## Decision

> _Sección a completar en Fase C: detalle de la decisión, qué APIs built-in
> de Bun cubren las necesidades (fetch, HTML parser, file I/O, crypto.subtle)._

Adoptar **Bun ≥1.3** como runtime único del hook, scripts operativos y MCP server.
Cero dependencias npm en `dependencies` del `package.json` — solo `devDependencies`
para tipos y herramientas de build. APIs built-in de Bun (`fetch`, `Bun.file`,
`crypto.subtle`, `Bun.spawn`) cubren todas las necesidades.

## Consequences

> _Sección a completar en Fase C: qué se gana, qué se pierde, restricciones
> downstream._

**Pros**:

- Startup ~50ms (vs ~300ms Node + tsx)
- Cero supply-chain risk en producción
- `MODEL_PRICING` única fuente de verdad — sin posibilidad de duplicación via npm package (I-6)

**Contras**:

- Devs deben tener Bun instalado (gestión vía `setup/setup.sh`)
- APIs Bun-específicas no portables a Node sin cambios

**Implementa**: I-6 — al no haber deps npm, el pricing no puede vivir en un paquete externo.
