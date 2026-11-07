#!/usr/bin/env bash
# A disposable place to try the committed candidate by hand, in two real Claude Code sessions on one test project (v0.6.2; profiles v0.6.3).
# Engineering preparation only: it starts nothing on its own, simulates no acknowledgment and confirms nothing for you.
#
#   scripts/acceptance-interactive.sh setup  [--dir <new empty directory>]   build it and print the two launch commands
#   scripts/acceptance-interactive.sh verify <dir>                           probe it with the host (no model, no login needed)
#   scripts/acceptance-interactive.sh launch <dir> 1|2 [profile]             start session 1 or 2 (a terminal each)
#   scripts/acceptance-interactive.sh sdk    <dir> <cockpit arguments>       one `claude -p` run of /cockpit: the sdk origin, not a person
#   scripts/acceptance-interactive.sh clean  <dir>                           remove it
#
# Isolation: everything lives under one new private directory. It has its own CLAUDE_CONFIG_DIR and HOME, so the installed
# user-scope plugin, your settings, your sessions and your store are neither read nor written, and the candidate is the only
# Cockpit that loads (no duplicate registration). The plugin is a snapshot of the committed tree (`git archive HEAD`), loaded
# with `--plugin-dir`; commit or discard changes first, the script refuses a dirty tree. No credential is copied: you sign in once,
# inside the disposable configuration, on the first launch (both sessions share it). On macOS the host may keep its sign-in in the
# system Keychain, which a configuration directory does not isolate: there the disposable session can reuse your sign-in (the
# plugin, settings and store are still its own). Set COBALT_ACCEPT_PASS_AUTH=1 to pass
# ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from your environment instead. The plugin options are given with --settings for
# these launches only, by profile: record (the default: guardRecordOnly on, guardAlerts off), kinds (the same, with only the
# critical kind notified), quiet (the same, with a quiet window over the whole UTC day), alerts (alerts on, reminders every minute).
# A session reads its options when it starts: to compare profiles, exit and launch again with another (CONTINUE=1 for session 1).
set -euo pipefail
umask 077
fail() { printf 'acceptance-interactive: %s\n' "$*" >&2; exit 2; }
cmd=${1:-}; shift || true
claude_bin=${CLAUDE_BIN:-$(command -v claude || true)}
need_claude() { [[ -n $claude_bin && -x $claude_bin ]] || fail 'claude was not found on PATH (set CLAUDE_BIN)'; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
optionsOf() { # the plugin options of a profile, or nothing for a name that is not one
  case $1 in
    record) printf '%s' '{"guardRecordOnly":true,"guardDigest":false,"telemetry":false}' ;;
    kinds) printf '%s' '{"guardRecordOnly":true,"guardNotifyKinds":"none","guardDigest":false,"telemetry":false}' ;;
    quiet) printf '%s' '{"guardRecordOnly":true,"guardQuietHours":"00:00-23:59","guardQuietTimezone":"UTC","guardDigest":false,"telemetry":false}' ;;
    alerts) printf '%s' '{"guardAlerts":true,"guardRepeat":true,"guardRepeatSec":60,"guardCooldownSec":30,"guardMaxReminders":3,"guardDigest":false,"telemetry":false}' ;;
    *) return 1 ;;
  esac
}
settingsOf() { local o; o=$(optionsOf "$1") || return 1; printf '{"pluginConfigs":{"cobalt-cockpit@inline":{"options":%s}}}' "$o"; }

check_dir() { # the directory must be one this script made
  local d=${1:-}
  [[ -n $d && -d $d ]] || fail "not a directory: ${d:-<none>}"
  d=$(realpath -e -- "$d")
  [[ $d == */cobalt-accept-* && -f $d/.made-by-acceptance-interactive ]] || fail "not a directory made by this script: $d"
  printf '%s' "$d"
}
host_env() { # the disposable environment, and only the terminal facts a notification channel is chosen from
  local d=$1
  local -a e=(PATH="$PATH" TERM="${TERM:-xterm-256color}" LANG="${LANG:-C.UTF-8}" HOME="$d/home" CLAUDE_CONFIG_DIR="$d/config" XDG_STATE_HOME="$d/state" DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1)
  for v in COLORTERM TERM_PROGRAM TERM_PROGRAM_VERSION KITTY_WINDOW_ID ITERM_SESSION_ID GHOSTTY_RESOURCES_DIR LC_ALL; do [[ -n ${!v:-} ]] && e+=("$v=${!v}"); done
  if [[ ${COBALT_ACCEPT_PASS_AUTH:-0} == 1 ]]; then for v in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do [[ -n ${!v:-} ]] && e+=("$v=${!v}"); done; fi
  printf '%s\0' "${e[@]}"
}
in_host() { # in_host <dir> <command...>: run with the disposable environment, in the project directory
  local d=$1; shift
  local -a e=(); while IFS= read -r -d '' x; do e+=("$x"); done < <(host_env "$d")
  (cd "$d/project" && env -i "${e[@]}" "$@")
}

