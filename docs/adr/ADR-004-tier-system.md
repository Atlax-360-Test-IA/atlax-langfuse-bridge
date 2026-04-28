# ADR-004 · Sistema de tier determinista vs billing heurístico

- **Status**: Accepted
- **Date**: 2026-04-10 (retroactiva)
- **Implements**: I-7 (tier determinista), I-8 (no parsear `.credentials.json`)
- **Supersedes**: —
- **Superseded by**: —

## Context

El billing tier (`seat-team`, `vertex-gcp`, `api-direct`, `unknown`) determina
qué cubo de facturación se atribuye a cada sesión. Es la métrica más crítica
del dashboard FinOps — incorrecta significa atribución de coste incorrecta.

### Problema con la inferencia heurística

Inicialmente el bridge inferia el tier en cada turno desde:

- `service_tier` del JSONL (`standard` / `priority`)
- `CLAUDE_CODE_USE_VERTEX` env var
- `ANTHROPIC_API_KEY` env var

Problemas observados en producción:

1. **Inconsistencia entre sesiones del mismo dev**: el mismo dev en la misma
   máquina podía aparecer con tier diferente entre sesiones según qué env vars
   estuvieran activas en ese momento.

2. **`service_tier: priority` no implica overage**: el plan Team incluye un
   subset de uso priority. Solo cuando supera el límite se factura overage.
   No podemos distinguir desde la sesión sola.

3. **Switch de auth durante una sesión**: si el dev hace login con OAuth durante
   una sesión activa, el tier inferido cambia mid-sesión (parcialmente
   `api-direct`, parcialmente `seat-team`).

### Alternativa descartada: parsear `.credentials.json`

`~/.claude/.credentials.json` contiene tokens OAuth de sesión Anthropic.
Tentación inicial: leer el archivo para extraer email del usuario y inferir
tier exacto.

**Problema crítico de seguridad**:

- El archivo contiene secrets de sesión (tokens válidos para llamar a Anthropic API)
- Cualquier código que lo parsea introduce vector de filtración (logs, crash dumps, telemetry)
- Un bug en el parser podría escribir el contenido a stderr (donde lo capturamos para degradation log)
- Compliance: tokens OAuth no deben aparecer en sistemas de observabilidad

### Decisión de fuente autoritativa

El tier debe venir de **una fuente autoritativa actualizada explícitamente**
en momentos conocidos, no inferida en cada turno.

## Decision

### Esquema `~/.atlax-ai/tier.json`

```typescript
type TierFile = {
  tier: "seat-team" | "vertex-gcp" | "api-direct" | "unknown";
  source: "env" | "credentials-exists" | "unknown";
  account: string | null; // Siempre null cuando source=credentials-exists
  ts: string; // ISO 8601
};
```

### Fuentes en orden de precedencia

`scripts/detect-tier.ts` resuelve en este orden:

1. **`CLAUDE_CODE_USE_VERTEX=1`** → `tier: "vertex-gcp"`, `source: "env"`,
   `account: ANTHROPIC_VERTEX_PROJECT_ID` si existe
2. **`ANTHROPIC_API_KEY` set** → `tier: "api-direct"`, `source: "env"`,
   `account: null` (no podemos extraer email del API key sin llamar a Anthropic)
3. **`~/.claude/.credentials.json` existe** → `tier: "seat-team"`,
   `source: "credentials-exists"`, **`account: null` SIEMPRE** (I-8)
4. **Otherwise** → `tier: "unknown"`, `source: "unknown"`, `account: null`

### I-8 — Privacy by design

`scripts/detect-tier.ts` solo comprueba **existencia** del archivo:

```typescript
// I-8: only check existence — never read or parse credentials content.
const credsPath = join(homedir(), ".claude", ".credentials.json");
const credsExists = existsSync(credsPath);
```

`account` queda `null` cuando la fuente es `credentials-exists`. Esto se
verifica explícitamente en `scripts/detect-tier.test.ts:72`.

### Statusline updates

`scripts/statusline.sh` se invoca por Claude Code en cada turno y ejecuta
`detect-tier.ts`. El archivo se actualiza atómicamente vía `Bun.write(.tmp) +
rename()` para evitar lecturas parciales en concurrencia.

### Hook reads tier.json

`hooks/langfuse-sync.ts` lee `tier.json` y emite tags:

- `tier:seat-team | vertex-gcp | api-direct | unknown` (autoritativo)
- `tier-source:env | credentials-exists | unknown` (debug)

### Coexistencia con `billing:*` heurístico

Los tags `billing:anthropic-team-standard | anthropic-priority-overage |
vertex-gcp` se mantienen por **retrocompatibilidad** con dashboards Langfuse
ya construidos por el equipo Atlax. Son heurísticos sobre `service_tier`.

Para dashboards nuevos: usar `tier:*` y `tier-source:*` (autoritativos).

## Consequences

### Lo que se gana

- **Determinismo**: mismo dev en misma máquina → mismo tier reportado siempre
  (a menos que cambie auth explícitamente, lo cual triggea statusline update)

- **Auditable**: `tier.json` puede inspeccionarse offline:

  ```bash
  cat ~/.atlax-ai/tier.json
  ```

- **Privacy by design**: nunca tocamos contenido de `.credentials.json` (I-8).
  Compliance: el bridge no es un sistema que maneje tokens de auth Anthropic.

- **Backwards compatible**: dashboards FinOps existentes con `billing:*`
  siguen funcionando. Migración gradual a `tier:*`.

### Lo que se pierde / restricciones

- **Cambio de tier requiere refresh**: si un dev hace switch a Vertex, debe
  esperar al siguiente turno (statusline) o ejecutar manual:

  ```bash
  bun run scripts/detect-tier.ts
  ```

- **`account` queda `null` para tier `seat-team`**: el dashboard FinOps no
  puede asociar email del dev a sesiones tier `seat-team`. Mitigación: el
  campo `userId` del trace usa `git config user.email` (también en máquina
  dev, también auditable, no es secret).

- **Analytics API Anthropic cubriría esto en el futuro** (R-1 en SDD §14):
  permite obtener email + tier exacto desde la cuenta Anthropic. Solo
  disponible en plan Enterprise.

### Implementa I-7

I-7 formaliza que `~/.atlax-ai/tier.json` es la fuente autoritativa. Tests:

- `scripts/detect-tier.test.ts` (cobertura completa de detectTier)
- `tests/cross-validation.test.ts:90` (consistencia entre detectTier y getBillingTier)

### Implementa I-8

I-8 formaliza que `.credentials.json` solo se comprueba por existencia. Test:

- `scripts/detect-tier.test.ts:72` (`I-8: OAuth tier never reads credentials content — account is always null`)

### Trade-off intencional: precisión vs privacy

Aceptamos que `account` sea `null` para tier `seat-team` para preservar
privacy. Si Atlax360 quisiera precisión exacta de "qué dev tiene qué tier",
debería:

- Adoptar Analytics API Anthropic (Enterprise plan) — opción canónica
- O implementar OAuth flow propio que pida consentimiento explícito al dev
  para extraer email — sobre-ingeniería para el caso actual

## References

- Implementation: `scripts/detect-tier.ts`
- Tests: `scripts/detect-tier.test.ts`, `tests/cross-validation.test.ts`
- Statusline: `scripts/statusline.sh`
- Sprint 7 PR #19 (hardening de seguridad incluyó refuerzo de I-8)
