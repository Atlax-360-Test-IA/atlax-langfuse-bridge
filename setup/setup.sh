#!/usr/bin/env bash
# setup.sh — Atlax360 Claude Code → Langfuse hook installer
# Compatible: Linux, macOS, WSL
# Uso: bash setup.sh [--env=dev|pro] [LANGFUSE_HOST] [LANGFUSE_PUBLIC_KEY] [LANGFUSE_SECRET_KEY]
set -euo pipefail

# ── Parse --env flag ──────────────────────────────────────────────────────────
ENV_TARGET="dev"
POSITIONAL_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --env=dev) ENV_TARGET="dev" ;;
    --env=pro) ENV_TARGET="pro" ;;
    --env=*)
      echo "Error: --env acepta solo 'dev' o 'pro'" >&2
      exit 2
      ;;
    *) POSITIONAL_ARGS+=("$arg") ;;
  esac
done
set -- "${POSITIONAL_ARGS[@]+"${POSITIONAL_ARGS[@]}"}"

LANGFUSE_HOST="${1:-}"
LANGFUSE_PUBLIC_KEY="${2:-}"
LANGFUSE_SECRET_KEY="${3:-}"

HOOK_DIR="$HOME/.claude/hooks"
HOOK_SCRIPT="$HOOK_DIR/langfuse-sync.ts"
SHARED_DST="$HOME/.claude/shared"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SOURCE="$SCRIPT_DIR/../hooks/langfuse-sync.ts"
SHARED_SOURCE="$SCRIPT_DIR/../shared"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }

echo ""
echo "  Atlax360 — Claude Code → Langfuse Setup"
echo "  ─────────────────────────────────────────"
echo "  Entorno objetivo: $ENV_TARGET"
echo ""

# ── 1. Check Bun ─────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  err "Bun no encontrado. Instala con: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
ok "Bun $(bun --version) encontrado"

# ── 2. Check Claude Code ─────────────────────────────────────────────────────
if [[ ! -d "$HOME/.claude" ]]; then
  err "~/.claude no existe. ¿Claude Code está instalado?"
  exit 1
fi
ok "~/.claude encontrado"

# ── 3. Install hook script + shared/ dependencies ────────────────────────────
mkdir -p "$HOOK_DIR"
if [[ -f "$HOOK_SOURCE" ]]; then
  cp "$HOOK_SOURCE" "$HOOK_SCRIPT"
  chmod +x "$HOOK_SCRIPT"
  ok "Hook instalado en $HOOK_SCRIPT"

  # Copy shared/ so ../shared/* imports resolve from ~/.claude/hooks/
  if [[ -d "$SHARED_SOURCE" ]]; then
    mkdir -p "$SHARED_DST"
    cp -r "$SHARED_SOURCE"/. "$SHARED_DST/"
    ok "shared/ instalado en $SHARED_DST"
  else
    err "shared/ no encontrado en $SHARED_SOURCE — instala desde el repo clonado"
    exit 1
  fi
else
  err "hooks/langfuse-sync.ts no encontrado."
  err "Este script requiere el repo clonado completo, no puede descargar un archivo suelto."
  err "Clona el repo: git clone https://github.com/Atlax-360-Test-IA/atlax-langfuse-bridge"
  exit 1
fi

# ── 4. Update Claude Code settings.json ──────────────────────────────────────
# Crea settings.json si no existe
if [[ ! -f "$SETTINGS" ]]; then
  echo '{}' > "$SETTINGS"
fi

# Inyecta el hook Stop via Python (disponible en todos los OS)
python3 - <<PYEOF
import json, sys, os

settings_path = os.path.expanduser("$SETTINGS")
hook_script   = os.path.expanduser("$HOOK_SCRIPT")

with open(settings_path) as f:
    settings = json.load(f)

hook_cmd = f"bun run {hook_script}"

new_hook = {
    "hooks": [
        {
            "type": "command",
            "command": hook_cmd,
            "timeout": 10000
        }
    ]
}

hooks = settings.setdefault("hooks", {})
stop_hooks = hooks.get("Stop", [])

# Evitar duplicados
already = any(
    any(h.get("command", "").endswith("langfuse-sync.ts") for h in g.get("hooks", []))
    for g in stop_hooks
)

