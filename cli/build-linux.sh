#!/usr/bin/env bash
# Build Linux binaries (statically linked)
set -e
mkdir -p binaries

# Build Linux binaries
echo "Building Linux binaries..."

echo "Building Linux ARM64 (static)..."
nix-shell -p rustup --run '
    rustup target add aarch64-unknown-linux-musl
    RUSTFLAGS="-C target-feature=+crt-static" cargo zigbuild --release --target aarch64-unknown-linux-musl
'
cp target/aarch64-unknown-linux-musl/release/wisp-cli binaries/wisp-cli-aarch64-linux

echo "Building Linux x86_64 (static)..."
nix-shell -p rustup --run '
    rustup target add x86_64-unknown-linux-musl
    RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target x86_64-unknown-linux-musl
'
cp target/x86_64-unknown-linux-musl/release/wisp-cli binaries/wisp-cli-x86_64-linux

echo "Done! Binaries in ./binaries/"
