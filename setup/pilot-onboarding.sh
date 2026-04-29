#!/usr/bin/env bash
# pilot-onboarding.sh — Atlax360 Claude Code → Langfuse onboarding para devs del piloto
#
# Uso (una sola línea, sin clonar el repo):
#   curl -fsSL https://raw.githubusercontent.com/atlax360/atlax-langfuse-bridge/main/setup/pilot-onboarding.sh \
#     | bash -s -- <LANGFUSE_HOST> <LANGFUSE_PUBLIC_KEY> <LANGFUSE_SECRET_KEY>
#
# Compatible: Linux, WSL, macOS (Big Sur+)
# Requisitos: bun >= 1.0, Claude Code >= 1.0, python3 (para editar settings.json)
#
# Lo que hace este script:
#   1. Descarga hook + shared/ (5 módulos) desde GitHub sin clonar el repo
#   2. Instala en ~/.claude/hooks/ + ~/.claude/shared/
#   3. Registra el hook Stop en ~/.claude/settings.json
#   4. Escribe credenciales en ~/.atlax-ai/reconcile.env (modo 600) + carga en shell RC
#   5. Verifica systemd usuario (Linux/WSL) o muestra nota de gap (macOS/GAP-P01)
#   6. Establece cleanupPeriodDays: 90 en ~/.claude/settings.json
set -euo pipefail

LANGFUSE_HOST="${1:-}"
LANGFUSE_PUBLIC_KEY="${2:-}"
LANGFUSE_SECRET_KEY="${3:-}"

# ── Constantes ────────────────────────────────────────────────────────────────
REPO_RAW="https://raw.githubusercontent.com/atlax360/atlax-langfuse-bridge/main"
HOOK_DIR="$HOME/.claude/hooks"
SHARED_DST="$HOME/.claude/shared"
SETTINGS="$HOME/.claude/settings.json"
ATLAX_DIR="$HOME/.atlax-ai"
RECONCILE_ENV="$ATLAX_DIR/reconcile.env"

SHARED_MODULES=(
  "shared/model-pricing.ts"
  "shared/aggregate.ts"
  "shared/degradation.ts"
  "shared/langfuse-client.ts"
  "shared/constants.ts"
)

# ── Colores ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC} $*"; exit 1; }
info() { echo -e "${BLUE}→${NC} $*"; }

echo ""
echo "  Atlax360 — Claude Code → Langfuse Onboarding"
echo "  ══════════════════════════════════════════════"
echo ""

# ── 1. Verificar requisitos ───────────────────────────────────────────────────
info "Verificando requisitos..."

if ! command -v bun &>/dev/null; then
  err "Bun no encontrado. Instala con: curl -fsSL https://bun.sh/install | bash"
fi
ok "Bun $(bun --version)"

if [[ ! -d "$HOME/.claude" ]]; then
  err "~/.claude no existe — ¿Claude Code está instalado? https://claude.ai/code"
fi
ok "Claude Code (~/.claude)"

if ! command -v python3 &>/dev/null; then
  err "python3 no encontrado (necesario para editar settings.json)"
fi
ok "python3 $(python3 --version 2>&1 | cut -d' ' -f2)"

DOWNLOAD_CMD=""
if command -v curl &>/dev/null; then
  DOWNLOAD_CMD="curl -fsSL"
elif command -v wget &>/dev/null; then
  DOWNLOAD_CMD="wget -qO-"
else
  err "Ni curl ni wget encontrados. Instala uno de los dos."
fi
ok "Descarga via $(echo "$DOWNLOAD_CMD" | cut -d' ' -f1)"

# Detectar plataforma
OS_TYPE="$(uname -s)"
IS_WSL=false
if [[ "$OS_TYPE" == "Linux" ]] && grep -qi microsoft /proc/version 2>/dev/null; then
  IS_WSL=true
fi

# ── 2. Descargar hook + shared/ ──────────────────────────────────────────────
info "Descargando hook y módulos compartidos..."

mkdir -p "$HOOK_DIR" "$SHARED_DST"

download_file() {
  local src="$1" dst="$2"
  $DOWNLOAD_CMD "$REPO_RAW/$src" > "$dst"
}