case $cmd in
  setup)
    need_claude
    dir=
    [[ ${1:-} == --dir ]] && dir=${2:-}
    # the candidate is the repository this script belongs to, wherever it is run from
    repo=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) || fail 'this script is not inside the plugin repository'
    [[ -z $(git -C "$repo" status --porcelain) ]] || fail 'the working tree is not clean: commit or discard first, so the candidate is exactly a commit'
    sha=$(git -C "$repo" rev-parse HEAD)
    if [[ -z $dir ]]; then dir=$(mktemp -d "${TMPDIR:-/tmp}/cobalt-accept-XXXXXX"); else [[ ! -e $dir || -z $(ls -A -- "$dir") ]] || fail "not empty: $dir"; fi
    dir=$(realpath -m -- "$dir")
    [[ $dir == */cobalt-accept-* ]] || fail "the directory name must contain cobalt-accept-: $dir"
    mkdir -p -- "$dir"
    mkdir -p "$dir/config" "$dir/state" "$dir/home" "$dir/plugin" "$dir/project"
    : > "$dir/.made-by-acceptance-interactive"
    git -C "$repo" -c core.attributesFile=/dev/null archive --format=tar HEAD | tar -x -C "$dir/plugin"
    printf '%s\n' "$sha" > "$dir/candidate-sha"
    ( cd "$dir/project" && git init -q . && printf '# disposable acceptance project\n' > README.md && git add README.md && git -c user.name=acceptance -c user.email=acceptance@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m 'disposable project' )
    printf 'candidate %s (cobalt-cockpit %s)\ndirectory %s\n\n' "$sha" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/plugin/.claude-plugin/plugin.json" | head -1)" "$dir"
    printf 'Next:\n  %s verify %s\n  %s launch %s 1 [profile]     # terminal 1 (profiles: record, the default; kinds; quiet; alerts)\n  %s launch %s 2 [profile]     # terminal 2, when the procedure says so\n  %s clean %s\n' "$0" "$dir" "$0" "$dir" "$0" "$dir" "$0" "$dir"
    ;;
  verify)
    need_claude
    dir=$(check_dir "${1:-}")
    # each probe reports its own exit status: a failing probe is shown, it never silently ends the others
    probe() { local label=$1 n=$2; shift 2; local out rc=0; out=$("$@" 2>&1 < /dev/null) || rc=$?; printf '%s\n' "--- $label (exit $rc):"; printf '%s\n' "$out" | head -"$n"; }
    echo "candidate: $(cat "$dir/candidate-sha")"
    probe 'installed plugins in the disposable configuration (expect none)' 5 in_host "$dir" "$claude_bin" plugin list
    probe 'what is loaded, and from where (expect version 0.6.6 and the SOURCE under this directory)' 12 in_host "$dir" timeout 90 "$claude_bin" -p '/cockpit version' --plugin-dir "$dir/plugin" --settings "$(settingsOf record)"
    probe 'strict validation of the snapshot' 12 in_host "$dir" "$claude_bin" plugin validate --strict "$dir/plugin"
    ;;
  launch)
    need_claude
    dir=$(check_dir "${1:-}"); n=${2:-}; profile=${3:-record}
    [[ $n == 1 || $n == 2 ]] || fail 'launch <dir> 1|2 [record|kinds|quiet|alerts]'
    settings=$(settingsOf "$profile") || fail "not a profile: $profile (record, kinds, quiet or alerts)"
    local_args=(--plugin-dir "$dir/plugin" --settings "$settings")
    printf 'Session %s of the candidate %s in %s/project, profile %s: %s\nExit with /exit or Ctrl+C twice. To continue session 1 after a restart, launch it again with CONTINUE=1.\n' "$n" "$(cat "$dir/candidate-sha")" "$dir" "$profile" "$(optionsOf "$profile")"
    [[ $n == 1 && ${CONTINUE:-0} == 1 ]] && local_args+=(--continue)
    in_host "$dir" "$claude_bin" "${local_args[@]}"
    ;;
  sdk)
    # an immediate command, no model and no sign-in: what a script or an agent-driven process would send, which is not a person
    need_claude
    dir=$(check_dir "${1:-}"); shift || true
    [[ $# -ge 1 ]] || fail 'sdk <dir> <cockpit arguments>'
    printf 'One claude -p run (origin sdk, not a person) of: /cockpit %s\n' "$*"
    in_host "$dir" timeout 90 "$claude_bin" -p "/cockpit $*" --plugin-dir "$dir/plugin" --settings "$(settingsOf record)" < /dev/null
    ;;
  clean)
    dir=$(check_dir "${1:-}")
    rm -rf -- "$dir"
    echo "removed $dir"
    ;;
  *) fail 'usage: acceptance-interactive.sh setup [--dir D] | verify D | launch D 1|2 [record|kinds|quiet|alerts] | sdk D <args> | clean D' ;;
esac
