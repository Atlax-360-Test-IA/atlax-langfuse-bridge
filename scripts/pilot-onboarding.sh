#!/usr/bin/env bash
# pilot-onboarding.sh — Onboarding automatizado para devs del piloto Atlax360
#
# Configura el hook langfuse-sync.ts + reconciler cron en la máquina del dev.
# En modo --pro las credenciales Langfuse PRO están embebidas.
# En modo --pro --litellm configura además el gateway LiteLLM PRO.
#
# Uso:
#   ./scripts/pilot-onboarding.sh --pro [--dry-run]
#   ./scripts/pilot-onboarding.sh --pro --litellm [--dry-run]
#   ./scripts/pilot-onboarding.sh --pro --litellm --workload=orvian [--dry-run]
#
# Flags:
#   --pro            Modo PRO: usa endpoint langfuse.atlax360.ai con keys embebidas
#                    + instala el reconciler cron (systemd en Linux/WSL)
#   --litellm        Configura ANTHROPIC_BASE_URL apuntando a litellm.atlax360.ai.
#                    Presenta menú interactivo de workload (orvian/atalaya/custom).
#                    En modo no-interactivo: requiere LITELLM_VIRTUAL_KEY en entorno.
#   --workload=NAME  Selección de workload sin menú interactivo (orvian|atalaya).
#                    Requiere LITELLM_VIRTUAL_KEY en entorno con la key real.
#   --dry-run        Muestra qué haría sin hacer cambios reales
#
# Requisitos:
#   - bun >= 1.3
#   - git
#   - jq (para registrar hook en settings.json)
#   - Sin --pro: LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY en entorno
#   - --litellm no-interactivo: LITELLM_VIRTUAL_KEY en entorno

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_PATH="$REPO_DIR/hooks/langfuse-sync.ts"
CLAUDE_SETTINGS_DIR="${HOME}/.claude"
CLAUDE_SETTINGS_FILE="$CLAUDE_SETTINGS_DIR/settings.json"
ATLAX_DIR="${HOME}/.atlax-ai"

# PRO endpoint y keys (embebidas — se distribuyen con el script; no son secreto de infra)
PRO_LANGFUSE_HOST="https://langfuse.atlax360.ai"
PRO_LANGFUSE_PUBLIC_KEY="pk-lf-d349eac7-3c3d-40ca-afb3-3a22ce8c848c"
PRO_LANGFUSE_SECRET_KEY="sk-lf-5b0e6e6b-be6f-4035-95e5-4e27630b2b5e"

# Gateway PRO — URL pública, no es secreto
PRO_LITELLM_BASE_URL="https://litellm.atlax360.ai"

# Workloads del piloto (alias → descripción / budget)
declare -A WORKLOAD_DESC=(
  [orvian]="Orvian — uso general       (\$50/30d, 200k TPM, 100 RPM)"
  [atalaya]="Atalaya — análisis          (\$20/30d, 100k TPM,  50 RPM)"
)

# ─── Flags ───────────────────────────────────────────────────────────────────

LITELLM_MODE=false
DRY_RUN=false
PRO_MODE=false
WORKLOAD_NAME=""

for arg in "$@"; do
  case "$arg" in
    --pro)            PRO_MODE=true ;;
    --litellm)        LITELLM_MODE=true ;;
    # Alias de compatibilidad con la flag anterior
    --litellm-mode)   LITELLM_MODE=true ;;
    --workload=*)     WORKLOAD_NAME="${arg#--workload=}" ;;
    --dry-run)        DRY_RUN=true ;;
    --help|-h)
      sed -n '2,30p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: flag desconocido: $arg" >&2
      echo "Uso: $0 --pro [--litellm] [--workload=orvian|atalaya] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# En modo --pro, forzar las vars PRO (sobreescribe entorno local que pueda
# apuntar a localhost o instancia de dev)
if [[ "$PRO_MODE" == "true" ]]; then
  LANGFUSE_HOST="$PRO_LANGFUSE_HOST"
  LANGFUSE_PUBLIC_KEY="$PRO_LANGFUSE_PUBLIC_KEY"
  LANGFUSE_SECRET_KEY="$PRO_LANGFUSE_SECRET_KEY"
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────