download_file "hooks/langfuse-sync.ts" "$HOOK_DIR/langfuse-sync.ts"
chmod +x "$HOOK_DIR/langfuse-sync.ts"
ok "Hook instalado en $HOOK_DIR/langfuse-sync.ts"

# El hook importa los shared/ con ruta relativa "../shared/"
# Instalamos en ~/.claude/shared/ (resuelve desde ~/.claude/hooks/)
for module in "${SHARED_MODULES[@]}"; do
  filename="$(basename "$module")"
  download_file "$module" "$SHARED_DST/$filename"
done
ok "Módulos shared/ instalados en $SHARED_DST/"

# ── 3. Registrar hook Stop en settings.json ──────────────────────────────────
info "Configurando Claude Code settings.json..."

[[ ! -f "$SETTINGS" ]] && echo '{}' > "$SETTINGS"

python3 - <<PYEOF
import json, sys, os

settings_path = os.path.expanduser("${SETTINGS}")
hook_script   = os.path.expanduser("${HOOK_DIR}/langfuse-sync.ts")

with open(settings_path) as f:
    try:
        settings = json.load(f)
    except json.JSONDecodeError:
        settings = {}

# Registrar hook Stop
hook_cmd = f"bun run {hook_script}"
new_hook_group = {
    "hooks": [
        {"type": "command", "command": hook_cmd, "timeout": 10000}
    ]
}
hooks = settings.setdefault("hooks", {})
stop_hooks = hooks.get("Stop", [])

already = any(
    any(h.get("command", "").endswith("langfuse-sync.ts") for h in g.get("hooks", []))
    for g in stop_hooks
)
if not already:
    stop_hooks.append(new_hook_group)
    hooks["Stop"] = stop_hooks
    print("  Hook Stop añadido")
else:
    print("  Hook Stop ya presente — sin cambios")

# Establecer cleanupPeriodDays: 90 si es menor que 90 o no existe
current_days = settings.get("cleanupPeriodDays", 0)
if current_days < 90:
    settings["cleanupPeriodDays"] = 90
    print(f"  cleanupPeriodDays: {current_days} → 90 (amplía ventana de recuperabilidad)")
else:
    print(f"  cleanupPeriodDays: {current_days} — sin cambios (ya >= 90)")

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
PYEOF
ok "settings.json actualizado"

# ── 4. Escribir credenciales en ~/.atlax-ai/reconcile.env ───────────────────
info "Configurando credenciales del reconciler..."

mkdir -p "$ATLAX_DIR"
chmod 700 "$ATLAX_DIR"

if [[ -n "$LANGFUSE_HOST" && -n "$LANGFUSE_PUBLIC_KEY" && -n "$LANGFUSE_SECRET_KEY" ]]; then
  cat > "$RECONCILE_ENV" <<ENVEOF
# ~/.atlax-ai/reconcile.env — Credenciales Langfuse para el reconciler
# Generado por pilot-onboarding.sh el $(date -u +%Y-%m-%dT%H:%M:%SZ)
LANGFUSE_HOST=${LANGFUSE_HOST}
LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY}
WINDOW_HOURS=24
ENVEOF
  chmod 600 "$RECONCILE_ENV"
  ok "Credenciales en $RECONCILE_ENV (modo 600)"

  # Añadir al shell RC para que el hook pueda leerlas en sesión
  SHELL_RC=""
  [[ -f "$HOME/.zshrc" ]]  && SHELL_RC="$HOME/.zshrc"
  [[ -z "$SHELL_RC" && -f "$HOME/.bashrc" ]] && SHELL_RC="$HOME/.bashrc"

  if [[ -n "$SHELL_RC" ]]; then
    # Eliminar entradas anteriores para evitar duplicados
    grep -v "LANGFUSE_HOST\|LANGFUSE_PUBLIC_KEY\|LANGFUSE_SECRET_KEY\|atlax-ai.*reconcile" \
      "$SHELL_RC" > "${SHELL_RC}.atlax.tmp" 2>/dev/null || true
    mv "${SHELL_RC}.atlax.tmp" "$SHELL_RC"

    cat >> "$SHELL_RC" <<SHELLEOF

