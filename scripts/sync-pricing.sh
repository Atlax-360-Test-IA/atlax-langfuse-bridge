#!/usr/bin/env bash
# sync-pricing.sh — Valida que MODEL_PRICING en el bridge esté alineado con
# la fuente oficial de precios de Anthropic y opcionalmente la del dashboard.
#
# Uso:
#   ./scripts/sync-pricing.sh              # valida + imprime resumen
#   DRY_RUN=1 ./scripts/sync-pricing.sh   # solo imprime, no modifica nada
#   DASHBOARD_PRICING_PATH=<path> ./scripts/sync-pricing.sh
#                                          # compara también con dashboard
#
# Exit codes:
#   0 — precios en sync (o solo consulta)
#   1 — error de configuración / fichero no encontrado
#   2 — divergencia detectada (bridge desactualizado)
#
# Qué verifica:
#   1. Que shared/model-pricing.ts existe y contiene entradas para los modelos
#      activos definidos en EXPECTED_MODELS.
#   2. (Opcional) Que el MODEL_PRICING del bridge y del dashboard tienen los
#      mismos modelos — divergencia indica que uno de los dos está desactualizado.
#
# Limitaciones:
#   - No descarga precios de Anthropic automáticamente (requeriría cuenta API).
#   - La validación es estructural (claves presentes), no de valores (precio exacto).
#   - Para actualizar valores, editar shared/model-pricing.ts manualmente y
#     confirmar en https://platform.claude.com/docs/en/about-claude/pricing

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRICING_FILE="$REPO_ROOT/shared/model-pricing.ts"
DRY_RUN="${DRY_RUN:-0}"
# Path al pricing del dashboard hermano (opcional, cross-project read-only)
DASHBOARD_PRICING_PATH="${DASHBOARD_PRICING_PATH:-}"

# Modelos Anthropic activos a mayo 2026 que DEBEN estar en MODEL_PRICING.
# Actualizar esta lista cuando Anthropic lance nuevos modelos de producción.
EXPECTED_MODELS=(
  "claude-opus-4-7"
  "claude-opus-4-6"
  "claude-opus-4-5"
  "claude-opus-4-1"
  "claude-sonnet-4"
  "claude-haiku-4-5"
)

# ─── Helpers ─────────────────────────────────────────────────────────────────

log_info()  { echo "[sync-pricing] INFO  $*"; }
log_warn()  { echo "[sync-pricing] WARN  $*" >&2; }
log_error() { echo "[sync-pricing] ERROR $*" >&2; }

# ─── Comprobaciones de entorno ────────────────────────────────────────────────

if [[ ! -f "$PRICING_FILE" ]]; then
  log_error "No se encuentra shared/model-pricing.ts en $REPO_ROOT"
  exit 1
fi

log_info "Verificando $PRICING_FILE"

# ─── Verificar modelos esperados ──────────────────────────────────────────────

missing=()
for model in "${EXPECTED_MODELS[@]}"; do
  if ! grep -q "\"$model\"" "$PRICING_FILE"; then
    missing+=("$model")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  log_error "Modelos faltantes en MODEL_PRICING:"
  for m in "${missing[@]}"; do
    log_error "  - $m"
  done
  echo ""
  echo "Acción requerida:"
  echo "  1. Verificar precios en https://platform.claude.com/docs/en/about-claude/pricing"
  echo "  2. Añadir entradas faltantes a shared/model-pricing.ts"
  echo "  3. Ejecutar 'bun test shared/model-pricing.test.ts' para validar"
  exit 2
fi

log_info "Todos los modelos esperados presentes (${#EXPECTED_MODELS[@]} verificados)"

# ─── Extraer modelos presentes (excluye 'default') ───────────────────────────

mapfile -t bridge_models < <(
  grep -oP '"claude-[^"]+"\s*:' "$PRICING_FILE" | tr -d '"' | tr -d ':' | tr -d ' '
)

log_info "Modelos en bridge MODEL_PRICING:"
for m in "${bridge_models[@]}"; do
  echo "    $m"
done

# ─── Comparación cross-project con dashboard (opcional) ──────────────────────

if [[ -n "$DASHBOARD_PRICING_PATH" ]]; then
  if [[ ! -f "$DASHBOARD_PRICING_PATH" ]]; then
    log_warn "DASHBOARD_PRICING_PATH apunta a un fichero inexistente: $DASHBOARD_PRICING_PATH"
    log_warn "Omitiendo comparación cross-project"
  else
    log_info "Comparando con dashboard: $DASHBOARD_PRICING_PATH"

    mapfile -t dash_models < <(
      grep -oP '"claude-[^"]+"\s*:' "$DASHBOARD_PRICING_PATH" | tr -d '"' | tr -d ':' | tr -d ' '
    )

    # Modelos en bridge pero no en dashboard
    only_bridge=()
    for m in "${bridge_models[@]}"; do
      found=0
      for d in "${dash_models[@]}"; do
        [[ "$m" == "$d" ]] && found=1 && break
      done
      [[ $found -eq 0 ]] && only_bridge+=("$m")
    done

    # Modelos en dashboard pero no en bridge
    only_dash=()
    for d in "${dash_models[@]}"; do
      found=0
      for m in "${bridge_models[@]}"; do
        [[ "$d" == "$m" ]] && found=1 && break
      done
      [[ $found -eq 0 ]] && only_dash+=("$d")
    done

    divergence=0

    if [[ ${#only_bridge[@]} -gt 0 ]]; then
      log_warn "En bridge pero no en dashboard:"
      for m in "${only_bridge[@]}"; do
        log_warn "  + $m (bridge)"
      done
      divergence=1
    fi

    if [[ ${#only_dash[@]} -gt 0 ]]; then
      log_warn "En dashboard pero no en bridge:"
      for m in "${only_dash[@]}"; do
        log_warn "  + $m (dashboard)"
      done
      divergence=1
    fi

    if [[ $divergence -eq 0 ]]; then
      log_info "Bridge y dashboard tienen los mismos modelos Claude"
    else
      log_warn "Divergencia bridge↔dashboard — revisar qué proyecto está desactualizado"
      log_warn "Ver runbook: 'Actualizar pricing tras nuevo modelo Anthropic'"
      if [[ "$DRY_RUN" != "1" ]]; then
        exit 2
      fi
    fi
  fi
fi

# ─── Resumen ─────────────────────────────────────────────────────────────────

echo ""
log_info "── Resumen ──────────────────────────────────────────"
log_info "  Fichero:          shared/model-pricing.ts"
log_info "  Modelos bridge:   ${#bridge_models[@]}"
log_info "  Modelos validados: ${#EXPECTED_MODELS[@]}"
if [[ -n "$DASHBOARD_PRICING_PATH" && -f "$DASHBOARD_PRICING_PATH" ]]; then
  log_info "  Modelos dashboard: ${#dash_models[@]}"
fi
log_info "  Estado:           OK — ninguna divergencia detectada"
echo ""
log_info "Si Anthropic ha publicado nuevos precios o modelos:"
log_info "  1. Editar shared/model-pricing.ts"
log_info "  2. Añadir el modelo a EXPECTED_MODELS en este script"
log_info "  3. bun test shared/model-pricing.test.ts"
log_info "  4. bun run check"
log_info "  5. Crear PR con mensaje: 'chore(pricing): actualizar <modelo> a \$X/\$Y MTok'"

exit 0
