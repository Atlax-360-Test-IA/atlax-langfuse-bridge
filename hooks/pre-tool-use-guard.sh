#!/bin/bash
# hooks/pre-tool-use-guard.sh
#
# PreToolUse guard para atlax-langfuse-bridge.
# Bloquea operaciones destructivas sobre el stack de datos de Langfuse.
#
# Patrones bloqueados:
#   - docker compose down -v / docker-compose down -v  (destruye volúmenes)
#   - docker volume rm / prune                          (destruye datos)
#   - rm -rf sobre directorios de datos conocidos       (destruye JSONLs o backups)
#   - pg_dropcluster / dropdb langfuse                  (destruye BD)
#
# Exit codes:
#   0 → permitir
#   2 → bloquear (Claude Code muestra stderr al usuario y detiene la herramienta)

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Solo interceptamos Bash
[ "$TOOL_NAME" != "Bash" ] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[ -z "$COMMAND" ] && exit 0

# --- Patrones destructivos ---

# docker compose down -v (cualquier variante de flag)
if echo "$COMMAND" | grep -qE '(docker[[:space:]]+compose|docker-compose)[[:space:]].*down[[:space:]].*-[a-zA-Z]*v'; then
  echo "BLOQUEADO: 'docker compose down -v' destruye los volúmenes de datos de Langfuse (Postgres, ClickHouse, MinIO, Redis) y es irrecuperable si no hay backup verificado." >&2
  echo "Para parar el stack SIN borrar datos: docker compose down (sin -v)" >&2
  echo "Si realmente necesitas destruir los volúmenes, ejecuta el comando manualmente en el terminal con: ! docker compose down -v" >&2
  exit 2
fi

# docker volume rm o prune sobre volúmenes de datos conocidos
if echo "$COMMAND" | grep -qE 'docker[[:space:]]+volume[[:space:]]+(rm|remove|prune)'; then
  echo "BLOQUEADO: operación destructiva sobre volúmenes Docker detectada." >&2
  echo "Los volúmenes postgres-data, clickhouse-data, minio-data y redis-data contienen datos de Langfuse." >&2
  echo "Si realmente necesitas esta operación, ejecuta el comando manualmente en el terminal con: ! <comando>" >&2
  exit 2
fi

# rm -rf sobre directorios de datos conocidos
if echo "$COMMAND" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f[[:space:]].*(\~/.atlax-ai|\.claude/projects|postgres-data|clickhouse-data|minio-data|redis-data|atlax-langfuse)'; then
  echo "BLOQUEADO: 'rm -rf' sobre directorio de datos protegido detectado." >&2
  echo "Si realmente necesitas esta operación, ejecuta el comando manualmente en el terminal con: ! <comando>" >&2
  exit 2
fi

# dropdb langfuse o DROP DATABASE langfuse via psql
# dropdb acepta flags arbitrarias antes del nombre de BD, así que buscamos
# que el comando contenga tanto dropdb/DROP DATABASE como langfuse
if echo "$COMMAND" | grep -qiE '(dropdb|DROP[[:space:]]+DATABASE)' && echo "$COMMAND" | grep -qi 'langfuse'; then
  echo "BLOQUEADO: operación DROP DATABASE langfuse detectada." >&2
  echo "Si realmente necesitas eliminar la BD, ejecuta el comando manualmente en el terminal con: ! <comando>" >&2
  exit 2
fi

exit 0