log()  { echo "[onboarding] $*"; }
warn() { echo "[onboarding] ⚠️  $*" >&2; }
ok()   { echo "[onboarding] ✓  $*"; }

# run — execute a command, or print it in dry-run mode.
# Avoids `eval "$*"` (vulnerable to glob/quoting tricks if any arg contains
# unusual chars). Uses "$@" with explicit branch instead.
run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: '$1' no encontrado. Instálalo antes de continuar." >&2
    exit 1
  }
}

# ─── Checks de entorno ───────────────────────────────────────────────────────

is_interactive() {
  [[ -t 0 ]]
}

check_env() {
  local missing=()
  [[ -z "${LANGFUSE_HOST:-}" ]]        && missing+=("LANGFUSE_HOST")
  [[ -z "${LANGFUSE_PUBLIC_KEY:-}" ]]  && missing+=("LANGFUSE_PUBLIC_KEY")
  [[ -z "${LANGFUSE_SECRET_KEY:-}" ]]  && missing+=("LANGFUSE_SECRET_KEY")

  # Para --litellm en modo no-interactivo o con --workload: la key debe venir del entorno.
  # En terminal interactiva el menú la pide — no es un error aquí.
  if [[ "$LITELLM_MODE" == "true" ]] && ! is_interactive; then
    [[ -z "${LITELLM_VIRTUAL_KEY:-}" ]] && missing+=("LITELLM_VIRTUAL_KEY")
  fi
  if [[ "$LITELLM_MODE" == "true" && -n "$WORKLOAD_NAME" ]]; then
    [[ -z "${LITELLM_VIRTUAL_KEY:-}" ]] && missing+=("LITELLM_VIRTUAL_KEY")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: variables de entorno requeridas no configuradas:" >&2
    printf "  - %s\n" "${missing[@]}" >&2
    echo "" >&2
    echo "Configúralas antes de ejecutar este script." >&2
    exit 1
  fi
}

# ─── Paso 1: Verificar prerequisitos ─────────────────────────────────────────

step_prereqs() {
  log "Verificando prerequisitos..."
  require_cmd bun
  require_cmd git
  [[ "$LITELLM_MODE" == "true" ]] && require_cmd jq

  local bun_version
  bun_version=$(bun --version 2>/dev/null | head -1)
  ok "bun $bun_version"

  if [[ ! -f "$HOOK_PATH" ]]; then
    echo "ERROR: hook no encontrado en $HOOK_PATH" >&2
    echo "¿Estás ejecutando desde el repo atlax-langfuse-bridge?" >&2
    exit 1
  fi
  ok "hook encontrado: $HOOK_PATH"
}

# ─── Paso 2: Crear ~/.atlax-ai/ ──────────────────────────────────────────────

step_atlax_dir() {
  log "Configurando ~/.atlax-ai/..."
  run mkdir -p "$ATLAX_DIR"

  # Escribir bridge.env con las variables de Langfuse
  local env_file="$ATLAX_DIR/bridge.env"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Escribiría $env_file con LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY"
  else
    cat > "$env_file" <<EOF
LANGFUSE_HOST=${LANGFUSE_HOST}
LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY}
EOF
    chmod 600 "$env_file"
    ok "~/.atlax-ai/bridge.env escrito"
  fi

  # Ejecutar detect-tier para escribir tier.json
  if [[ "$DRY_RUN" == "false" ]]; then
    if bun run "$REPO_DIR/scripts/detect-tier.ts" 2>/dev/null; then
      ok "tier.json generado"
    else
      warn "detect-tier.ts falló — tier.json no generado (no es bloqueante)"
    fi
  else
    echo "[dry-run] bun run scripts/detect-tier.ts"
  fi
}

# ─── Paso 3: Registrar hook Stop en Claude Code ──────────────────────────────

