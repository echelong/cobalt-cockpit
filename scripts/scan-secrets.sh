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

# A scan must not be configurable by what it scans. A repository config, an
# inline allow marker (in the tree or in any commit) or a changed ignore list
# would let a change switch the check off, so each is refused here. This script
# and the files it pins are protected by CODEOWNERS and required review: a change
# to the pins below is a change to the security check and is reviewed as one.
IGNORE_SHA256=8be19d883c581024128750b36a95d61c15d1779fa1a4e3605ccfa251d1eb4337
CONFIG_SHA256=27630a96d6c55755cc37620f3933d5cab94b1eb78a726a32e11212972525d76e
marker='gitleaks[:]allow'
if [[ -e .gitleaks.toml || -e .gitleaks.yaml || -e .gitleaks.yml ]]; then echo "secret scan: a repository gitleaks config is not allowed" >&2; exit 1; fi
if git grep -nIE "$marker" >/dev/null; then echo "secret scan: allow markers are not allowed" >&2; exit 1; fi
# the one historical line (commit 812b074) that spelled the marker, pinned by exact content
KNOWN_LINE_SHA256=9fe40b878fc575b835eb9d02fdfc82804c5b4b239270198b9e3e2dad10747fab
while IFS= read -r added; do
  [[ "$(printf '%s' "$added" | sha256sum | cut -c1-64)" == "$KNOWN_LINE_SHA256" ]] || { echo "secret scan: an allow marker appears in history" >&2; exit 1; }
done < <(git log --all -p --format= -G "$marker" | grep -E '^\+' | grep -E "$marker" || true)
echo "$IGNORE_SHA256  .gitleaksignore" | sha256sum --check --quiet - || { echo "secret scan: .gitleaksignore changed" >&2; exit 1; }
echo "$CONFIG_SHA256  .github/gitleaks.toml" | sha256sum --check --quiet - || { echo "secret scan: .github/gitleaks.toml changed" >&2; exit 1; }
cfg=$root/.github/gitleaks.toml

status=0
"$bin" git --config "$cfg" --ignore-gitleaks-allow --no-banner --redact=100 --verbose=false --report-format json --report-path "$out/history.json" --log-opts="--all" . >/dev/null 2>"$out/history.log" || status=1
"$bin" dir --config "$cfg" --ignore-gitleaks-allow --no-banner --redact=100 --report-format json --report-path "$out/worktree.json" . >/dev/null 2>"$out/worktree.log" || status=1

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
