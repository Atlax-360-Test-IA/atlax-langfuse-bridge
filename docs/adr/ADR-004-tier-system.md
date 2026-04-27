# ADR-004 · Sistema de tier determinista vs billing heurístico

- **Status**: Accepted
- **Date**: 2026-04-10 (retroactiva)
- **Implements**: I-7 (tier determinista en `~/.atlax-ai/tier.json`), I-8 (no parsear `.credentials.json`)

## Context

> _Sección a completar en Fase C: por qué se necesita un tier determinista,
> cuáles son las fuentes de verdad disponibles (env vars, credentials.json,
> headers de Anthropic API)._

El billing tier (`seat-team`, `vertex-gcp`, `api-direct`, `unknown`) determina
qué cubo de facturación se atribuye a cada sesión. Inferirlo heurísticamente
desde `service_tier` o env vars en cada turno produce inconsistencias entre
sesiones del mismo dev. Necesitamos una fuente autoritativa.

`~/.claude/.credentials.json` contiene tokens OAuth de sesión Anthropic — leerlo
es violación de seguridad (filtración accidental, log injection, etc.).

## Decision

> _Sección a completar en Fase C: detalle del esquema tier.json, statusline
> integration, fallbacks._

`scripts/detect-tier.ts` escribe `~/.atlax-ai/tier.json` desde la statusline de
Claude Code en cada turno. El hook lee este archivo como fuente autoritativa.
Schema:

```typescript
type TierFile = {
  tier: "seat-team" | "vertex-gcp" | "api-direct" | "unknown";
  source: "env" | "credentials-exists" | "unknown";
  account: string | null; // siempre null cuando source=credentials-exists (I-8)
  ts: string;
};
```

Fuentes en orden de precedencia:

1. `CLAUDE_CODE_USE_VERTEX=1` → `vertex-gcp`
2. `ANTHROPIC_API_KEY` set → `api-direct`
3. `~/.claude/.credentials.json` exists → `seat-team` (sin parsear contenido)
4. Otherwise → `unknown`

Los tags `billing:*` se mantienen por retrocompatibilidad pero los tags
`tier:*` y `tier-source:*` son la fuente autoritativa para nuevos dashboards.

## Consequences

> _Sección a completar en Fase C: qué garantiza vs alternativas, riesgos._

**Pros**:

- Determinismo: mismo dev en misma máquina → mismo tier reportado siempre
- Auditable: `tier.json` puede inspeccionarse offline
- Seguridad: nunca tocamos contenido de `.credentials.json` (I-8)

**Contras**:

- Cambio de tier (ej. switch a Vertex) requiere refresh manual via statusline
- Tag `account` queda `null` para tier `seat-team` — Analytics API Anthropic
  cubriría esto en el futuro (R-1 en §14)

**Implementa**: I-7 (autoritativo), I-8 (privacy).