step_hook() {
  log "Registrando hook Stop en Claude Code..."
  run mkdir -p "$CLAUDE_SETTINGS_DIR"

  local hook_cmd="bun run ${HOOK_PATH}"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Añadiría hook Stop en $CLAUDE_SETTINGS_FILE:"
    echo "  hooks.Stop[].hooks[].command = \"$hook_cmd\""
    return
  fi

  # Si settings.json no existe, crearlo con estructura mínima
  if [[ ! -f "$CLAUDE_SETTINGS_FILE" ]]; then
    echo '{}' > "$CLAUDE_SETTINGS_FILE"
  fi

  # Comprobar si el hook ya está registrado
  if jq -e --arg cmd "$hook_cmd" \
    '.hooks.Stop[]?.hooks[]? | select(.command == $cmd)' \
    "$CLAUDE_SETTINGS_FILE" >/dev/null 2>&1; then
    ok "Hook Stop ya registrado — sin cambios"
    return
  fi

  # Añadir el hook usando jq (merge idempotente)
  local tmp
  tmp=$(mktemp)
  jq --arg cmd "$hook_cmd" '
    .hooks //= {} |
    .hooks.Stop //= [] |
    if (.hooks.Stop | map(select(.hooks[]?.command == $cmd)) | length) == 0 then
      .hooks.Stop += [{"hooks": [{"type": "command", "command": $cmd}]}]
    else . end
  ' "$CLAUDE_SETTINGS_FILE" > "$tmp" && mv "$tmp" "$CLAUDE_SETTINGS_FILE"

  ok "Hook Stop registrado en $CLAUDE_SETTINGS_FILE"
}

# ─── Paso 4 (--pro): Instalar reconciler cron ────────────────────────────────

step_reconciler() {
  [[ "$PRO_MODE" != "true" ]] && return

  log "Instalando reconciler cron (systemd user)..."

  # Escribir reconcile.env con las credenciales PRO
  local env_file="$ATLAX_DIR/reconcile.env"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Escribiría $env_file con credenciales PRO + WINDOW_HOURS=24"
  else
    cat > "$env_file" <<EOF
LANGFUSE_HOST=${LANGFUSE_HOST}
LANGFUSE_BASE_URL=${LANGFUSE_HOST}
LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY}
WINDOW_HOURS=24
LANGFUSE_FORCE_NOW_TIMESTAMP=1
EOF
    chmod 600 "$env_file"
    ok "~/.atlax-ai/reconcile.env escrito (chmod 600)"
  fi

  # Detectar sistema: solo Linux/WSL soportan systemd user units
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl no encontrado — omitiendo instalación de cron (macOS/Windows: ver docs/systemd/README.md)"
    return
  fi

  local systemd_user_dir="${HOME}/.config/systemd/user"
  local service_src="$REPO_DIR/docs/systemd/atlax-langfuse-reconcile.service"
  local timer_src="$REPO_DIR/docs/systemd/atlax-langfuse-reconcile.timer"

  if [[ ! -f "$service_src" || ! -f "$timer_src" ]]; then
    warn "Archivos systemd no encontrados en $REPO_DIR/docs/systemd/ — omitiendo"
    return
  fi

  run mkdir -p "$systemd_user_dir"
  run cp "$service_src" "$systemd_user_dir/"
  run cp "$timer_src"   "$systemd_user_dir/"

  if [[ "$DRY_RUN" == "false" ]]; then
    systemctl --user daemon-reload
    systemctl --user enable --now atlax-langfuse-reconcile.timer
    ok "Reconciler timer instalado y activo"
    systemctl --user list-timers atlax-langfuse-reconcile.timer --no-pager 2>/dev/null || true
  else
    echo "[dry-run] systemctl --user daemon-reload"
    echo "[dry-run] systemctl --user enable --now atlax-langfuse-reconcile.timer"
  fi
}

# ─── Paso 5 (--litellm): Configurar gateway PRO ─────────────────────────────

