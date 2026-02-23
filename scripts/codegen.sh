#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
AUTO_ACCEPT=""
if [[ "$1" == "-y" || "$1" == "--yes" ]]; then
  AUTO_ACCEPT="yes |"
fi

echo "=== Generating TypeScript lexicons ==="
cd "$ROOT_DIR/packages/@wispplace/lexicons"
eval "$AUTO_ACCEPT bun run codegen"

if [[ ! -f "$ROOT_DIR/packages/@wispplace/lexicons/src/atcute/lexicons/index.ts" ]]; then
  echo "ERROR: missing generated atcute lexicons index at packages/@wispplace/lexicons/src/atcute/lexicons/index.ts" >&2
  exit 1
fi

echo "=== Done ==="
