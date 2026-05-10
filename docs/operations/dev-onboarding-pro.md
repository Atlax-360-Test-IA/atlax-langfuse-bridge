# Onboarding PRO — Atlax360 Claude Code Telemetry

> **Tiempo estimado**: 5-10 minutos  
> **Resultado**: tus sesiones de Claude Code aparecen en [langfuse.atlax360.ai](https://langfuse.atlax360.ai) automáticamente al cerrar cada sesión.

---

## Qué instala este onboarding

| Componente          | Qué hace                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| **Hook `Stop`**     | Se dispara al cerrar Claude Code. Agrega usage del JSONL y lo envía a Langfuse.                    |
| **Reconciler cron** | Corre cada 15 min. Detecta sesiones que no se sincronizaron (crash, `kill -9`, etc.) y las repara. |

Ambos corren en tu máquina local. No hay servidor intermedio — los datos van directamente de tu laptop a `https://langfuse.atlax360.ai`.

---

## Requisitos

- **Bun ≥ 1.3** — verifica con `bun --version`
- **jq** — `sudo apt install jq` (Ubuntu/WSL) o `brew install jq` (macOS)
- **Linux/WSL** para el reconciler cron (systemd). En macOS el hook funciona pero el cron hay que instalarlo manualmente (ver al final).

---

## Paso 1 — Clonar el repo

```bash
cd ~/work
git clone https://github.com/atlax360/atlax-langfuse-bridge.git
cd atlax-langfuse-bridge
bun install
```

Si ya lo tienes clonado:

```bash
cd ~/work/atlax-langfuse-bridge
git pull
bun install
```

---

## Paso 2 — Ejecutar el script de onboarding PRO

```bash
bash scripts/pilot-onboarding.sh --pro
```

El script hace todo de forma automática:

1. Crea `~/.atlax-ai/` con las credenciales PRO (`chmod 600`)
2. Registra el hook `Stop` en `~/.claude/settings.json`
3. Instala el reconciler cron (systemd timer, Linux/WSL)
4. Ejecuta un smoke test contra `langfuse.atlax360.ai`

Para ver qué haría sin aplicar cambios:

```bash
bash scripts/pilot-onboarding.sh --pro --dry-run
```

---

## Paso 3 — Verificar que funciona

### Verificar el hook

Abre una sesión de Claude Code, haz cualquier pregunta, y ciérrala (`/exit` o Ctrl+C). El hook se dispara al cerrar. Espera ~15 segundos y comprueba en Langfuse:

```
https://langfuse.atlax360.ai
```

Deberías ver un nuevo trace con tu nombre de sesión.

### Verificar el cron reconciler (Linux/WSL)

```bash
# Estado del timer
systemctl --user status atlax-langfuse-reconcile.timer

# Próxima ejecución
systemctl --user list-timers atlax-langfuse-reconcile.timer

# Forzar ejecución manual
systemctl --user start atlax-langfuse-reconcile.service

# Ver logs
journalctl --user -u atlax-langfuse-reconcile.service -n 20 --no-pager
```

---

## Acceso a Langfuse PRO

| Campo      | Valor                          |
| ---------- | ------------------------------ |
| URL        | `https://langfuse.atlax360.ai` |
| Usuario    | Tu email `@atlax360.com`       |
| Contraseña | Pídela a jgcalvo@atlax360.com  |

Una vez dentro, en la sección **Traces** verás todas las sesiones sincronizadas con:

- Modelo usado (`claude-opus-4-7`, `claude-sonnet-4-6`, etc.)
- Tokens de entrada/salida
- Coste estimado
- Proyecto (extraído del `git remote` de tu CWD)
- Tier (`seat-team`, `vertex`, etc.)

---

## Troubleshooting

### El hook no aparece en settings.json

```bash
cat ~/.claude/settings.json | grep -A5 "Stop"
```

Si está vacío, registra el hook manualmente:

```bash
bash scripts/pilot-onboarding.sh --pro
```

### No veo mis trazas en Langfuse

1. Comprueba que el hook se dispara: abre/cierra una sesión y busca en stderr:

   ```bash
   # Claude Code muestra stderr del hook al cerrar sesión
   # Busca líneas con [langfuse-sync]
   ```

2. Comprueba conectividad:

   ```bash
   curl -s https://langfuse.atlax360.ai/api/public/health | jq .
   # Debe devolver {"status":"ok"}
   ```

3. Verifica las credenciales en `~/.atlax-ai/reconcile.env`:
   ```bash
   cat ~/.atlax-ai/reconcile.env
   # Debe tener LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
   ```

### El reconciler cron no arranca (WSL)

En WSL, el timer no persiste entre reinicios de la instancia WSL si no has activado `linger`:

```bash
sudo loginctl enable-linger $USER
```

Luego reinstala el timer:

```bash
systemctl --user daemon-reload
systemctl --user enable --now atlax-langfuse-reconcile.timer
```

### macOS — instalar el reconciler

En macOS no hay systemd. Instala el job de launchd manualmente o usa cron:

```bash
# Con cron (más simple)
(crontab -l 2>/dev/null; echo "*/15 * * * * cd ~/work/atlax-langfuse-bridge && ~/.bun/bin/bun run scripts/reconcile-traces.ts >> ~/Library/Logs/atlax-langfuse-reconcile.log 2>&1") | crontab -
```

---

## Desinstalar

```bash
# Desactivar el cron
systemctl --user disable --now atlax-langfuse-reconcile.timer
rm ~/.config/systemd/user/atlax-langfuse-reconcile.{service,timer}
systemctl --user daemon-reload

# Eliminar credenciales
rm ~/.atlax-ai/reconcile.env

# Eliminar el hook de settings.json
# Editar manualmente ~/.claude/settings.json y borrar la entrada Stop del hook
```

---

## Preguntas frecuentes

**¿Mis sesiones se envían en tiempo real?**  
No. El hook se dispara al _cerrar_ cada sesión de Claude Code. El cron reconciler repara sesiones perdidas con una latencia máxima de 15 minutos.

**¿Qué datos se envían?**  
Token counts, modelos usados, timestamps de inicio/fin, coste estimado y metadata de proyecto (rama git, directorio de trabajo). El contenido de las conversaciones **no** se envía.

**¿Puedo ver solo mis sesiones?**  
Sí. En Langfuse filtra por `user_id = tu-email@atlax360.com` o por `project:nombre-del-repo`.

**¿Afecta al rendimiento de Claude Code?**  
El hook corre _después_ de que Claude Code cierra la sesión, de forma asíncrona. El tiempo de cierre puede aumentar 1-2 segundos si Langfuse está lento — nunca bloquea una sesión en curso.