if not already:
    stop_hooks.append(new_hook)
    hooks["Stop"] = stop_hooks
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    print("Hook Stop añadido a settings.json")
else:
    print("Hook Stop ya presente — sin cambios")
PYEOF
ok "Claude Code settings.json actualizado"

# ── 5. Write credentials to per-env file (chmod 600) + add shell aliases ──────
# Credentials live in ~/.atlax-ai/dev.env or ~/.atlax-ai/pro.env (chmod 600).
# The shell RC only gets aliases — no auto-source to avoid cross-contamination.
SHELL_RC=""
if [[ -f "$HOME/.zshrc" ]]; then
  SHELL_RC="$HOME/.zshrc"
elif [[ -f "$HOME/.bashrc" ]]; then
  SHELL_RC="$HOME/.bashrc"
fi

ATLAX_DIR="$HOME/.atlax-ai"
ENV_FILE="$ATLAX_DIR/${ENV_TARGET}.env"

if [[ -n "$LANGFUSE_HOST" && -n "$LANGFUSE_PUBLIC_KEY" && -n "$LANGFUSE_SECRET_KEY" ]]; then
  mkdir -p "$ATLAX_DIR"
  chmod 700 "$ATLAX_DIR"
  # Write with 600 permissions (umask ensures no group/other bits)
  umask_old=$(umask)
  umask 077
  cat > "$ENV_FILE" <<ENVEOF
# Langfuse — Atlax360 Claude Code telemetry credentials (${ENV_TARGET})
# Generado por setup.sh el $(date -u +%Y-%m-%dT%H:%M:%SZ)
# NUNCA commitear. chmod 600.
export LANGFUSE_HOST="${LANGFUSE_HOST}"
export LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY}"
export LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY}"
ENVEOF
  chmod 600 "$ENV_FILE"
  umask "$umask_old"
  ok "Credenciales guardadas en $ENV_FILE (chmod 600)"

  if [[ -n "$SHELL_RC" ]]; then
    # Remove any legacy source/export lines and previous alias blocks for atlax-env-*
    grep -v \
      "LANGFUSE_HOST\|LANGFUSE_PUBLIC_KEY\|LANGFUSE_SECRET_KEY\|atlax-ai/bridge.env\|atlax-ai/reconcile.env\|atlax-env-dev\|atlax-env-pro" \
      "$SHELL_RC" > "${SHELL_RC}.tmp" || true
    mv "${SHELL_RC}.tmp" "$SHELL_RC"

    cat >> "$SHELL_RC" <<RCEOF

# Atlax Langfuse Bridge — entorno DEV / PRO (añadido por setup.sh)
# Sourcear manualmente antes de ejecutar reconciler o scripts:
#   atlax-env-dev   → apunta a http://localhost:3000 (local)
#   atlax-env-pro   → apunta a https://langfuse.atlax360.ai (producción)
alias atlax-env-dev='source "\$HOME/.atlax-ai/dev.env"'
alias atlax-env-pro='source "\$HOME/.atlax-ai/pro.env"'
RCEOF
    ok "Aliases atlax-env-dev / atlax-env-pro añadidos a $SHELL_RC"
    warn "Ejecuta: source $SHELL_RC"
    warn "Para activar el entorno ${ENV_TARGET}: $([ "$ENV_TARGET" = "dev" ] && echo 'atlax-env-dev' || echo 'atlax-env-pro')"
  fi
else
  warn "No se proporcionaron credenciales. Crea manualmente $ENV_FILE (chmod 600):"
  echo ""
  echo "  export LANGFUSE_HOST=\"https://tu-instancia.atlax360.com\""
  echo "  export LANGFUSE_PUBLIC_KEY=\"pk-lf-...\""
  echo "  export LANGFUSE_SECRET_KEY=\"sk-lf-...\""
  echo ""
fi

# ── 6. Test hook (dry run) ────────────────────────────────────────────────────
echo ""
echo "  Verificando script..."
if bun run "$HOOK_SCRIPT" <<< '{}' 2>/dev/null; then
  ok "Script ejecuta sin errores (salida vacía esperada sin credenciales)"
else
  warn "Script salió con error — revisa credenciales o logs"
fi

echo ""
ok "Setup completado. El hook se activará al final de cada sesión de Claude Code."
echo ""
