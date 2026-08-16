#!/usr/bin/env bash
set -euo pipefail

APP="${HEROKU_APP:-official-soccer-bot}"
ENV_FILE="${1:-.env.prod}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_PATH="$ROOT/$ENV_FILE"

if [[ ! -f "$ENV_PATH" ]]; then
  echo "Missing env file: $ENV_PATH" >&2
  exit 1
fi

args=()
skipped=()

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" == export\ * ]] && line="${line#export }"

  key="${line%%=*}"
  value="${line#*=}"
  key="${key%"${key##*[![:space:]]}"}"
  key="${key#"${key%%[![:space:]]*}"}"

  if [[ -z "$key" ]]; then
    continue
  fi

  # Heroku assigns PORT per dyno. Setting it as a config var breaks routing.
  if [[ "$key" == "PORT" ]]; then
    skipped+=("$key")
    continue
  fi

  args+=("${key}=${value}")
done < "$ENV_PATH"

if [[ ${#args[@]} -eq 0 ]]; then
  echo "No config vars found in $ENV_PATH" >&2
  exit 1
fi

echo "Setting ${#args[@]} config vars on Heroku app '$APP' from $ENV_FILE"
if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "Skipping: ${skipped[*]}"
fi

heroku config:set --app "$APP" "${args[@]}"
