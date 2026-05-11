# Architectural Decision Records (ADR)

Decisiones arquitectónicas formales del proyecto `atlax-langfuse-bridge`.

Formato: [Michael Nygard](https://github.com/joelparkerhenderson/architecture-decision-record/blob/main/locales/en/templates/decision-record-template-by-michael-nygard/index.md) adaptado al ecosistema Atlax360.

## Índice

| ID                                                       | Título                                             | Status   | Implementa | Date       |
| -------------------------------------------------------- | -------------------------------------------------- | -------- | ---------- | ---------- |
| [ADR-001](./ADR-001-bun-cero-deps.md)                    | Bun runtime con cero deps prod                     | Accepted | I-6        | 2026-04-01 |
| [ADR-002](./ADR-002-edge-core-split.md)                  | Topología edge/core (I-13)                         | Accepted | I-13       | 2026-04-26 |
| [ADR-003](./ADR-003-langfuse-idempotent.md)              | Langfuse upsert idempotente por traceId            | Accepted | I-2, I-4   | 2026-04-01 |
| [ADR-004](./ADR-004-tier-system.md)                      | Tier determinista vs billing heurístico            | Accepted | I-7, I-8   | 2026-04-10 |
| [ADR-005](./ADR-005-mcp-stdio-no-sdk.md)                 | MCP stdio sin SDK, JSON-RPC 2.0 a mano             | Accepted | I-10       | 2026-04-12 |
| [ADR-006](./ADR-006-two-layer-consistency.md)            | Eventual consistency 2 capas                       | Accepted | I-1, I-5   | 2026-04-01 |
| [ADR-007](./ADR-007-litellm-optin.md)                    | LiteLLM como gateway opt-in                        | Accepted | —          | 2026-04-06 |
| [ADR-008](./ADR-008-consistency-bounds.md)               | Límites de recuperabilidad — incidente 22-Apr      | Accepted | I-1, I-5   | 2026-04-28 |
| [ADR-009](./ADR-009-seats-quota-structural-limit.md)     | Quota seats Premium — límite estructural API       | Accepted | —          | 2026-05-07 |
| [ADR-010](./ADR-010-litellm-milestone-plan.md)           | LiteLLM milestone plan M1→M3 con exit criteria     | Accepted | —          | 2026-05-07 |
| [ADR-011](./ADR-011-parallel-subagent-limits.md)         | Límites de paralelismo agéntico (I-14)             | Accepted | I-14       | 2026-05-07 |
| [ADR-012](./ADR-012-clickhouse-gce-self-hosted.md)       | ClickHouse self-hosted en GCE para PRO             | Accepted | —          | 2026-05-08 |
| [ADR-013](./ADR-013-serverless-neg-allusers-ingress.md)  | Cloud Run tras Serverless NEG: allUsers + ingress  | Accepted | —          | 2026-05-10 |
| [ADR-014](./ADR-014-cloud-sql-private-only-iap-admin.md) | Cloud SQL private-only + acceso admin vía IAP      | Accepted | —          | 2026-05-10 |
| [ADR-015](./ADR-015-backup-policy-pro.md)                | Política formal backups PRO + drill trimestral     | Accepted | I-5        | 2026-05-10 |
| [ADR-016](./ADR-016-vertex-via-litellm-gateway.md)       | Vertex AI via LiteLLM Gateway — atribución per-dev | Accepted | —          | 2026-05-11 |

## Convención de formato

Cada ADR sigue esta estructura:

```markdown
# ADR-NNN · Título

- **Status**: Accepted | Superseded by ADR-MMM | Deprecated
- **Date**: YYYY-MM-DD (retroactiva si aplica)
- **Implements**: I-N (invariante CLAUDE.md, si aplica)

## Context

Problema, alternativas consideradas

## Decision

Decisión tomada

## Consequences

Qué se gana, qué se pierde, qué invariantes implementa
```

## Reglas

1. **Inmutabilidad**: una vez `Accepted`, un ADR no se edita. Si la decisión cambia,
   se crea un ADR nuevo con `Status: Supersedes ADR-NNN` y el original pasa a
   `Status: Superseded by ADR-MMM`.

2. **Numeración**: monótona creciente, sin gaps. La fecha del ADR puede ser
   retroactiva, pero el número refleja el orden de captura formal.

3. **Referencias cruzadas**: cuando un ADR depende o complementa otro,
   referenciarlo explícitamente en `## Context` o `## Consequences`.

4. **Vinculación con invariantes**: si el ADR formaliza una regla del
   `CLAUDE.md` (I-N), el campo `Implements: I-N` es obligatorio. El test
   `tests/sdd-invariants.test.ts` (Fase D) verifica esta vinculación.
