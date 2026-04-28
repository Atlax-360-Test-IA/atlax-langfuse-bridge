# ADR-007 · LiteLLM como gateway opt-in, no en el flujo CLI principal

- **Status**: Accepted
- **Date**: 2026-04-06 (retroactiva)
- **Implements**: — (decisión de arquitectura, no formaliza invariante específico)
- **Supersedes**: —
- **Superseded by**: —

## Context

LiteLLM proxy ofrece capacidades atractivas para gestión FinOps:

- **Virtual keys per-workload** con soft budget alerts
- **Callback Langfuse unificado** (toda llamada genera trace)
- **Rate limiting per-key** (TPM/RPM)
- **Cache-as-you-go** vía Redis compartido

Tentación inicial: rutar **todo el tráfico Claude Code** por LiteLLM para
tener control central de presupuesto, rate limits, y observabilidad
unificada.

### Problemas con la centralización vía LiteLLM

1. **Rompe el flujo OAuth de los seats**: los 38 devs autentican con email
   corporativo en Anthropic vía OAuth. LiteLLM gateway requiere API key, no
   OAuth. Forzar gateway implicaría:
   - Generar y rotar API keys per-dev (operación adicional)
   - Romper el modelo de auth ya establecido por Atlax360
   - Confusión entre tier "seat-team" (OAuth) y "api-direct" (key)

2. **Punto único de fallo crítico**: si LiteLLM cae, los 38 devs no pueden
   usar Claude Code. Single point of failure inaceptable para herramienta
   de trabajo diario.

3. **Latencia añadida**: gateway + proxy añade ~100-200ms por llamada. Para
   ediciones interactivas en Claude Code, es perceptible.

4. **Coste operativo**: LiteLLM stack añade una BD postgres extra, pod redis
   adicional, y posiblemente otro Cloud Run service en PRO.

5. **Pricing duplicado**: LiteLLM usa sus propios precios internos para
   budget alerts. `shared/model-pricing.ts` es la SSoT (I-6) para hook y
   reconciler. Forzar todo por LiteLLM crearía dos pricing systems.

### Workloads que SÍ se benefician de LiteLLM

Hay un subset claro de workloads donde LiteLLM aporta valor:

- **Orvian** (coordinator backend) — workload programático, presupuesto
  cuantificable, opera sin terminal interactivo
- **Atalaya** (analytics backend) — similar
- **MCP servers backend** — corren en server-side, no interactivos
- **Tests E2E que verifican el callback Langfuse** — necesitan que el flujo
  completo funcione

Estos workloads se benefician de:

- Budget alerts (no overrun accidental por loop)
- Rate limiting (no DoS al provider por bug)
- Trazabilidad unificada (mismo project Langfuse que el flujo CLI)

## Decision

### Gateway opt-in vía profile docker-compose

LiteLLM gateway se activa **explícitamente**:

```bash
docker compose --profile litellm up -d
```

Sin el profile, el stack Langfuse arranca sin LiteLLM. Esto garantiza:

- **Default seguro**: nuevos devs/instalaciones no tienen LiteLLM por
  accidente
- **Sin ramp-up forzado**: workloads CLI siguen funcionando sin tocar el
  gateway
- **Recuperación trivial**: si LiteLLM da problemas, `docker compose stop
litellm` y los workloads CLI siguen funcionando

### Política de routing por workload

| Workload                               | Por LiteLLM? | Razón                                         |
| -------------------------------------- | ------------ | --------------------------------------------- |
| **Claude Code CLI** (los 38 devs)      | NO           | OAuth directo a Anthropic                     |
| **Hook Stop** (`langfuse-sync.ts`)     | NO           | Escribe directo a `LANGFUSE_HOST`             |
| **Reconciler** (`reconcile-traces.ts`) | NO           | Escribe directo a `LANGFUSE_HOST`             |
| **Orvian backend**                     | SÍ           | Workload no-interactivo, budget cuantificable |
| **Atalaya backend**                    | SÍ           | Workload no-interactivo, budget cuantificable |
| **MCP servers backend**                | SÍ           | Workload no-interactivo                       |
| **Tests E2E** (smoke-litellm-langfuse) | SÍ           | Verifica el callback Langfuse del gateway     |

### Virtual keys per-workload

`scripts/provision-keys.ts` provisiona virtual keys idempotentes:

