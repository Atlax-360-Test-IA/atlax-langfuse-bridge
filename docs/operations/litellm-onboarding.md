# LiteLLM Gateway — Onboarding para devs del piloto

> **Para**: devs del piloto Atlax360 que quieren usar LiteLLM como gateway
> para Claude Code (y opcionalmente Cline en VSCode).
>
> **Requisito previo**: el stack Langfuse + LiteLLM ya está levantado por el
> admin del equipo. Si no es así, ver
> [`runbook.md § Operaciones de LiteLLM Gateway`](./runbook.md#operaciones-de-litellm-gateway).

---

## ¿Qué cambia con el gateway?

Sin gateway: `Claude Code → Anthropic API`

Con gateway: `Claude Code → LiteLLM (localhost:4001) → Anthropic API`

El gateway añade:

- **Virtual key personal** — tu coste se atribuye a tu key en Langfuse.
- **Budget alert** — recibes (o el admin recibe) alerta cuando superas el `soft_budget`.
- **Trazabilidad** — cada sesión aparece en Langfuse con `user_api_key_alias: tu-alias`.

---

## Paso 1 · Obtener tu virtual key

El admin provisiona las keys. Pídele que ejecute:

```bash
# El admin crea tu key (ejecutar en el servidor del gateway)
curl -s -X POST http://localhost:4001/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "<tu-alias>",
    "max_budget": 50.00,
    "soft_budget": 40.00,
    "budget_duration": "30d",
    "user_id": "<tu-email>",
    "metadata": {"team": "atlax360"}
  }' | jq '{key: .key, key_alias: .key_alias, max_budget: .max_budget}'
```

Recibirás un token con formato `sk-...`. **Guárdalo en tu gestor de secretos.**

---

## Paso 2 · Configurar Claude Code

```bash
# Añadir a ~/.zshrc o ~/.bashrc
export ANTHROPIC_BASE_URL="http://localhost:4001"
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

> **Sin gateway activo**: si LiteLLM está caído, Claude Code falla. Cuando
> necesites seguir trabajando sin gateway, restaura las variables originales:
> `unset ANTHROPIC_BASE_URL && export ANTHROPIC_API_KEY=<tu-key-original>`.

---

## Paso 3 · Verificar atribución en Langfuse

Abre una sesión de Claude Code y haz cualquier pregunta. Espera ~30s y comprueba:

```bash
# Buscar tu trace en Langfuse (reemplaza <tu-alias>)
PK=<langfuse-public-key>
SK=<langfuse-secret-key>
AUTH=$(echo -n "$PK:$SK" | base64)

curl -s "http://localhost:3000/api/public/traces?limit=5&name=litellm-acompletion" \
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
   - **Base URL**: `http://localhost:4001/v1`
   - **API Key**: `sk-<tu-virtual-key>`
   - **Model**: `anthropic/claude-sonnet-4-6`
4. Probar con un prompt sencillo.
5. Verificar que aparece un trace `litellm-acompletion` en Langfuse.

Reportar cualquier problema al canal `#atlax-ai-pilot`.

---

## Consultar tu spend actual

```bash
# Listar información de tu key (replace <tu-alias>)
curl -s "http://localhost:4001/key/list?key_alias=<tu-alias>" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  | jq '.keys[0]'
```

O en la UI de LiteLLM (si el admin ha habilitado acceso):
`http://localhost:4001/ui` → Keys → buscar tu alias.

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

| Síntoma                               | Causa probable               | Solución                                                                    |
| ------------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `401 Unauthorized`                    | Key incorrecta o expirada    | Verificar `ANTHROPIC_API_KEY` en env; pedir al admin re-provisionar         |
| `400 Budget has been exceeded`        | Spend agotado                | Contactar admin para reset/ampliación                                       |
| `Connection refused localhost:4001`   | Gateway caído                | `docker compose --profile litellm up -d` (el admin)                         |
| Trace no aparece en Langfuse          | Callback async — esperar 30s | Refrescar; si persiste >2min, ver logs: `docker compose logs litellm`       |
| `user_api_key_alias` null en Langfuse | LiteLLM v1.83.7 bug          | Upgrade de imagen pendiente; `key_alias` sí llega en metadata de generation |

---

_Última actualización: S21-A (Sprint 21, 2026-05-07)_
