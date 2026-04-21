# Fase 1 — Handoff (recarga rápida de contexto)

> Este documento es el punto de entrada para retomar Fase 1 en una sesión
> nueva tras reset de terminal. Para el plan completo con justificaciones y
> alternativas: `docs/plan-fase-1-litellm.md`.

## TL;DR

- **Fase 0 cerrada** el 2026-04-21. Bridge Claude Code → Langfuse operativo
  con reconciler systemd + statusline tier + hook SessionStart global.
- **Fase 1 aprobada** con **Modo C (híbrido)**: LiteLLM para workloads
  no-interactivos (Orvian, Atalaya, futuros); hook Stop sigue capturando
  los 38 seats Claude Code CLI sin cambios.
- **Próximo paso: M0** — refactor `MODEL_PRICING` a `shared/model-pricing.ts`
  como PR separado antes de introducir LiteLLM (cierra invariante I-6 del
  proyecto).

## Estado al momento del handoff

| Item                                             | Estado                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| PR Fase 0                                        | [Atlax-360-Test-IA/atlax-langfuse-bridge#1](https://github.com/Atlax-360-Test-IA/atlax-langfuse-bridge/pull/1) — abierto, pending de merge |
| systemd timer `atlax-langfuse-reconcile.timer`   | Activo, cadencia 15min, 3/3 drifts reparados en primer run                                                                                 |
| `~/.atlax-ai/tier.json`                          | Generado (`seat-team / oauth`)                                                                                                             |
| Hook `SessionStart` en `~/.claude/settings.json` | Instalado (3º hook en bloque `startup`)                                                                                                    |
| Branch del plan Fase 1                           | `docs/phase-1-plan` (local, no pushed)                                                                                                     |
| Plan SDD                                         | `docs/plan-fase-1-litellm.md` (este branch)                                                                                                |

## Decisiones cerradas (no revisitar salvo red-flag)

1. **Modo C (híbrido)** — LiteLLM sólo para workloads no-interactivos.
   Seats OAuth preservados. Rechazados Modo A (coste), Modo B (cero valor),
   Modo D (poco rodado).
2. **M0 como PR separado** — `shared/model-pricing.ts` antes de tocar
   LiteLLM. Cierra la duplicación en 3 sitios de la invariante I-6.
3. **Segregación de traces**: `cc-*` (hook) vs `lt-*` (LiteLLM) con tag
   `source:*` para filtrar en dashboards.
4. **Workloads target identificados**: Orvian, Atalaya, otros hijos de
   Orvian. Ver plan §1 y §5.

## Preguntas aún abiertas (aterrizar en implementación)

1. Compliance/GDPR → data residency en LiteLLM config.
2. Volumen mensual actual → extraer de Langfuse para dimensionar budget del
   master key.
3. Virtual keys — ¿gestión centralizada Atlax IT o self-service por tech
   lead? Afecta M3.

## Próxima acción — M0

**Alcance:** refactor local sin tocar docker, config ni dashboards.

**Ficheros a tocar:**

- `shared/model-pricing.ts` (NUEVO) — exporta `MODEL_PRICING` y
  `getPricing(model)`.
- `hooks/langfuse-sync.ts` — importar del shared, eliminar duplicado
  (líneas 63-78 actualmente).
- `scripts/reconcile-traces.ts` — importar del shared, eliminar duplicado
  (líneas 74-87).
- `scripts/validate-traces.ts` — importar del shared, eliminar duplicado.
- `shared/model-pricing.test.ts` (NUEVO) — tests unitarios `bun test`
  cubriendo los 3 familys (opus, sonnet, haiku) + default.
- `CLAUDE.md` — actualizar invariante I-6 (ya no duplicar; nota el cambio).

**Criterios de aceptación:**

- `bun test` pasa.
- Hook manual (`bun run hooks/langfuse-sync.ts < test-payload.json`) sigue
  funcionando idéntico.
- Reconciler dry-run (`DRY_RUN=1 bun run scripts/reconcile-traces.ts`)
  produce el mismo output vs antes del refactor.
- PR a main con título `refactor(pricing): centralizar MODEL_PRICING en
shared/`.

**Modelo recomendado para M0:** Sonnet 4.6 (`/model claude-sonnet-4-6`).
Refactor local, cambios contenidos, ideal para Sonnet. Opus no aporta valor
incremental aquí.

## Comandos operativos clave

```bash
# Verificar estado del reconciler
systemctl --user status atlax-langfuse-reconcile.timer
journalctl --user -u atlax-langfuse-reconcile.service -n 50

# Validación manual pre/post refactor
bun run scripts/validate-traces.ts
DRY_RUN=1 bun run scripts/reconcile-traces.ts

# Tier determinista
cat ~/.atlax-ai/tier.json
bun run scripts/detect-tier.ts

# Git — estado actual
git branch --show-current     # → docs/phase-1-plan
git log --oneline -5
```

## Archivos de contexto obligatorios en la nueva sesión

En orden de importancia:

1. `docs/phase-1-handoff.md` — este archivo (TL;DR + próximo paso).
2. `docs/plan-fase-1-litellm.md` — plan completo + justificaciones.
3. `CLAUDE.md` — invariantes del proyecto (I-1 a I-8).
4. `hooks/langfuse-sync.ts` líneas 63-78 — `MODEL_PRICING` actual.
5. `scripts/reconcile-traces.ts` líneas 74-87 — duplicado de pricing.

## Invariantes que M0 NO debe romper

- I-1 Hook siempre `exit 0`.
- I-2 Idempotencia por `traceId`.
- I-6 Pricing centralizado — **M0 lo cierra** de duplicación a import único.

## Post-M0 → entrar en M1

Tras mergear M0, la siguiente sesión arranca M1 (servicio LiteLLM en
docker-compose). Ese sí merece volver a **Opus 4.7** por cruzar docker +
LiteLLM config + integración Langfuse — ≥3 módulos independientes.
