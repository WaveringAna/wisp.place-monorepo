#!/bin/bash
# Build Linux and macOS binaries

set -e

mkdir -p binaries
rm -rf target

# Build macOS binaries natively
echo "Building macOS binaries..."
rustup target add aarch64-apple-darwin

echo "Building macOS arm64 binary."
RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target aarch64-apple-darwin
cp target/aarch64-apple-darwin/release/wisp-cli binaries/wisp-cli-macos-arm64