step_litellm() {
  [[ "$LITELLM_MODE" != "true" ]] && return

  log "Configurando gateway LiteLLM PRO (litellm.atlax360.ai)..."

  # ── Verificar que el gateway responde ──────────────────────────────────────
  local health_url="${PRO_LITELLM_BASE_URL}/health/liveliness"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" "$health_url" --max-time 8 2>/dev/null || true)
  if [[ "$http_code" != "200" ]]; then
    warn "Gateway no responde (HTTP $http_code) — configuramos de todos modos"
  else
    ok "Gateway activo: $PRO_LITELLM_BASE_URL"
  fi

  # ── Obtener virtual key ────────────────────────────────────────────────────
  local virtual_key="${LITELLM_VIRTUAL_KEY:-}"
  local workload_alias=""

  if [[ -n "$WORKLOAD_NAME" ]]; then
    # Modo no-interactivo con --workload=NAME: la key viene del entorno
    workload_alias="$WORKLOAD_NAME"
    if [[ -z "$virtual_key" ]]; then
      echo "ERROR: --workload requiere LITELLM_VIRTUAL_KEY en el entorno" >&2
      exit 1
    fi
  elif [[ -n "$virtual_key" ]]; then
    # Key ya seteada en entorno (p.ej. Ansible/CI) — usarla directamente
    workload_alias="custom"
    ok "LITELLM_VIRTUAL_KEY tomada del entorno"
  elif is_interactive; then
    # Terminal interactiva — presentar menú de selección
    echo ""
    echo "  ¿Qué workload vas a usar con el gateway?"
    echo ""
    echo "  1) ${WORKLOAD_DESC[orvian]}"
    echo "  2) ${WORKLOAD_DESC[atalaya]}"
    echo "  3) Key personalizada (pégala cuando se pida)"
    echo ""
    local choice
    read -r -p "  Selección [1/2/3]: " choice
    case "$choice" in
      1) workload_alias="orvian" ;;
      2) workload_alias="atalaya" ;;
      3) workload_alias="custom" ;;
      *)
        echo "ERROR: selección inválida. Vuelve a ejecutar el script." >&2
        exit 1
        ;;
    esac

    if [[ "$workload_alias" == "custom" ]]; then
      echo ""
      read -r -s -p "  Pega tu virtual key (sk-...): " virtual_key
      echo ""
      if [[ -z "$virtual_key" ]]; then
        echo "ERROR: key vacía." >&2
        exit 1
      fi
    else
      echo ""
      echo "  Pide a jgcalvo@atlax360.com la virtual key para el workload '${workload_alias}'."
      read -r -s -p "  Pega la virtual key cuando la tengas (sk-...): " virtual_key
      echo ""
      if [[ -z "$virtual_key" ]]; then
        echo "ERROR: key vacía." >&2
        exit 1
      fi
    fi
  else
    echo "ERROR: modo no-interactivo sin LITELLM_VIRTUAL_KEY. Configura la variable antes de ejecutar." >&2
    exit 1
  fi

  # ── Validar formato mínimo de la key ──────────────────────────────────────
  if [[ ! "$virtual_key" =~ ^sk- ]]; then
    echo "ERROR: la virtual key debe empezar por 'sk-'. Revisa que copiaste correctamente." >&2
    exit 1
  fi

  # ── Escribir ~/.atlax-ai/litellm.env ──────────────────────────────────────
  # Solo metadatos — la key NO se escribe en litellm.env para evitar
  # que el hook la lea como ANTHROPIC_API_KEY accidentalmente.
  # Las variables de shell se exportan a continuación.
  local litellm_env="$ATLAX_DIR/litellm.env"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Escribiría $litellm_env (solo LITELLM_BASE_URL + LITELLM_WORKLOAD)"
  else
    (umask 077; cat > "$litellm_env" <<EOF
LITELLM_BASE_URL=${PRO_LITELLM_BASE_URL}
LITELLM_WORKLOAD=${workload_alias}
EOF
    )
    ok "~/.atlax-ai/litellm.env escrito (solo metadata, sin key)"
  fi

  # ── Detectar shell rc file ─────────────────────────────────────────────────
  local shell_rc=""
  if [[ -n "${ZSH_VERSION:-}" ]] || [[ "${SHELL:-}" == *zsh* ]]; then
    shell_rc="${HOME}/.zshrc"
  elif [[ -n "${BASH_VERSION:-}" ]] || [[ "${SHELL:-}" == *bash* ]]; then
    shell_rc="${HOME}/.bashrc"
  else
    shell_rc="${HOME}/.profile"
  fi

  # ── Inyectar exports en el shell rc (idempotente) ────────────────────────
  local marker="# atlax-litellm-gateway"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Inyectaría en $shell_rc:"
    echo "  export ANTHROPIC_BASE_URL=\"$PRO_LITELLM_BASE_URL\""
    echo "  export ANTHROPIC_API_KEY=\"<virtual-key>\""
  else
    if grep -q "$marker" "$shell_rc" 2>/dev/null; then
      ok "$shell_rc ya tiene los exports del gateway — sin cambios"
    else
      cat >> "$shell_rc" <<EOF

