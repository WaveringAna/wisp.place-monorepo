#!/bin/bash
# Build macOS universal binary (arm64 + x86_64)

set -e

mkdir -p binaries
rm -rf target

echo "Building macOS universal binary..."

# Add both targets
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# Build arm64
echo "Building macOS arm64..."
RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target aarch64-apple-darwin

# Build x86_64
echo "Building macOS x86_64..."
RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target x86_64-apple-darwin

# Create universal binary with lipo
echo "Creating universal binary..."
lipo -create \
    target/aarch64-apple-darwin/release/wisp-cli \
    target/x86_64-apple-darwin/release/wisp-cli \
    -output binaries/wisp-cli-darwin-universal

# Also keep individual binaries if needed
cp target/aarch64-apple-darwin/release/wisp-cli binaries/wisp-cli-darwin-arm64
cp target/x86_64-apple-darwin/release/wisp-cli binaries/wisp-cli-darwin-x86_64

echo "Done! Universal binary: binaries/wisp-cli-darwin-universal"
