# Fase 1 — LiteLLM Gateway (plan SDD)

**Estado:** aprobado el 2026-04-21 — listo para implementación.
**Decisión arquitectural:** **Modo C (híbrido)**.
**Autorización M0:** refactor `MODEL_PRICING` compartido como PR separado antes
de tocar LiteLLM.

---

## 1. Contexto y objetivo

Fase 0 está operativa:

- 38 seats Atlax360 → Claude Code CLI → JSONL local → hook Stop →
  Langfuse (+ reconciler cron cada 15 min vía systemd).
- Precisión de coste: **exacta** (tokens reales reportados por Anthropic API).
- Telemetría: **post-hoc** (al cierre de sesión), no en tiempo real.

Fase 1 añade un gateway LiteLLM para capturar **workloads no-interactivos**
que el bridge actual no cubre: agentes backend, SDK programático, MCP servers
externos. Casos de uso ya identificados:

- **Orvian** — Catedral de Patrones / SDD canonical reference; genera
  ejecuciones de agentes no-interactivas sobre documentación y patrones.
- **Atalaya** (nace de Orvian) — workloads automatizados de análisis sobre
  el ecosistema Atlax 360.
- Otros proyectos hijos de Orvian con carga similar, en crecimiento.

Estos workloads necesitan lo que el hook Stop no puede dar: spend tracking
en tiempo real, budget enforcement per-workload, kill-switch, rate-limits,
fallback multi-provider.

## 2. Qué añade LiteLLM vs el bridge Fase 0

| Capability                           | Fase 0                            | Fase 1 (LiteLLM)                   |
| ------------------------------------ | --------------------------------- | ---------------------------------- |
| Spend tracking tiempo real           | ❌ post-sesión                    | ✅ Redis-backed                    |
| Budget enforcement per-user/workload | ❌                                | ✅ virtual keys con cap            |
| Kill-switch                          | ❌                                | ✅ desactivar virtual key          |
| Rate limits per-key (RPM/TPM)        | ❌                                | ✅                                 |
| Model whitelist per-workload         | ❌                                | ✅                                 |
| Fallback Vertex ↔ Anthropic          | ❌ (dev elige env)                | ✅ routing automático              |
| Guardrails/PII filtering             | ❌                                | ✅ hooks pre-request               |
| Observability workloads SDK/backend  | ⚠️ solo si lanzan Claude Code CLI | ✅ cualquier cliente OpenAI-compat |

## 3. Constraints heredadas (invariantes del proyecto)

Referencia: `CLAUDE.md` del repo.

- **I-1** Hook Stop nunca bloquea Claude Code — se preserva (Modo C no toca
  el hook).
- **I-2** Idempotencia por `traceId = cc-${session_id}` — Fase 1 usa prefix
  distinto (`lt-*`) para no colisionar.
- **I-4** Tags UNION en upsert — crítico: traces `cc-*` y `lt-*` se
  mantienen en espacios de ID distintos, sin colisión de tags.
- **I-6** `MODEL_PRICING` duplicado en 3 sitios. **M0 cierra esta deuda
  técnica** antes de meter LiteLLM (4º consumidor).

## 4. Decisión — Modo C (híbrido)

```
Devs con Claude Code CLI      → directo → Anthropic (OAuth seat) → hook Stop → Langfuse
                                                                   [flujo Fase 0 intacto]

Workloads no-interactivos     → LiteLLM → Anthropic API           → callback → Langfuse
(Orvian/Atalaya/agents/SDK)                                        [flujo Fase 1 nuevo]
```

### Por qué Modo C y no los alternativos

| Modo                  | Descripción                             | Descartado porque                                                                                                                   |
| --------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A — gateway exclusivo | `ANTHROPIC_BASE_URL=litellm` para todos | Seats OAuth del plan Team quedan inútiles → coste API directa ~30-40% mayor, sin demanda de enforcement sobre los devs interactivos |
| B — dashboard-only    | LiteLLM lee Langfuse sin interceptar    | No justifica Fase 1; cero valor incremental                                                                                         |
| C — híbrido           | **ELEGIDO**                             | Preserva seats OAuth + captura lo que Fase 0 no puede (workloads server)                                                            |
| D — OAuth passthrough | LiteLLM reenvía OAuth                   | Poco rodado en producción; reconsiderar si Anthropic publica soporte oficial                                                        |

### Segregación en Langfuse

- Hook Stop: `traceId = cc-${session_id}` + tag `source:claude-code-cli`
  (tag nuevo a añadir en M0.5 como refinamiento).
- LiteLLM callback: `traceId = lt-${request_id}` + tag
  `source:litellm-gateway`.
- Dashboards filtran por `source:*` para desglose por tipo de cliente.

## 5. Arquitectura objetivo

