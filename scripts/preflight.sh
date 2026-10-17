#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f ".env.runtime" ]; then
  echo "ERROR: .env.runtime not found."
  echo "Run: cp .env.example .env.runtime"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source ".env.runtime"
set +a

required_vars=(
  FEISHU_APP_ID
  FEISHU_APP_SECRET
  OPENCODE_PATH
  OPENCODE_WORKING_DIR
)

missing=0
for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: missing required env: $var"
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH"
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 18 ]; then
  echo "ERROR: node >= 18 required (found $(node -v))"
  exit 1
fi

if [ ! -x "$OPENCODE_PATH" ]; then
  echo "ERROR: OPENCODE_PATH is not executable: $OPENCODE_PATH"
  exit 1
fi

if [ ! -d "$OPENCODE_WORKING_DIR" ]; then
  echo "ERROR: OPENCODE_WORKING_DIR does not exist: $OPENCODE_WORKING_DIR"
  exit 1
fi

if [ ! -w "$OPENCODE_WORKING_DIR" ]; then
  echo "ERROR: OPENCODE_WORKING_DIR is not writable: $OPENCODE_WORKING_DIR"
  exit 1
fi

echo "OK: required env variables present"
echo "OK: node=$(command -v node) ($(node -v))"
echo "OK: opencode=$OPENCODE_PATH"
echo "OK: working_dir=$OPENCODE_WORKING_DIR"

if [ -n "${OPENCODE_MODEL:-}" ]; then
  echo "INFO: OPENCODE_MODEL=$OPENCODE_MODEL"
else
  echo "INFO: OPENCODE_MODEL not set (session default will be used)"
fi

echo "INFO: status card enabled=${OPENCODE_STATUS_ENABLED:-true}, notify_default=${OPENCODE_NOTIFY_DEFAULT:-normal}"
