#!/usr/bin/env bash
# Guarded development launcher: runs Claude Code in genuine Auto mode with an out-of-tree snapshot of this plugin
# loaded inline as the SONNET_LED profile, so the repository being edited is never the plugin directory.
#
#   scripts/dev-launch.sh [--source HEAD|WORKTREE] [--check] [--keep] [-- claude args...]
#
#   --source HEAD       (default) snapshot the committed tree (git archive HEAD)
#   --source WORKTREE   snapshot the tracked and unignored files as they are now, uncommitted changes included
#   --check             take the snapshot, run every preflight, print what would launch, and stop
#   --keep              keep the snapshot after Claude exits (it is removed otherwise)
#
# Why it exists. An empty `--plugin-dir` (for example `--plugin-dir "$SNAP"` with SNAP unset in a fresh terminal)
# resolves against the working directory, so Claude Code treats the repository itself as the protected plugin
# directory and Auto mode refuses its Edit/Write calls. Every check below exists to make that state impossible to
# launch. The script never edits settings files, never changes the permission mode away from Auto, never adds an
# allow rule and never touches the installed (production) plugin; any failed check exits non-zero before Claude starts.
set -euo pipefail
umask 077

fail() { printf 'dev-launch: %s\n' "$*" >&2; exit 1; }

source_kind=HEAD
check_only=0
keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) [[ $# -ge 2 ]] || fail '--source needs HEAD or WORKTREE'; source_kind=$2; shift 2 ;;
    --check) check_only=1; shift ;;
    --keep) keep=1; shift ;;
    --) shift; break ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ $source_kind == HEAD || $source_kind == WORKTREE ]] || fail "--source must be HEAD or WORKTREE, not '$source_kind'"

repo=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run it inside the plugin repository'
repo=$(realpath -e -- "$repo")
[[ -f $repo/.claude-plugin/plugin.json ]] || fail "no plugin manifest in the source repository: $repo/.claude-plugin/plugin.json"

claude_bin=${CLAUDE_BIN:-$(command -v claude || true)}
[[ -n $claude_bin && -x $claude_bin ]] || fail 'claude was not found on PATH (set CLAUDE_BIN)'

snap=$(mktemp -d "${TMPDIR:-/tmp}/cobalt-inline-XXXXXX")
cleanup() { [[ $keep -eq 1 ]] || { [[ -n ${snap:-} && -d $snap && $snap == */cobalt-inline-* ]] && rm -rf -- "$snap"; }; }
trap cleanup EXIT

case $source_kind in
  HEAD) git -C "$repo" archive --format=tar HEAD | tar -x -C "$snap" ;;
  WORKTREE) git -C "$repo" ls-files -z --cached --others --exclude-standard | tar -c --null --ignore-failed-read -C "$repo" -T - | tar -x -C "$snap" ;;
esac

# --- preflight: all of it must hold, or nothing launches ---
[[ -n $snap ]] || fail 'the snapshot path is empty'
snap=$(realpath -e -- "$snap")
[[ -d $snap ]] || fail "the snapshot is not a directory: $snap"
[[ -n $(ls -A -- "$snap") ]] || fail "the snapshot is empty: $snap"
[[ -f $snap/.claude-plugin/plugin.json ]] || fail "the snapshot has no plugin manifest: $snap/.claude-plugin/plugin.json"
[[ $snap != "$repo" ]] || fail 'the snapshot is the repository itself'
case "$snap/" in "$repo"/*) fail "the snapshot is inside the repository: $snap" ;; esac
case "$repo/" in "$snap"/*) fail "the snapshot contains the repository: $snap" ;; esac
[[ $PWD/ != "$snap"/* ]] || fail 'the working directory is inside the snapshot'
name=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$snap/.claude-plugin/plugin.json" | head -n1)
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$snap/.claude-plugin/plugin.json" | head -n1)
[[ $name == cobalt-cockpit ]] || fail "the snapshot manifest names '$name', not cobalt-cockpit"
[[ -n $version ]] || fail 'the snapshot manifest has no version'

# Exactly one Cockpit: the inline copy is enabled, the installed marketplace copy is switched off for this launch only
# (a --settings overlay; no settings file is written).
settings='{"enabledPlugins":{"cobalt-cockpit@cobalt-cockpit":false},"pluginConfigs":{"cobalt-cockpit@inline":{"options":{"orchestration":true,"profile":"SONNET_LED","subscriptionOnly":true,"blockFable":true,"cobaltStrict":true,"reasoningMode":"AUTO","maxEffort":"max"}}}}'

if [[ -z ${CLAUDE_CONFIG_DIR:-} && -d $HOME/.claude-main ]]; then export CLAUDE_CONFIG_DIR=$HOME/.claude-main; fi

printf 'dev-launch: source=%s repo=%s\n' "$source_kind" "$repo"
printf 'dev-launch: snapshot=%s cobalt-cockpit %s (%s files)\n' "$snap" "$version" "$(find "$snap" -type f | wc -l)"
printf 'dev-launch: permission-mode=auto profile=SONNET_LED config-dir=%s\n' "${CLAUDE_CONFIG_DIR:-<default>}"
if [[ $check_only -eq 1 ]]; then printf 'dev-launch: preflight passed; --check given, not launching\n'; exit 0; fi

# Not exec: the trap must remove the snapshot afterwards.
"$claude_bin" --permission-mode auto --plugin-dir "$snap" --settings "$settings" "$@"
