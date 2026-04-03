#!/usr/bin/env bash
set -e

OUTDIR="$(dirname "$0")/binaries"
ENTRY="./cli/index.ts"

mkdir -p "$OUTDIR"

echo "Building wispctl binaries..."

bun build --compile --minify --target=bun-darwin-arm64 "$ENTRY" --outfile "$OUTDIR/wisp-cli-aarch64-darwin"
echo "  ✓ aarch64-darwin"

bun build --compile --minify --target=bun-darwin-x64 "$ENTRY" --outfile "$OUTDIR/wisp-cli-x86_64-darwin"
echo "  ✓ x86_64-darwin"

bun build --compile --minify --target=bun-linux-arm64 "$ENTRY" --outfile "$OUTDIR/wisp-cli-aarch64-linux"
echo "  ✓ aarch64-linux"

bun build --compile --minify --target=bun-linux-x64 "$ENTRY" --outfile "$OUTDIR/wisp-cli-x86_64-linux"
echo "  ✓ x86_64-linux"

bun build --compile --minify --target=bun-windows-x64 "$ENTRY" --outfile "$OUTDIR/wisp-cli-x86_64-windows.exe"
echo "  ✓ x86_64-windows"

lipo -create -output "$OUTDIR/wisp-cli-darwin-universal" \
  "$OUTDIR/wisp-cli-aarch64-darwin" \
  "$OUTDIR/wisp-cli-x86_64-darwin"
echo "  ✓ darwin-universal (lipo)"

echo ""
echo "Done. Binaries written to $OUTDIR:"
ls -lh "$OUTDIR"
