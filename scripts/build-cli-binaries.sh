#!/usr/bin/env bash
#
# Build the distributable wispctl binaries into ./binaries from the Rust port
# (cli-rs). Binaries keep the legacy `wisp-cli-*` names so existing CI pipelines
# that curl them keep working.
#
# Linux builds are fully static (musl) so they run on any distro, nixery and
# busybox included; Windows is a self-contained GNU build. Both cross-compile
# with cargo-zigbuild. macOS builds link only the system frameworks.
#
# Needs: rustup targets below, zig, cargo-zigbuild, lipo (Xcode tools).
#   rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
#     x86_64-pc-windows-gnu x86_64-apple-darwin aarch64-apple-darwin
#   brew install zig && cargo install cargo-zigbuild --locked
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/binaries"
TARGET_DIR="$REPO_ROOT/cli-rs/target"

mkdir -p "$OUT_DIR"
cd "$REPO_ROOT/cli-rs"

build() {
	local tool="$1" target="$2" out="$3" exe="${4:-wispctl}"
	echo "==> $out ($target)"
	cargo $tool --locked --release -p wispctl --target "$target"
	cp "$TARGET_DIR/$target/release/$exe" "$OUT_DIR/$out"
}

build build aarch64-apple-darwin wisp-cli-aarch64-darwin
build build x86_64-apple-darwin wisp-cli-x86_64-darwin
build zigbuild x86_64-unknown-linux-musl wisp-cli-x86_64-linux
build zigbuild aarch64-unknown-linux-musl wisp-cli-aarch64-linux
build zigbuild x86_64-pc-windows-gnu wisp-cli-x86_64-windows.exe wispctl.exe

# Universal macOS binary for the install docs.
echo "==> wisp-cli-darwin-universal (lipo)"
lipo -create -output "$OUT_DIR/wisp-cli-darwin-universal" \
	"$OUT_DIR/wisp-cli-aarch64-darwin" "$OUT_DIR/wisp-cli-x86_64-darwin"

chmod +x "$OUT_DIR"/wisp-cli-*
cd "$OUT_DIR"
shasum -a 256 wisp-cli-* | tee SHA256SUMS
