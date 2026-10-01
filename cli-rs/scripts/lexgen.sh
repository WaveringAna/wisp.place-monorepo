#!/usr/bin/env sh
# Regenerate crates/wispplace-lexicons/src from the repo's lexicon JSON with the
# jacquard fork's codegen (see DESIGN.md), so generated code matches the
# runtime crates we build against.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
jacquard="${JACQUARD_DIR:-$root/../../jacquard}"
out="$root/crates/wispplace-lexicons/src"
cargo build --quiet --release --manifest-path "$jacquard/Cargo.toml" -p jacquard-lexgen --bin jacquard-codegen
rm -rf "$out"
"$jacquard/target/release/jacquard-codegen" --input "$root/../lexicons" --output "$out"
