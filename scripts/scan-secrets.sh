#!/usr/bin/env bash
# Secret scan used by CI and by developers: the same command in both places.
#   scripts/scan-secrets.sh            scan all reachable history and the working tree
# Findings are redacted: only rule, file, line and commit are printed, never a
# value. Reports are written with mode 0600 to $GITLEAKS_ARTIFACTS (default
# a private temporary directory); do not publish them.
set -euo pipefail

VERSION=8.30.1
SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_x64.tar.gz"

root=$(git rev-parse --show-toplevel)
cd "$root"
umask 077
out=${GITLEAKS_ARTIFACTS:-$(mktemp -d)}
mkdir -p "$out"

bin=${GITLEAKS_BIN:-}
if [[ -z "$bin" ]] && command -v gitleaks >/dev/null 2>&1 && [[ "$(gitleaks version)" == "$VERSION" ]]; then
  bin=$(command -v gitleaks)
fi
if [[ -z "$bin" ]]; then
  [[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] || { echo "Install gitleaks $VERSION and set GITLEAKS_BIN." >&2; exit 2; }
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl --fail --silent --show-error --location "$URL" --output "$tmp/gitleaks.tar.gz"
  echo "$SHA256  $tmp/gitleaks.tar.gz" | sha256sum --check --quiet -
  tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
  bin=$tmp/gitleaks
fi

# A scan must not be configurable by what it scans: a repository config or an
# inline allow marker would let a change switch the check off.
if [[ -e .gitleaks.toml || -e .gitleaks.yaml || -e .gitleaks.yml ]]; then echo "secret scan: a repository gitleaks config is not allowed" >&2; exit 1; fi
if git grep -nI 'gitleaks:allow' -- . ':!scripts/scan-secrets.sh' >/dev/null; then echo "secret scan: gitleaks:allow markers are not allowed" >&2; exit 1; fi
cfg=$root/.github/gitleaks.toml

status=0
"$bin" git --config "$cfg" --no-banner --redact=100 --verbose=false --report-format json --report-path "$out/history.json" --log-opts="--all" . >/dev/null 2>"$out/history.log" || status=1
"$bin" dir --config "$cfg" --no-banner --redact=100 --report-format json --report-path "$out/worktree.json" . >/dev/null 2>"$out/worktree.log" || status=1

for scan in history worktree; do
  python3 -I - "$out/$scan.json" "$scan" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
print(f"{sys.argv[2]}: {len(rows)} finding(s)")
for r in rows:
    print(f"  {r['RuleID']} {r['File']}:{r['StartLine']} {(r.get('Commit') or '-')[:8]}")
PY
done
[[ $status -eq 0 ]] && echo "secret scan: clean" || echo "secret scan: FINDINGS (values withheld; see $out, mode 0600)" >&2
exit $status
