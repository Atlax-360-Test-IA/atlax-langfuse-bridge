#!/usr/bin/env bash
# migrate-env-files.sh — Migra ~/.atlax-ai/reconcile.env al esquema dev/pro separado
#
# Uso:
#   bash setup/migrate-env-files.sh           # migración real
#   bash setup/migrate-env-files.sh --dry-run # preview sin cambios
#
# Idempotente: si reconcile.env ya no existe, termina sin hacer nada.
set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *)
      echo "Uso: $0 [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# ── Colores ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }
info() { echo -e "${BLUE}→${NC} $*"; }
dryrun() { echo -e "${YELLOW}[dry-run]${NC} $*"; }

ATLAX_DIR="$HOME/.atlax-ai"
LEGACY_FILE="$ATLAX_DIR/reconcile.env"
DEV_FILE="$ATLAX_DIR/dev.env"
PRO_FILE="$ATLAX_DIR/pro.env"

echo ""
echo "  Atlax360 — migrate-env-files"
echo "  ────────────────────────────"
$DRY_RUN && echo "  Modo: DRY-RUN (sin cambios en disco)" || echo "  Modo: REAL"
echo ""

# ── 1. Comprobar existencia del fichero legacy ────────────────────────────────
if [[ ! -f "$LEGACY_FILE" ]]; then
  ok "No existe $LEGACY_FILE — nada que migrar."
  echo ""
  exit 0
fi

info "Detectado fichero legacy: $LEGACY_FILE"

# ── 2. Leer LANGFUSE_HOST del fichero legacy ──────────────────────────────────
# Extraer el valor sin ejecutar el fichero (seguro ante side-effects)
LANGFUSE_HOST_VALUE=""
while IFS= read -r line; do
  # Aceptar con o sin "export", con o sin comillas
  if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?LANGFUSE_HOST[[:space:]]*=[[:space:]]*\"?([^\"]*)\"?[[:space:]]*$ ]]; then
    LANGFUSE_HOST_VALUE="${BASH_REMATCH[2]}"
    break
  fi
done < "$LEGACY_FILE"

if [[ -z "$LANGFUSE_HOST_VALUE" ]]; then
  warn "No se pudo extraer LANGFUSE_HOST de $LEGACY_FILE"
  warn "Fichero legacy dejado intacto — migración manual requerida."
  echo ""
  echo "  Opciones:"
  echo "    mv $LEGACY_FILE $DEV_FILE  # si apunta a localhost"
  echo "    mv $LEGACY_FILE $PRO_FILE  # si apunta a producción"
  echo "    chmod 600 <fichero-destino>"
  echo ""
  exit 1
fi

info "LANGFUSE_HOST detectado: $LANGFUSE_HOST_VALUE"

# ── 3. Clasificar DEV vs PRO por el host ─────────────────────────────────────
TARGET_FILE=""
TARGET_LABEL=""

if echo "$LANGFUSE_HOST_VALUE" | grep -qiE "localhost|127\.0\.0\.1"; then
  TARGET_FILE="$DEV_FILE"
  TARGET_LABEL="dev"
elif echo "$LANGFUSE_HOST_VALUE" | grep -qiE "^https://"; then
  TARGET_FILE="$PRO_FILE"
  TARGET_LABEL="pro"
else
  warn "No se puede clasificar el host '$LANGFUSE_HOST_VALUE' como dev (localhost) ni pro (https://)."
  warn "Fichero legacy dejado intacto — migración manual requerida."
  echo ""
  echo "  Opciones:"
  echo "    mv $LEGACY_FILE $DEV_FILE  # si es entorno de desarrollo local"
  echo "    mv $LEGACY_FILE $PRO_FILE  # si es entorno de producción"
  echo "    chmod 600 <fichero-destino>"
  echo ""
  exit 1
fi

info "Clasificado como entorno: $TARGET_LABEL → $TARGET_FILE"

# ── 4. Verificar que no existe ya el fichero destino ─────────────────────────
if [[ -f "$TARGET_FILE" ]]; then
  warn "$TARGET_FILE ya existe. No se sobreescribirá."
  warn "Revisa manualmente y elimina el legacy: rm $LEGACY_FILE"
  echo ""
  exit 1
fi

# ── 5. Migrar (renombrar) ─────────────────────────────────────────────────────
if $DRY_RUN; then
  dryrun "mv $LEGACY_FILE $TARGET_FILE"
  dryrun "chmod 600 $TARGET_FILE"
  echo ""
  ok "Dry-run completado. Sin cambios en disco."
else
  mv "$LEGACY_FILE" "$TARGET_FILE"
  chmod 600 "$TARGET_FILE"
  ok "Migrado: $LEGACY_FILE → $TARGET_FILE (chmod 600)"
  echo ""
  # Detectar shell rc activo defensivamente (set -u activo, no asumir env var)
  RC_PATH="${ZDOTDIR:-$HOME}/.zshrc"
  [ -f "$RC_PATH" ] || RC_PATH="$HOME/.bashrc"
  echo "  Próximo paso: ejecuta 'source $RC_PATH' y usa los alias:"
  echo "    atlax-env-dev   (si aún no has instalado aliases, ejecuta setup.sh o pilot-onboarding.sh)"
  echo "    atlax-env-pro"
fi

echo ""
