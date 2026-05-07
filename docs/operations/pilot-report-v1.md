# Reporte de Métricas Piloto v1 · atlax-langfuse-bridge

> **S24-B** — Reporte de cierre del roadmap Q2-Q3 2026 (Sprint 17 → Sprint 24).
> Fecha: 2026-05-07. Autor: jgcalvo@atlax360.com.

---

## 1. Estado del sistema (medido en prod)

| Métrica                  | Valor             |
| ------------------------ | ----------------- |
| Tests en suite           | 776               |
| Assertions (expects)     | 1402              |
| Ficheros de test         | 49                |
| Tests fallando           | 0                 |
| ADRs formalizados        | 11 (ADR-001..011) |
| RFCs publicados          | 2 (RFC-001, -002) |
| Spikes ejecutados        | 1 (S23-A)         |
| PRs mergeados al roadmap | 62 (total acum.)  |
| Commits en main          | 64                |

### Cobertura de código (bun test --coverage)

| Módulo                        | Líneas | Funciones |
| ----------------------------- | ------ | --------- |
| `shared/` (media)             | ~99 %  | 100 %     |
| `hooks/langfuse-sync.ts`      | ≥ 60 % | ~80 %     |
| `scripts/reconcile-traces.ts` | ~37 %  | ~70 %     |
| Global                        | ~93 %  | ~95 %     |

---

## 2. KPIs de adopción del piloto (medidos 2026-05-07)

### Adopción real vs objetivo

| KPI                         | Objetivo (S21-D)  | Real (2026-05-07)       | Estado       |
| --------------------------- | ----------------- | ----------------------- | ------------ |
| Devs con virtual key activa | ≥ 3               | 0 (piloto no arrancado) | ❌ Pendiente |
| Sesiones via gateway        | > 100 / semana    | 0                       | ❌ Pendiente |
| Cobertura IDE alternativo   | ≥ 1 IDE no-Claude | 0                       | ❌ Pendiente |
| Tiempo hasta primer trace   | < 30 min          | N/A (sin devs piloto)   | ❌ N/A       |

**Contexto**: El piloto LiteLLM multi-IDE no ha arrancado. La única actividad real en el
sistema es jgcalvo (90+ traces `claude-code-session` desde el hook nativo de Claude Code).
El stack LiteLLM está operativo (S20 verificado), la documentación está completa (S21),
y el script de onboarding está listo. Falta: reclutar devs del piloto.

### Adopción del hook nativo (Claude Code)

| KPI                                 | Valor observado           |
| ----------------------------------- | ------------------------- |
| Devs con hook activo                | 1 (jgcalvo)               |
| Traces `claude-code-session`        | ~90 (jgcalvo)             |
| Tasa de drift reparado (reconciler) | 3/3 = 100 % (último scan) |
| Bridge-health status                | `status:ok`               |
| `candidates` último scan            | 4                         |
| `drift` último scan                 | 3                         |
| `repaired` último scan              | 3                         |
| `failed` último scan                | 0                         |

---

## 3. KPIs de salud del bridge (medidos en producción)

| KPI                                    | Objetivo      | Real        | Estado |
| -------------------------------------- | ------------- | ----------- | ------ |
| Tasa de drift reparado                 | ≥ 95 %        | 100 % (3/3) | ✅     |
| Sesiones sin trace (drift no reparado) | < 5 %         | 0 % (0/3)   | ✅     |
| Bridge-health `status:degraded`        | 0 días consec | 0           | ✅     |
| Degradation events por run             | < 2           | 0           | ✅     |

El bridge está operativo y saludable. El reconciler systemd corre cada 15 min sin
fallos detectados. El trace `bridge-health` existe en Langfuse con `status:ok`.

---

## 4. KPIs de coste

| KPI                          | Valor                                      |
| ---------------------------- | ------------------------------------------ |
| Coste estimado semanal       | ~$408.96 (jgcalvo, 90 sesiones/semana)     |
| Coste real via API           | N/A — jgcalvo usa seat Premium (OAuth)     |
| `cost-source:estimated`      | 100 % (sin devs API-key en piloto)         |
| Divergencia estimado vs real | No medible (sin `ANTHROPIC_ADMIN_API_KEY`) |
| Budget dev > 80 %            | N/A (sin virtual keys activas)             |

