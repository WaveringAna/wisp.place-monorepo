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

echo "=== Generating Rust lexicons ==="
echo "Installing jacquard-lexgen..."
cargo install jacquard-lexgen --version 0.9.5 2>/dev/null || true
echo "Running jacquard-codegen..."
echo "  Input: $ROOT_DIR/lexicons"
echo "  Output: $ROOT_DIR/cli/crates/lexicons/src"
jacquard-codegen -i "$ROOT_DIR/lexicons" -o "$ROOT_DIR/cli/crates/lexicons/src"

# Add extern crate alloc for the macro to work
sed -i '' '1s/^/extern crate alloc;\n\n/' "$ROOT_DIR/cli/crates/lexicons/src/lib.rs"

echo "=== Done ==="