${marker}
export ANTHROPIC_BASE_URL="${PRO_LITELLM_BASE_URL}"
export ANTHROPIC_API_KEY="${virtual_key}"
# Para desactivar: unset ANTHROPIC_BASE_URL && export ANTHROPIC_API_KEY=<tu-key-anthropic>
EOF
      ok "Exports añadidos a $shell_rc"
      echo ""
      echo "  ╔═══════════════════════════════════════════════════════╗"
      echo "  ║  Ejecuta: source ${shell_rc}           ║"
      echo "  ║  o abre un nuevo terminal para activar el gateway.   ║"
      echo "  ╚═══════════════════════════════════════════════════════╝"
    fi
  fi
}

# ─── Paso 5: Smoke test ──────────────────────────────────────────────────────

step_smoke() {
  log "Ejecutando smoke test..."

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] LANGFUSE_HOST=... bun test tests/langfuse-sync-http.test.ts"
    return
  fi

  if LANGFUSE_HOST="$LANGFUSE_HOST" \
     LANGFUSE_PUBLIC_KEY="$LANGFUSE_PUBLIC_KEY" \
     LANGFUSE_SECRET_KEY="$LANGFUSE_SECRET_KEY" \
     bun test "$REPO_DIR/tests/langfuse-sync-http.test.ts" --timeout 30000 \
     2>&1 | tail -4; then
    ok "Smoke test pasado — hook funcional"
  else
    warn "Smoke test falló — revisa la conectividad con Langfuse"
  fi
}

# ─── Resumen final ────────────────────────────────────────────────────────────

step_summary() {
  echo ""
  echo "══════════════════════════════════════════"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  MODO DRY-RUN — ningún cambio aplicado"
  else
    echo "  Onboarding completado ✓"
  fi
  echo "══════════════════════════════════════════"
  echo ""
  echo "  Próximos pasos:"
  echo "  1. Abre una sesión de Claude Code"
  echo "  2. Ciérrala normalmente (el hook se dispara al cerrar)"
  echo "  3. Comprueba en Langfuse que aparece un nuevo trace"
  echo "     → ${LANGFUSE_HOST:-https://langfuse.atlax360.ai}"
  local step=4
  if [[ "$PRO_MODE" == "true" ]]; then
    echo "  ${step}. Verifica el cron reconciler:"
    echo "     systemctl --user status atlax-langfuse-reconcile.timer"
    (( step++ )) || true
  fi
  if [[ "$LITELLM_MODE" == "true" ]]; then
    echo "  ${step}. Abre una sesión de Claude Code — irá por el gateway LiteLLM"
    (( step++ )) || true
    echo "  ${step}. Verifica en Langfuse que aparece un trace litellm-acompletion"
    echo "     → ${PRO_LANGFUSE_HOST}"
  fi
  echo ""
  echo "  Documentación:"
  echo "  → $REPO_DIR/docs/operations/dev-onboarding-pro.md"
  echo "  → $REPO_DIR/docs/operations/runbook.md"
  echo ""
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "Atlax360 · Pilot Onboarding Script"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "(modo dry-run — sin cambios reales)"
  fi
  if [[ "$LITELLM_MODE" == "true" ]]; then
    echo "(modo LiteLLM gateway → litellm.atlax360.ai)"
  fi
  echo ""

  check_env
  step_prereqs
  step_atlax_dir
  step_hook
  step_reconciler
  step_litellm
  step_smoke
  step_summary
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
