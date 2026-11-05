#!/usr/bin/env bash
# Type-checks the Cline adapter (and the engine modules it imports) with TypeScript 5.9.3.
# TSC and NODE_TYPES may point at any install; the defaults are the offline npx cache entries.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TSC=${TSC:-$(ls -d "$HOME"/.npm/_npx/*/node_modules/typescript/bin/tsc 2>/dev/null | while read -r t; do grep -q '"version": "5.9.3"' "$(dirname "$t")/../package.json" && echo "$t"; done | head -1 || true)}
NODE_TYPES=${NODE_TYPES:-$(dirname "$(ls -d "$HOME"/.npm/_npx/*/node_modules/@types/node/package.json 2>/dev/null | head -1 || true)")/..}
[ -n "$TSC" ] && [ -x "$TSC" ] || { echo "typecheck: TypeScript 5.9.3 not found (set TSC)"; exit 2; }
[ -d "$NODE_TYPES/node" ] || { echo "typecheck: @types/node not found (set NODE_TYPES to the @types directory)"; exit 2; }
echo "tsc $("$TSC" --version) · @types/node $(grep '"version"' "$NODE_TYPES/node/package.json" | tr -d ' ",' | cut -d: -f2)"
exec "$TSC" -p "$HERE/tsconfig.json" --typeRoots "$NODE_TYPES"
