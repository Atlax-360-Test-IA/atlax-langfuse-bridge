#!/usr/bin/env bash
# setup.sh — Atlax360 Claude Code → Langfuse hook installer
# Compatible: Linux, macOS, WSL
# Uso: bash setup.sh [LANGFUSE_HOST] [LANGFUSE_PUBLIC_KEY] [LANGFUSE_SECRET_KEY]
set -euo pipefail

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

# ── 5. Add env vars to shell rc ───────────────────────────────────────────────
SHELL_RC=""
if [[ -f "$HOME/.zshrc" ]]; then
  SHELL_RC="$HOME/.zshrc"
elif [[ -f "$HOME/.bashrc" ]]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [[ -n "$LANGFUSE_HOST" && -n "$LANGFUSE_PUBLIC_KEY" && -n "$LANGFUSE_SECRET_KEY" ]]; then
  if [[ -n "$SHELL_RC" ]]; then
    # Remove existing entries to avoid duplicates
    grep -v "LANGFUSE_HOST\|LANGFUSE_PUBLIC_KEY\|LANGFUSE_SECRET_KEY" "$SHELL_RC" > "${SHELL_RC}.tmp" || true
    mv "${SHELL_RC}.tmp" "$SHELL_RC"

    cat >> "$SHELL_RC" <<ENVEOF

# Langfuse — Atlax360 Claude Code telemetry
export LANGFUSE_HOST="$LANGFUSE_HOST"
export LANGFUSE_PUBLIC_KEY="$LANGFUSE_PUBLIC_KEY"
export LANGFUSE_SECRET_KEY="$LANGFUSE_SECRET_KEY"
ENVEOF
    ok "Variables de entorno añadidas a $SHELL_RC"
    warn "Ejecuta: source $SHELL_RC"
  fi
else
  warn "No se proporcionaron credenciales. Añade manualmente a ~/.zshrc o ~/.bashrc:"
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
