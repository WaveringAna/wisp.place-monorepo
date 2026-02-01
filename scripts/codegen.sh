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
cd "$ROOT_DIR/packages/@wisp/lexicons"
eval "$AUTO_ACCEPT npm run codegen"

echo "=== Done ==="
