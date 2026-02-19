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

echo "=== Generating atcute lexicons ==="
eval "$AUTO_ACCEPT bun run codegen:atcute"

echo "=== Done ==="
