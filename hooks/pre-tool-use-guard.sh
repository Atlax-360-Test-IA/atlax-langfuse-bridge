#!/bin/bash
# hooks/pre-tool-use-guard.sh
#
# PreToolUse guard para atlax-langfuse-bridge.
# Bloquea operaciones destructivas sobre el stack de datos de Langfuse.
#
# Patrones bloqueados:
#   - docker compose down -v / docker-compose down -v  (destruye volumenes)
#   - docker volume rm / prune                          (destruye datos)
#   - rm -rf sobre directorios de datos conocidos       (destruye JSONLs o backups)
#   - dropdb / DROP DATABASE langfuse                   (destruye BD)
#
# Exit codes:
#   0 -> permitir
#   2 -> bloquear (Claude Code muestra stderr al usuario y detiene la herramienta)

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Solo interceptamos Bash
[ "$TOOL_NAME" != "Bash" ] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[ -z "$COMMAND" ] && exit 0

# Extraer solo la primera linea y la parte anterior al primer delimitador de string
# (comilla simple o doble) para evitar falsos positivos en argumentos literales.
# Cubre: git commit -m "...docker...", echo "drop database", HEREDOCs, etc.
COMMAND_PREFIX=$(echo "$COMMAND" | head -1 | sed "s/['\"].*//")

# Solo continuar si el prefijo contiene palabras clave de riesgo conocidas
if ! echo "$COMMAND_PREFIX" | grep -qE '(docker|docker-compose|\brm\b|dropdb|psql)'; then
  exit 0
fi

# --- Patrones destructivos ---

# docker compose down -v (cualquier variante de flag corta que incluya v)
if echo "$COMMAND" | grep -qE '(docker[[:space:]]+compose|docker-compose)[[:space:]].*down[[:space:]].*-[a-zA-Z]*v'; then
  echo "BLOQUEADO: 'docker compose down -v' destruye los volumenes de datos de Langfuse (Postgres, ClickHouse, MinIO, Redis) y es irrecuperable si no hay backup verificado." >&2
  echo "Para parar el stack SIN borrar datos: docker compose down (sin -v)" >&2
  echo "Si realmente necesitas destruir los volumenes, ejecuta el comando manualmente en el terminal con: ! docker compose down -v" >&2
  exit 2
fi

# docker volume rm o prune
if echo "$COMMAND" | grep -qE 'docker[[:space:]]+volume[[:space:]]+(rm|remove|prune)'; then
  echo "BLOQUEADO: operacion destructiva sobre volumenes Docker detectada." >&2
  echo "Los volumenes postgres-data, clickhouse-data, minio-data y redis-data contienen datos de Langfuse." >&2
  echo "Si realmente necesitas esta operacion, ejecuta el comando manualmente en el terminal con: ! <comando>" >&2
  exit 2
fi

# rm -rf sobre directorios de datos conocidos
if echo "$COMMAND" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f[[:space:]].*(\~/.atlax-ai|\.claude/projects|postgres-data|clickhouse-data|minio-data|redis-data|atlax-langfuse)'; then
  echo "BLOQUEADO: 'rm -rf' sobre directorio de datos protegido detectado." >&2
  echo "Si realmente necesitas esta operacion, ejecuta el comando manualmente en el terminal con: ! <comando>" >&2
  exit 2
fi

# dropdb langfuse o DROP DATABASE langfuse (dropdb acepta flags antes del nombre de BD)
if echo "$COMMAND" | grep -qiE '(dropdb|DROP[[:space:]]+DATABASE)' && echo "$COMMAND" | grep -qi 'langfuse'; then
  echo "BLOQUEADO: operacion DROP DATABASE langfuse detectada." >&2
  echo "Si realmente necesitas eliminar la BD, ejecuta el comando manualmente en el terminal con: ! <comando>" >&2
  exit 2
fi

exit 0
