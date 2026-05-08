#!/usr/bin/env bash
# pilot-onboarding.sh — Onboarding automatizado para devs del piloto Atlax360
#
# Configura el hook langfuse-sync.ts en la máquina del dev y opcionalmente
# redirige Claude Code a través del LiteLLM gateway (--litellm-mode).
#
# Uso:
#   ./scripts/pilot-onboarding.sh [--litellm-mode] [--dry-run]
#
# Flags:
#   --litellm-mode   Configura ANTHROPIC_BASE_URL + virtual key para LiteLLM
#   --dry-run        Muestra qué haría sin hacer cambios reales
#
# Requisitos:
#   - bun >= 1.3
#   - git
#   - jq (solo con --litellm-mode)
#   - Variables de entorno: LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
#   - Con --litellm-mode: LITELLM_BASE_URL, LITELLM_VIRTUAL_KEY

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_PATH="$REPO_DIR/hooks/langfuse-sync.ts"
CLAUDE_SETTINGS_DIR="${HOME}/.claude"
CLAUDE_SETTINGS_FILE="$CLAUDE_SETTINGS_DIR/settings.json"
ATLAX_DIR="${HOME}/.atlax-ai"

# ─── Flags ───────────────────────────────────────────────────────────────────

LITELLM_MODE=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --litellm-mode) LITELLM_MODE=true ;;
    --dry-run)      DRY_RUN=true ;;
    --help|-h)
      sed -n '2,20p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: flag desconocido: $arg" >&2
      echo "Uso: $0 [--litellm-mode] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

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

check_env() {
  local missing=()
  [[ -z "${LANGFUSE_HOST:-}" ]]        && missing+=("LANGFUSE_HOST")
  [[ -z "${LANGFUSE_PUBLIC_KEY:-}" ]]  && missing+=("LANGFUSE_PUBLIC_KEY")
  [[ -z "${LANGFUSE_SECRET_KEY:-}" ]]  && missing+=("LANGFUSE_SECRET_KEY")

  if [[ "$LITELLM_MODE" == "true" ]]; then
    [[ -z "${LITELLM_BASE_URL:-}" ]]   && missing+=("LITELLM_BASE_URL")
    [[ -z "${LITELLM_VIRTUAL_KEY:-}" ]] && missing+=("LITELLM_VIRTUAL_KEY")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: variables de entorno requeridas no configuradas:" >&2
    printf "  - %s\n" "${missing[@]}" >&2
    echo "" >&2
    echo "Configúralas en ~/.zshrc o ~/.bashrc antes de ejecutar este script." >&2
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

# ─── Paso 4 (--litellm-mode): Configurar gateway ────────────────────────────

step_litellm() {
  [[ "$LITELLM_MODE" != "true" ]] && return

  log "Configurando modo LiteLLM gateway..."

  # Verificar que el gateway responde
  local health_url="${LITELLM_BASE_URL}/health/liveliness"
  if ! curl -s -o /dev/null -w "%{http_code}" "$health_url" \
    --max-time 3 2>/dev/null | grep -q "^200$"; then
    warn "Gateway no responde en $LITELLM_BASE_URL — verifica que está activo"
    warn "Continúa con la configuración; Claude Code la usará cuando esté disponible"
  else
    ok "Gateway activo: $LITELLM_BASE_URL"
  fi

  # Guardar configuración de LiteLLM en ~/.atlax-ai/litellm.env
  local litellm_env="$ATLAX_DIR/litellm.env"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Escribiría $litellm_env con LITELLM_BASE_URL + LITELLM_VIRTUAL_KEY"
  else
    cat > "$litellm_env" <<EOF
LITELLM_BASE_URL=${LITELLM_BASE_URL}
LITELLM_VIRTUAL_KEY=${LITELLM_VIRTUAL_KEY}
EOF
    chmod 600 "$litellm_env"
    ok "~/.atlax-ai/litellm.env escrito"
  fi

  # Instrucciones para shell (no podemos modificar el shell del dev desde aquí)
  echo ""
  echo "  Añade esto a tu ~/.zshrc o ~/.bashrc para activar el gateway:"
  echo ""
  echo "    export ANTHROPIC_BASE_URL=\"${LITELLM_BASE_URL}\""
  echo "    export ANTHROPIC_API_KEY=\"${LITELLM_VIRTUAL_KEY}\""
  echo ""
  echo "  Luego: source ~/.zshrc && claude"
  echo ""
  echo "  Para desactivar (volver a Anthropic directo):"
  echo "    unset ANTHROPIC_BASE_URL"
  echo "    export ANTHROPIC_API_KEY=\"<tu-key-original-anthropic>\""
  echo ""
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
  echo "     → $LANGFUSE_HOST"
  if [[ "$LITELLM_MODE" == "true" ]]; then
    echo "  4. Verifica que el trace tiene user_api_key_alias en metadata"
  fi
  echo ""
  echo "  Documentación:"
  echo "  → $REPO_DIR/docs/operations/litellm-onboarding.md"
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
    echo "(modo LiteLLM gateway activado)"
  fi
  echo ""

  check_env
  step_prereqs
  step_atlax_dir
  step_hook
  step_litellm
  step_smoke
  step_summary
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
