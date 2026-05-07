# KPIs del Piloto Atlax360 — LiteLLM Gateway

> **Definición formal S21-D**. Métricas de éxito para el piloto multi-IDE
> (Sprint 21-22, jun 2026). Revisión mensual el primer lunes de cada mes.

---

## KPIs de adopción

| KPI                         | Objetivo                                    | Fuente               | Query                                |
| --------------------------- | ------------------------------------------- | -------------------- | ------------------------------------ |
| Devs con virtual key activa | ≥ 3                                         | LiteLLM `/key/list`  | `keys[*].user_id` únicos             |
| Sesiones via gateway        | > 100 / semana                              | Langfuse traces      | `name=litellm-acompletion`           |
| Cobertura IDE               | ≥ 1 IDE alternativo (Cline/Continue/Cursor) | Langfuse metadata    | `user_api_key_alias` ≠ `claude-code` |
| Tiempo hasta primer trace   | < 30 min desde onboarding                   | Langfuse `createdAt` | Primera sesión del dev               |

---

## KPIs de salud del bridge

| KPI                                    | Objetivo            | Fuente                               | Query                         |
| -------------------------------------- | ------------------- | ------------------------------------ | ----------------------------- |
| Tasa de drift reparado                 | ≥ 95 %              | Reconciler logs                      | `repaired / drift`            |
| Sesiones sin trace (drift no reparado) | < 5 %               | Reconciler logs                      | `failed / candidates`         |
| Latencia hook Stop                     | < 5 s (p95)         | Langfuse `createdAt` vs `sessionEnd` | `traceTimestamp - sessionEnd` |
| Degradation events por run             | < 2                 | Bridge-health trace                  | `metadata.degradationCount`   |
| Bridge-health status:degraded          | 0 días consecutivos | Langfuse bridge-health               | tag `status:degraded`         |

---

## KPIs de coste

| KPI                            | Objetivo                        | Fuente                                     | Query                |
| ------------------------------ | ------------------------------- | ------------------------------------------ | -------------------- |
| Divergencia estimado vs real   | < 5 % global                    | Reconciler `cost-comparison` log           | `divergencePct`      |
| Coste seat-only no atribuido   | Documentado (no bloqueante)     | Reconciler `cost-comparison-seat-only` log | presencia del log    |
| Budget medio consumido por dev | < 80 % del `max_budget` mensual | LiteLLM `/key/list`                        | `spend / max_budget` |

---

## Dashboard Langfuse — queries de referencia

### Sesiones por dev via gateway (S22-D)

```
name = "litellm-acompletion"
tags CONTAINS "date:YYYY-MM"
GROUP BY metadata.user_api_key_alias
```

### Salud del bridge — últimas 24h

```
name = "bridge-health"
ORDER BY createdAt DESC
LIMIT 1
→ metadata.failed, metadata.degradationCount, tags[status:*]
```

### Drift rate semanal

```
name = "bridge-health"
fromTimestamp = -7d
→ SUM(metadata.drift) / SUM(metadata.candidates)
```

---

## Criterios de éxito del piloto (exit criteria)

El piloto se considera exitoso cuando durante **2 semanas consecutivas**:

1. ≥ 3 devs generan sesiones via gateway.
2. Tasa de drift reparado ≥ 95 %.
3. 0 días con `status:degraded` en bridge-health.
4. Al menos 1 dev ha usado un IDE alternativo (Cline, Continue o Cursor).
5. La divergencia estimado/real de coste es < 5 % en la ventana completa.

Al cumplirse: promover el gateway a configuración estándar del equipo y
documentar en el runbook como procedimiento de onboarding obligatorio.

---

## Revisión y owner

- **Frecuencia**: semanal (viernes), revisión formal mensual.
- **Owner**: jgcalvo@atlax360.com.
- **Canal de incidencias**: `#atlax-ai-pilot` (Slack).
- **Histórico**: `docs/operations/pilot-reviews/` (crear al primer mes).

---

_Definición formal: S21-D (Sprint 21, 2026-05-07)_
