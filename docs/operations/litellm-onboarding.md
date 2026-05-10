# LiteLLM Gateway — Onboarding para devs del piloto

> **Para**: devs del piloto Atlax360 que quieren usar LiteLLM como gateway
> para Claude Code (y opcionalmente Cline en VSCode).
>
> **Gateway PRO**: `https://litellm.atlax360.ai` — ya está desplegado y operativo.
> No necesitas levantar nada en local. Pide tu virtual key al admin y configura
> las variables de entorno (Pasos 1 y 2).
>
> **Gateway local (opcional)**: si prefieres desarrollo local o necesitas depurar,
> ver [`runbook.md § Operaciones de LiteLLM Gateway (local)`](./runbook.md#operaciones-de-litellm-gateway-local--dev).

---

## ¿Qué cambia con el gateway?

Sin gateway: `Claude Code → Anthropic API`

Con gateway: `Claude Code → LiteLLM (litellm.atlax360.ai) → Anthropic API`

El gateway añade:

- **Virtual key personal** — tu coste se atribuye a tu key en Langfuse.
- **Budget alert** — recibes (o el admin recibe) alerta cuando superas el `soft_budget`.
- **Trazabilidad** — cada sesión aparece en Langfuse con `user_api_key_alias: tu-alias`.

---

## Paso 1 · Obtener tu virtual key

El admin provisiona las keys. Pídele a jgcalvo@atlax360.com que te asigne una.

Para el piloto inicial hay dos workloads disponibles:

| Alias          | Para qué workload    | Budget  | Límites           |
| -------------- | -------------------- | ------- | ----------------- |
| `orvian-prod`  | Orvian (uso general) | $50/30d | 200k TPM, 100 RPM |
| `atalaya-prod` | Atalaya (análisis)   | $20/30d | 100k TPM, 50 RPM  |

Si necesitas una key personalizada para tu equipo, el admin ejecutará:

```bash
# El admin crea tu key en el gateway PRO
LITELLM_MASTER_KEY=$(gcloud secrets versions access latest \
  --secret=litellm-master-key --project=atlax360-ai-langfuse-pro)

curl -s -X POST https://litellm.atlax360.ai/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "<tu-alias>",
    "soft_budget": 50.00,
    "budget_duration": "30d",
    "user_id": "<tu-email>",
    "metadata": {"team": "atlax360", "env": "prod"}
  }' | jq '{key: .key, key_alias: .key_alias}'
```

Recibirás un token con formato `sk-...`. **Guárdalo en tu gestor de secretos.**

---

## Paso 2 · Configurar Claude Code

```bash
# Añadir a ~/.zshrc o ~/.bashrc
export ANTHROPIC_BASE_URL="https://litellm.atlax360.ai"
export ANTHROPIC_API_KEY="sk-<tu-virtual-key>"
```

Reload:

```bash
source ~/.zshrc   # o ~/.bashrc
```

Verifica que Claude Code usa el gateway:

```bash
claude --version
# La sesión siguiente ya pasa por LiteLLM
```

> **Sin gateway activo**: si necesitas seguir trabajando sin gateway (mantenimiento,
> incidencia), restaura las variables originales:
> `unset ANTHROPIC_BASE_URL && export ANTHROPIC_API_KEY=<tu-key-original>`.

---

## Paso 3 · Verificar atribución en Langfuse

Abre una sesión de Claude Code y haz cualquier pregunta. Espera ~30s y comprueba:

```bash
# Buscar tu trace en Langfuse (reemplaza <tu-alias>)
PK=<langfuse-public-key>
SK=<langfuse-secret-key>
AUTH=$(echo -n "$PK:$SK" | base64)

curl -s "https://langfuse.atlax360.ai/api/public/traces?limit=5&name=litellm-acompletion" \
  -H "Authorization: Basic $AUTH" \
  | jq '[.data[] | {alias: .observations[0].metadata.user_api_key_alias, created: .createdAt[0:19]}]'
```

Deberías ver `"alias": "<tu-alias>"` en el resultado.

---

## Paso 4 (opcional) · Cline en VSCode

> **Estado**: spike en progreso (S21-B). Esta sección se completará cuando
> un dev voluntario valide la integración. Mientras, los pasos son:

1. Instalar extensión **Cline** en VSCode.
2. Abrir Settings → Cline → API Provider → seleccionar **OpenAI Compatible**.
3. Configurar:
   - **Base URL**: `https://litellm.atlax360.ai/v1`
   - **API Key**: `sk-<tu-virtual-key>`
   - **Model**: `anthropic/claude-sonnet-4-6`
4. Probar con un prompt sencillo.
5. Verificar que aparece un trace `litellm-acompletion` en Langfuse.

Reportar cualquier problema al canal `#atlax-ai-pilot`.

---

## Consultar tu spend actual

```bash
# Listar información de tu key (replace <tu-alias>)
# Pide la master key al admin si no la tienes
curl -s "https://litellm.atlax360.ai/key/list?key_alias=<tu-alias>" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  | jq '.keys[0] | {key_alias, spend, soft_budget, budget_duration}'
```

---

## Preguntas frecuentes

**¿Qué pasa si agoto mi budget?**

Las requests fallan con `400 Budget has been exceeded`. El admin puede
resetear tu spend o ampliar el `max_budget`. Mientras, recupera tu
`ANTHROPIC_API_KEY` original para no bloquear tu trabajo.

**¿Afecta al rendimiento de Claude Code?**

Latencia añadida: ~5-20ms (gateway local). Imperceptible en uso normal.

**¿Mi key caduca?**

Sí, si se configura `budget_duration` (típicamente 30d). El admin renueva
el budget al inicio de cada mes.

**¿Mis conversaciones se almacenan?**

El contenido de los mensajes se pasa por el gateway en tránsito hacia
Anthropic. Langfuse almacena **metadata** de uso (tokens, coste, modelo),
no el contenido de los mensajes (LiteLLM no envía `input`/`output` al
callback por defecto).

**¿Puedo usar múltiples IDEs con la misma key?**

Sí. La virtual key es un token Bearer estándar — funciona con cualquier
cliente compatible con la API OpenAI (Claude Code, Cline, Continue,
Cursor con proxy).

---

## Resolución de problemas

| Síntoma                                             | Causa probable               | Solución                                                                                   |
| --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `401 Unauthorized`                                  | Key incorrecta o expirada    | Verificar `ANTHROPIC_API_KEY` en env; pedir al admin re-provisionar                        |
| `400 Budget has been exceeded`                      | Spend agotado                | Contactar admin para reset/ampliación                                                      |
| `Connection refused` / `502` en litellm.atlax360.ai | Gateway Cloud Run caído      | Contactar jgcalvo@atlax360.com; status en `gcloud run services list --region=europe-west1` |
| Trace no aparece en Langfuse                        | Callback async — esperar 30s | Refrescar; si persiste >2min, ver logs en Cloud Logging del servicio `litellm`             |
| `user_api_key_alias` null en Langfuse               | LiteLLM v1.83.7 bug          | Upgrade de imagen pendiente; `key_alias` sí llega en metadata de generation                |

---

_Última actualización: pilot-readiness-day0 (2026-05-10) — gateway PRO activo en litellm.atlax360.ai_