```typescript
const WORKLOADS = [
  {
    alias: "orvian-prod",
    workload: "orvian",
    soft_budget: 50,
    tpm: 200_000,
    rpm: 100,
  },
  {
    alias: "atalaya-prod",
    workload: "atalaya",
    soft_budget: 20,
    tpm: 100_000,
    rpm: 50,
  },
];
```

Las keys persisten en `~/.atlax-ai/virtual-keys.json`. Re-ejecutar el script
es seguro (idempotente — keys existentes se saltan).

### LITELLM_SALT_KEY inmutable

`LITELLM_SALT_KEY` cifra las virtual keys persistidas en la BD del gateway.
**Cambiarla invalida TODAS las virtual keys ya emitidas** — devs ven
`Forbidden 401` hasta re-provisionar.

Documentado como inmutable en `docs/operations/runbook.md` y en el `.env.example`.

### Pricing dual aceptado

`shared/model-pricing.ts` sigue siendo SSoT para hook/reconciler (I-6).
LiteLLM usa sus propios precios internos para budget alerts. Aceptamos esta
duplicación porque:

- LiteLLM solo cubre workloads cuantificables (no el flujo CLI)
- El drift entre ambos no afecta el reporting FinOps principal (que usa
  hook/reconciler)
- Ambos consumen tags `billing:*` y `tier:*` consistentemente vía el
  callback Langfuse
- Cross-validation en el smoke test (`scripts/smoke-litellm-langfuse.ts`)

## Consequences

### Lo que se gana

- **Cero impacto sobre los 38 devs si LiteLLM cae**: workloads CLI
  funcionan sin gateway. La caída es contenida a workloads programáticos.

- **Virtual keys + soft budget útiles** para workloads que pueden tener
  loops o bugs costosos. Orvian/Atalaya operan dentro de presupuesto
  controlado.

- **Callback Langfuse unifica trazas**: las llamadas vía gateway aparecen
  en el mismo project Langfuse, con tag `source:litellm-gateway` que las
  distingue de las del flujo CLI.

- **Onboarding gradual**: nuevos workloads pueden adoptar el gateway sin
  forzar a los devs a cambiar nada.

- **Decisión reversible**: si en el futuro el gateway se decide quitar,
  `docker compose --profile litellm down` lo apaga sin afectar nada más.

### Lo que se pierde / restricciones

- **Dos sistemas de pricing** (LiteLLM interno + `shared/model-pricing.ts`):
  riesgo de drift. Mitigación: smoke test cross-validation en CI.

- **`LITELLM_SALT_KEY` inmutable**: cambiarla = invalidar todas las virtual
  keys. Documentado como restricción operativa. Mitigación: el setup script
  lo genera una sola vez y el `runbook` lo destaca como NO rotar.

- **No hay control central de budget para los 38 devs CLI**: si Atlax360
  quisiera "presupuesto compartido del Team", requeriría rutear el flujo
  CLI por LiteLLM (revisar este ADR). Por ahora, los seats Team tienen su
  propio overage tracking en Anthropic console.

- **Operación adicional**: el gateway añade postgres BD extra, redis pod
  compartido, y un container más. En PRO añade un Cloud Run service más.

### Decisión consciente: coexistencia de pricing

La duplicación entre LiteLLM pricing y `shared/model-pricing.ts` es
**aceptable** porque:

1. LiteLLM solo cubre workloads cuantificables (no flujo CLI)
2. El drift entre ambos no afecta el reporting FinOps principal
3. Cross-validation en smoke test reduce la probabilidad de drift no-detectado
4. Si Anthropic cambia precios, ambos lugares se actualizan en el mismo
   commit (ver mantenimiento en CLAUDE.md)

### Reconsiderar este ADR si...

- Atlax360 decide adoptar **presupuesto central compartido** para los 38
  devs (forzaría rutear CLI por LiteLLM)
- LiteLLM publica una versión sin gateway dependency (poco probable)
- El número de workloads no-CLI crece a >10 (revisar arquitectura)

## References

- LiteLLM config: `docker/litellm/config.yaml`
- Provision script: `scripts/provision-keys.ts`
- Smoke test: `scripts/smoke-litellm-langfuse.ts`
- Runbook: `docs/operations/runbook.md` (sección LiteLLM)
- Sprint LiteLLM M1-M3: PRs #3, #5, #6