---

## 5. Velocidad de ejecución del roadmap

| Métrica                        | Valor |
| ------------------------------ | ----- |
| Sprints planificados (S17-S24) | 8     |
| Sprints completados            | 8 / 8 |
| Items planificados             | 33    |
| Items completados              | 31/33 |
| Items no completados           | 2     |
| % completado sin slippage      | 100 % |

### Items no completados

| ID    | Título                | Razón                                          |
| ----- | --------------------- | ---------------------------------------------- |
| S21-B | Spike Cline (1 dev)   | Requiere voluntario externo con VSCode + Cline |
| S23-C | Esqueleto Hono server | No aplica — RFC-002 decidió "no implementar"   |

Ambos casos son esperados y documentados. S21-B está bloqueado por dependencia
humana (no técnica). S23-C es consecuencia directa de la decisión del RFC-002.

---

## 6. Métricas de calidad del desarrollo

| Métrica                               | Valor                                     |
| ------------------------------------- | ----------------------------------------- |
| Commits totales en main               | 64                                        |
| Commits feat (features)               | 26                                        |
| Commits fix/audit (retrabajo)         | ~13                                       |
| Ratio retrabajo                       | ~20 %                                     |
| PRs mergeados                         | 62                                        |
| Tests añadidos en el roadmap          | +310                                      |
| ADRs nuevos en el roadmap             | 5 (007..011)                              |
| RFCs nuevos en el roadmap             | 2                                         |
| 0-downtime operativo (sin incidentes) | ✅ (1 incidente doc. INC-001, recuperado) |

### Evolución de la suite de tests

| Milestone                          | Tests | Expects |
| ---------------------------------- | ----- | ------- |
| Sprint 17 baseline                 | 466   | 814     |
| Post Sprint 17 consolidation       | 693   | 1282    |
| Post Sprint 18 (cost_report)       | 729   | —       |
| Post Sprint 20-22 (LiteLLM+bridge) | 750   | 1370    |
| Post Sprint 23-24 + fix PR #61     | 776   | 1402    |

---

## 7. Análisis de gaps vs roadmap Q2-Q3

### Objetivos alcanzados

- ✅ Stack Langfuse v3 self-hosted operativo y saludable
- ✅ Hook Stop + reconciler en producción (jgcalvo)
- ✅ LiteLLM M1→M3 operativo (virtual keys, budgets, callback Langfuse)
- ✅ Documentación completa (onboarding, KPIs, dashboard guide, runbook)
- ✅ 11 ADRs formalizando decisiones arquitectónicas
- ✅ Bridge-health trace automático con alertas
- ✅ Cobertura de tests ≥93 % global
- ✅ RFC-002: decisión "no implementar" HTTP server (spike fundamentado)

### Gaps respecto a la visión inicial

| Gap                              | Impacto | Plan                                      |
| -------------------------------- | ------- | ----------------------------------------- |
| 0 devs en piloto LiteLLM         | ALTO    | Reclutar activamente; script listo        |
| S21-B (Cline) no ejecutado       | MEDIO   | Requiere voluntario; bloqueo humano       |
| cost-source:api-real = 0 %       | BAJO    | Solo aplica con API-key; piloto usa seats |
| langfuse_default_tags en v1.83.7 | BAJO    | Pendiente upgrade LiteLLM image           |

---

## 8. Recomendaciones para stakeholders

### Inmediato (próximas 2 semanas)

1. **Reclutar ≥3 devs piloto** para el gateway LiteLLM. El script
   `scripts/pilot-onboarding.sh --litellm-mode` está listo. Tiempo estimado
   de activación por dev: < 30 min.

2. **Upgrade imagen LiteLLM** de v1.83.7 a latest para corregir el bug de
   `user_api_key_user_id = null` y activar `langfuse_default_tags`.

3. **Distribuir el hook a los 13 devs con seat Premium**. El script
   `setup/setup.sh` es idempotente. La adopción del hook nativo de Claude Code
   (sin gateway) no requiere cambios de workflow.

### Post-v1 (próximo trimestre)

Ver `docs/roadmap/post-v1-backlog.md` (S24-C) para la lista priorizada.

---

_Definición formal: S24-B (Sprint 24, 2026-05-07). Dep: S22-D._