# Langfuse — Atlax360 Claude Code telemetry (añadido por pilot-onboarding.sh)
set -a; [[ -f "$RECONCILE_ENV" ]] && source "$RECONCILE_ENV"; set +a
SHELLEOF
    ok "Shell RC ($SHELL_RC) carga credenciales de reconcile.env"
    warn "Ejecuta: source $SHELL_RC"
  else
    warn "No se encontró .zshrc ni .bashrc — añade manualmente: source $RECONCILE_ENV"
  fi
else
  warn "No se proporcionaron credenciales. Créa $RECONCILE_ENV con:"
  echo ""
  echo "  cat > ~/.atlax-ai/reconcile.env <<EOF"
  echo "  LANGFUSE_HOST=https://langfuse.atlax360.com"
  echo "  LANGFUSE_PUBLIC_KEY=pk-lf-..."
  echo "  LANGFUSE_SECRET_KEY=sk-lf-..."
  echo "  WINDOW_HOURS=24"
  echo "  EOF"
  echo "  chmod 600 ~/.atlax-ai/reconcile.env"
  echo ""
fi

# ── 5. Instalar reconciler cron (Linux/WSL) ──────────────────────────────────
# El reconciler (scripts/reconcile-traces.ts) es un componente separado del hook.
# En el piloto v1 instalamos solo el hook Stop — el reconciler se añade en fase 2
# una vez que los devs confirmen que el hook funciona en su máquina.
# Para devs que quieran el reconciler ya: ver docs/systemd/ en el repo.

if [[ "$OS_TYPE" == "Linux" ]]; then
  info "Plataforma Linux/WSL — verificando systemd usuario..."

  if systemctl --user status &>/dev/null 2>&1; then
    ok "systemd usuario activo — reconciler puede instalarse manualmente (ver repo docs/systemd/)"
  else
    warn "systemd usuario no disponible — reconciler manual no disponible en este entorno."
    warn "El hook Stop sigue funcionando (sincroniza al cerrar sesión)."
  fi

elif [[ "$OS_TYPE" == "Darwin" ]]; then
  warn "macOS: reconciler automático pendiente (GAP-P01 — launchd plist en desarrollo)."
  warn "El hook Stop sincroniza al cerrar sesión — cobertura suficiente para el piloto."
fi

# ── 6. Verificación rápida ────────────────────────────────────────────────────
echo ""
info "Verificando instalación..."

HOOK_OK=false
SHARED_OK=false
SETTINGS_OK=false
ENV_OK=false

[[ -f "$HOOK_DIR/langfuse-sync.ts" ]] && HOOK_OK=true
[[ -f "$SHARED_DST/model-pricing.ts" ]] && SHARED_OK=true
python3 -c "
import json
with open('${SETTINGS}') as f: s = json.load(f)
stop = s.get('hooks', {}).get('Stop', [])
found = any(any('langfuse-sync' in h.get('command','') for h in g.get('hooks',[])) for g in stop)
exit(0 if found else 1)
" 2>/dev/null && SETTINGS_OK=true
[[ -f "$RECONCILE_ENV" ]] && ENV_OK=true

status_icon() { [[ "$1" == true ]] && echo -e "${GREEN}✓${NC}" || echo -e "${RED}✗${NC}"; }

echo ""
echo -e "  $(printf '%-40s' 'Hook instalado')         $(status_icon "$HOOK_OK")"
echo -e "  $(printf '%-40s' 'Módulos shared/')         $(status_icon "$SHARED_OK")"
echo -e "  $(printf '%-40s' 'settings.json actualizado') $(status_icon "$SETTINGS_OK")"
if $ENV_OK; then
  echo -e "  $(printf '%-40s' 'reconcile.env creado')    ${GREEN}✓${NC}"
else
  echo -e "  $(printf '%-40s' 'reconcile.env creado')    ${YELLOW}⚠  — añade credenciales manualmente${NC}"
fi
echo ""

if $HOOK_OK && $SHARED_OK && $SETTINGS_OK; then
  echo -e "  ${GREEN}Onboarding completado.${NC} El hook se activará al cerrar la próxima sesión de Claude Code."
else
  echo -e "  ${RED}Onboarding incompleto.${NC} Revisa los items marcados con ✗ arriba."
  exit 1
fi

echo ""
echo "  Soporte: jgcalvo@atlax360.com | Docs: https://github.com/atlax360/atlax-langfuse-bridge"
echo ""