```
┌─────────────────────────────────────────────────────────────────┐
│  docker/docker-compose.yml                                       │
│                                                                  │
│  langfuse-web ─┬─ postgres                                       │
│                ├─ clickhouse                                     │
│                ├─ redis  ──────┐  (compartido con LiteLLM)       │
│                └─ minio        │                                 │
│  langfuse-worker               │                                 │
│                                │                                 │
│  litellm  ─────────────────────┤                                 │
│   ├─ Master key: ANTHROPIC_API_KEY corporativa                   │
│   ├─ Callback: Langfuse (host interno)                           │
│   ├─ Postgres: schema litellm_db (misma DB Postgres existente)   │
│   └─ Virtual keys per-workload                                   │
│       ├─ orvian-agents                                           │
│       ├─ atalaya-scrapers                                        │
│       └─ <future-workload>                                       │
└─────────────────────────────────────────────────────────────────┘

Clientes:
  - Claude Code CLI (38 devs)   →  api.anthropic.com (sin cambios, flujo F0)
  - Orvian agents               →  litellm:4000/v1/messages
  - Atalaya workloads           →  litellm:4000/v1/messages
  - SDK/agents/backend futuros  →  litellm:4000/v1/messages
```

### Componentes nuevos (artefactos)

- `docker/litellm/config.yaml` — routing rules, model_list, callbacks,
  budgets default.
- Servicio `litellm` en `docker/docker-compose.yml` — imagen
  `ghcr.io/berriai/litellm:main-stable`.
- Schema separado `litellm_db` en el Postgres existente.
- Master key corporativa — nueva secret en `.env` (servidor-only, no
  distribuir a los devs).
- `shared/model-pricing.ts` — fuente única de pricing (M0).
- Virtual keys emitidas per-workload vía LiteLLM admin API.

### Qué NO cambia

- Hook `hooks/langfuse-sync.ts`.
- Reconciler `scripts/reconcile-traces.ts` + systemd timer.
- Statusline `scripts/statusline.sh` + `~/.atlax-ai/tier.json`.
- Setup script `setup/setup.sh` para los 38 devs.
- Dashboards Langfuse existentes — siguen funcionando, ganan una dimensión
  de filtro (`source:*`).

## 6. Milestones

### M0 — Refactor pricing compartido (PR separado, **autorizado**)

- Crear `shared/model-pricing.ts` exportando `MODEL_PRICING` y helpers.
- Migrar `hooks/langfuse-sync.ts`, `scripts/validate-traces.ts`,
  `scripts/reconcile-traces.ts` a importar del shared.
- Cerrar invariante I-6 (nota en `CLAUDE.md`: ya no duplicar).
- Tests unitarios del helper `getPricing()` cubriendo los 3 familys +
  default.
- PR separado → merge → base para M1+.

### M1 — LiteLLM local dev

- Añadir servicio `litellm` a `docker/docker-compose.yml`.
- `docker/litellm/config.yaml` mínimo: 1 model (Anthropic Sonnet 4.6), 1
  master key.
- Health check + logs accesibles.
- Admin UI accesible en `:4001`.

### M2 — Callback Langfuse

- Configurar callback en `config.yaml` apuntando a Langfuse local.
- Verificar que una llamada de prueba produce trace `lt-*` en Langfuse.
- Asegurar tags `source:litellm-gateway` + `project:*` via metadata del
  request.

### M3 — Virtual keys + budget

- Generar 1 virtual key de prueba con cap $5 + rate limit 10 RPM.
- Verificar kill-switch: desactivar la key → siguiente request falla con 403.
- Documentar el flujo admin (crear/desactivar keys).

### M4 — Pricing compartido en LiteLLM

- Script build-time que genera `config.yaml` pricing desde
  `shared/model-pricing.ts`.
- Test: cambio en shared file → rebuild LiteLLM → nuevo pricing reflejado.

### M5 — Dashboard dual-source

- Vistas Langfuse con filtro `source:claude-code-cli` vs
  `source:litellm-gateway`.
- Desglose de coste por `project:*` cruzado con `source:*`.

### M6 — Docs onboarding

- `docs/litellm-onboarding.md` — cómo un workload nuevo pide virtual key y
  empieza a reportar.
- Ejemplo de código (Python + TypeScript) apuntando a LiteLLM.
- Plantilla de `.env` para Orvian/Atalaya.

**Camino crítico:** M0 → M1 → M2 → M3. M4-M6 son polish y se pueden
paralelizar.

## 7. Fuera de alcance (explícito)

- Migración de seats a API directa (eso sería Modo A, proyecto separado).
- OAuth passthrough (Modo D; revisitar si Anthropic saca soporte oficial).
- Enforcement sobre Claude Code CLI interactivo — no hay dolor probado.
- Despliegue Cloud Run de LiteLLM — Fase 2, junto con Langfuse.
- Integración con billing interno Atlax / Harvest — Fase 3.

## 8. Preguntas abiertas (aterrizar durante implementación)

1. **Compliance/GDPR**: ¿obliga a que los workloads server-side pasen por
   proxy corporativo? Si sí, Modo C sigue siendo correcto, pero hay que
   definir el data residency en LiteLLM config.
2. **Volumen mensual actual**: extraer de Langfuse para dimensionar master
   key budget y alertas.
3. **Virtual keys — ownership**: ¿gestión centralizada (Atlax IT) o
   self-service por tech lead de proyecto? Afecta al diseño del flujo admin
   en M3.

---

## Referencias

- Estado Fase 0: PR
  [Atlax-360-Test-IA/atlax-langfuse-bridge#1](https://github.com/Atlax-360-Test-IA/atlax-langfuse-bridge/pull/1)
- Invariantes proyecto: `CLAUDE.md` (raíz del repo).
- Arquitectura integridad 2 capas: `README.md` §"Arquitectura de integridad".
- Reglas globales modelo + FinOps: `~/.claude/CLAUDE.md` §"Model Cost
  Optimization".
