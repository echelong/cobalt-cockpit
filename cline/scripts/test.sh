#!/usr/bin/env bash
# Offline test suite for the Cline adapter (fake providers, real bubblewrap, real git).
# Live provider tests are separate and opt-in: bin/cockpit-cline smoke --yes.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$HERE"
FILES=("$@"); [ ${#FILES[@]} -gt 0 ] || FILES=(test/*.spec.ts)
exec node --experimental-transform-types --no-warnings --import ./loader/register.mjs --test --test-concurrency=1 --test-reporter=spec "${FILES[@]}"
