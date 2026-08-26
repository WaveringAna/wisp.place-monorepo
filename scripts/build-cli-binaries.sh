#!/usr/bin/env bash
#
# Build the distributable wispctl binaries into ./binaries.
#
# Binaries keep the legacy `wisp-cli-*` names so existing CI pipelines that curl
# them keep working.
#
# Bun 1.3.14 cannot cross-compile a working linux executable from macOS — the
# resulting binary dies at startup inside @noble/curves ("bad curve params:
# generator point"). The JS bundle itself is fine, so the linux targets are
# built natively inside linux containers instead. macOS targets cross-compile
# correctly from an arm64 host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/binaries"
BUN_IMAGE="oven/bun:1.3.14-slim"

mkdir -p "$OUT_DIR"
cd "$REPO_ROOT/cli"

host_build() {
	local target="$1" out="$2"
	echo "==> $out ($target, host)"
	bun build ./index.ts --compile --target="$target" --outfile="$OUT_DIR/$out"
}

docker_build() {
	local platform="$1" target="$2" out="$3"
	echo "==> $out ($target, docker $platform)"
	# Run from a writable cwd: building a target other than the container's own
	# downloads that target's runtime next to the working directory, and the repo
	# is mounted read-only.
	docker run --rm --platform "$platform" \
		-v "$REPO_ROOT":/repo:ro -v "$OUT_DIR":/out -w /tmp \
		-e BUN_INSTALL=/tmp/bun \
		"$BUN_IMAGE" bun build /repo/cli/index.ts --compile --target="$target" --outfile="/out/$out"
}

host_build bun-darwin-arm64 wisp-cli-aarch64-darwin
host_build bun-darwin-x64 wisp-cli-x86_64-darwin
docker_build linux/amd64 bun-linux-x64 wisp-cli-x86_64-linux
docker_build linux/arm64 bun-linux-arm64 wisp-cli-aarch64-linux
# Windows has no native runner here. Build it from the linux container, which is
# the toolchain that produces working non-macOS output — this binary is the one
# target that cannot be smoke-tested locally.
docker_build linux/amd64 bun-windows-x64 wisp-cli-x86_64-windows.exe

# Universal macOS binary for the install docs.
echo "==> wisp-cli-darwin-universal (lipo)"
lipo -create -output "$OUT_DIR/wisp-cli-darwin-universal" \
	"$OUT_DIR/wisp-cli-aarch64-darwin" "$OUT_DIR/wisp-cli-x86_64-darwin"

chmod +x "$OUT_DIR"/wisp-cli-*
cd "$OUT_DIR"
shasum -a 256 wisp-cli-* | tee SHA256SUMS
