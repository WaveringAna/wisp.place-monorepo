#!/usr/bin/env bash
#
# Fetch Komodo's client type declarations into deploy/komodo/vendor/.
#
# The types describe the client of the Komodo you deploy to, so they come
# from that instance rather than being committed. Re-run after a Komodo
# upgrade. The endpoint needs no credentials.
#
#   KOMODO_ADDRESS=https://komodo.example ./deploy/fetch-komodo-types.sh

set -euo pipefail

: "${KOMODO_ADDRESS:?set KOMODO_ADDRESS to the Komodo base url, no trailing slash}"

dest="$(cd "$(dirname "$0")" && pwd)/komodo/vendor"
mkdir -p "$dest"

for f in types lib responses terminal; do
  curl -fsSL "$KOMODO_ADDRESS/client/$f.d.ts" -o "$dest/$f.d.ts"
done
echo "fetched komodo client types into $dest"
