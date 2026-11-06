#!/usr/bin/env bash
# Offline test suite for the Cline adapter (fake providers, real bubblewrap, real git).
# Live provider tests are separate and opt-in: bin/cockpit-cline smoke --yes.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$HERE"
# the same settings the launcher clears: the broker refuses to run with any of them, which would fail most tests
unset NODE_OPTIONS NODE_PATH NODE_COMPILE_CACHE LD_PRELOAD LD_AUDIT NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS NODE_USE_ENV_PROXY SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE OPENSSL_CONF \
  COCKPIT_BROKER_UPSTREAM COCKPIT_CLINE_BIN COCKPIT_CLINE_BWRAP COCKPIT_CLINE_CATALOG_BIN COCKPIT_CLINE_NODE
FILES=("$@"); [ ${#FILES[@]} -gt 0 ] || FILES=(test/*.spec.ts)
exec node --experimental-transform-types --no-warnings --import ./loader/register.mjs --test --test-concurrency=1 --test-reporter=spec "${FILES[@]}"
