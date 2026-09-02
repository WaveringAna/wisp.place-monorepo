#!/usr/bin/env bash
#
# Type-check the Komodo Actions.
#
# An Action file is not a module — Komodo pastes its contents inside an
# `async function main()` and supplies `ARGS`, `komodo`, `Types`, `YAML` and
# `TOML` around it. Checking the files as-is therefore reports noise that is
# not real (top-level await "errors", and every Action colliding with every
# other at global scope) while hiding what matters.
#
# So each Action is wrapped exactly the way Komodo wraps it and the wrapper
# is what gets checked. Line numbers are shifted by the wrapper preamble;
# subtract 2 to map a reported line back to the source file.
#
# Types under komodo/vendor are fetched from a running Komodo:
#   for f in types lib responses terminal; do
#     curl -sL "https://<komodo>/client/$f.d.ts" -o deploy/komodo/vendor/$f.d.ts
#   done

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/komodo"
cp -R "$here/komodo/vendor" "$work/komodo/vendor"
cp "$here/komodo/komodo-globals.d.ts" "$work/komodo/"

for action in "$here"/komodo/*.ts; do
  name="$(basename "$action")"
  # declaration files describe the wrapper; they must not be wrapped by it
  case "$name" in *.d.ts) continue ;; esac
  {
    echo "export {}"
    echo "async function main() {"
    cat "$action"
    echo "}"
    echo "void main"
  } > "$work/komodo/$name"
done

cp "$here/tsconfig.json" "$work/tsconfig.json"

bunx tsc -p "$work/tsconfig.json"
echo "actions type-check clean"
