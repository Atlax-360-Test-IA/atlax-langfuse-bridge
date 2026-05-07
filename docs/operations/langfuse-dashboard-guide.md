# Dashboard Langfuse — Guía de Observabilidad del Bridge

> **S22-D** — Referencia de queries para el piloto multi-IDE y la salud del bridge.
> Prerequisitos: S22-A (tag `source:reconciler`) + S22-B (trace `bridge-health`).

---

## Traces disponibles

| Nombre del trace      | Origen                  | Frecuencia      | Descripción                                          |
| --------------------- | ----------------------- | --------------- | ---------------------------------------------------- |
| `claude-code-session` | Hook Stop (dev)         | Por sesión      | Uso real de Claude Code — tokens, coste, proyecto    |
| `litellm-acompletion` | LiteLLM callback        | Por llamada API | Llamadas vía gateway — coste, modelo, virtual key    |
| `bridge-health`       | Reconciler (cron 15min) | Una vez al día  | Salud del bridge — drift, reparaciones, degradations |

---

## Queries de referencia

### 1 · Sesiones por dev (KPI adopción)

Filtra por alias de virtual key para ver qué devs usan el gateway:

```
name = "litellm-acompletion"
tags CONTAINS "date:YYYY-MM"
GROUP BY metadata.user_api_key_alias
```

> Reemplaza `YYYY-MM` con el mes en curso. Si `user_api_key_alias` aparece como null,
> el dev usa Anthropic directo (sin gateway).

---

### 2 · Salud del bridge — última ejecución

Obtiene el estado más reciente del reconciler:

```
name = "bridge-health"
ORDER BY createdAt DESC
LIMIT 1
```

**Campos clave en `metadata`:**

| Campo              | Tipo    | Significado                                 |
| ------------------ | ------- | ------------------------------------------- |
| `candidates`       | number  | Sesiones detectadas en la ventana de 24h    |
| `drift`            | number  | Sesiones con drift detectado                |
| `repaired`         | number  | Sesiones reparadas exitosamente             |
| `failed`           | number  | Sesiones que fallaron en reparación         |
| `degradationCount` | number  | Nº de eventos de degradación en el scan     |
| `degradations`     | array   | Detalle de cada degradación (type, message) |
| `windowHours`      | number  | Ventana temporal del scan (default: 24h)    |
| `dryRun`           | boolean | Si el scan fue en modo dry-run              |

**Tags:**

| Tag                 | Cuándo aparece                             |
| ------------------- | ------------------------------------------ |
| `status:ok`         | Sin drift no reparado ni degradaciones     |
| `status:degraded`   | `failed > 0` o `degradations.length > 0`   |
| `source:reconciler` | Siempre (identifica trazas del reconciler) |
| `date:YYYY-MM-DD`   | Fecha del scan (para filtros temporales)   |

---

### 3 · Tasa de drift semanal (KPI salud bridge)

Calcula la tasa de reparación sobre la última semana:

```
name = "bridge-health"
fromTimestamp = -7d
→ SUM(metadata.repaired) / SUM(metadata.drift)
```

> Objetivo: ≥ 95 %. Si `drift = 0`, la tasa es 100 % (no hay drift).

---

### 4 · Días con `status:degraded` (KPI salud bridge)

```
name = "bridge-health"
tags CONTAINS "status:degraded"
fromTimestamp = -30d
→ COUNT(DISTINCT date(createdAt))
```

> Objetivo: 0 días consecutivos con degraded.

---

### 5 · Divergencia coste estimado vs real

El reconciler emite logs `reconcile:cost-comparison` como tags en el trace `bridge-health`:

```
name = "bridge-health"
metadata.divergencePct EXISTS
ORDER BY createdAt DESC
LIMIT 30
→ AVG(metadata.divergencePct)
```

> Objetivo: < 5 % global. Divergencias > 10 % en un día concreto merecen revisión
> del pricing en `shared/model-pricing.ts`.

---

### 6 · Cobertura IDE (KPI adopción)

Detecta devs que usan un IDE distinto de Claude Code:

```
name = "litellm-acompletion"
metadata.user_api_key_alias != null
metadata.user_api_key_alias != "claude-code"
GROUP BY metadata.user_api_key_alias
```

> Objetivo: ≥ 1 dev con alias distinto (Cline, Continue, Cursor).

---

### 7 · Tiempo hasta primer trace por dev (KPI adopción)

```
name = "litellm-acompletion"
GROUP BY metadata.user_api_key_alias
→ MIN(createdAt) - onboarding_date
```

> El `onboarding_date` se obtiene de Slack / registro del piloto.
> Objetivo: < 30 min desde que el dev ejecuta `pilot-onboarding.sh`.

---

## Alertas recomendadas (Langfuse Alerts)

| Alerta                     | Condición                          | Acción                                    |
| -------------------------- | ---------------------------------- | ----------------------------------------- |
| Bridge degraded 2+ días    | `status:degraded` en 2 días consec | Revisar logs del reconciler en systemd    |
| Drift > 20 % en una semana | `drift/candidates > 0.2` (7d avg)  | Ampliar `WINDOW_HOURS` o depurar hook     |
| Cost divergence > 10 %     | `divergencePct > 10`               | Actualizar `shared/model-pricing.ts`      |
| Budget dev > 80 %          | `spend/max_budget > 0.8`           | Notificar dev; admin puede ampliar budget |

---

## Acceso a la API de Langfuse (consultas programáticas)

```bash
# Variables
PK=<langfuse-public-key>
SK=<langfuse-secret-key>
AUTH=$(echo -n "$PK:$SK" | base64)
HOST="http://localhost:3000"

# Último bridge-health
curl -s "$HOST/api/public/traces?limit=1&name=bridge-health&orderBy=createdAt:desc" \
  -H "Authorization: Basic $AUTH" | jq '.data[0] | {id, tags, metadata}'

# Sesiones por dev (último mes)
curl -s "$HOST/api/public/traces?limit=500&name=litellm-acompletion" \
  -H "Authorization: Basic $AUTH" \
  | jq '[.data[].observations[0].metadata.user_api_key_alias] | group_by(.) | map({alias: .[0], count: length})'

# Días con status:degraded en últimos 30 días
curl -s "$HOST/api/public/traces?limit=100&name=bridge-health&tags=status:degraded" \
  -H "Authorization: Basic $AUTH" \
  | jq '[.data[].createdAt | .[0:10]] | unique | length'
```

---

## Runbook de diagnóstico rápido

### Bridge degraded — pasos

1. Consultar el último trace `bridge-health` → leer `metadata.degradations`
2. Revisar logs del reconciler: `journalctl --user -u atlax-langfuse-reconcile.service -n 100`
3. Si `failed > 0`: comprobar conectividad Langfuse → `curl $LANGFUSE_HOST/health`
4. Si `degradationCount > 0` por pricing: actualizar `shared/model-pricing.ts`

### Drift no reparado > 5 %

1. Ampliar ventana: `WINDOW_HOURS=72` en `~/.atlax-ai/reconcile.env`
2. Ejecutar reconciler manual: `bun run scripts/reconcile-traces.ts`
3. Verificar JSONL del dev en `~/.claude/projects/`

---

_Definición formal: S22-D (Sprint 22, 2026-05-07). Depende de S22-A + S22-B (ambos mergeados)._
