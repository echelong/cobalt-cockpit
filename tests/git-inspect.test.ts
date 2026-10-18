import { describe, expect, test } from 'claude-code/testing'
import { CLEAN_ENV, GIT_OVERRIDES, GIT_SAFE, HELPER_PINS } from '../hooks/git-integrity'
import type { HelperLaunch } from '../hooks/git-integrity'
import { agentInspection, readOnlyShell, rebuildGit, scopedGit, SCOPED_MAX_COMMITS, SCOPED_MAX_PATHS } from '../hooks/git-inspect'
import type { ScopedGit } from '../hooks/git-inspect'
import { parseShell } from '../hooks/shell'

const argvOf = (command: string): string[] => parseShell(command).pipelines[0]!.commands[0]!.argv
/** v0.6.6: the directory the caller verified; every rebuilt command is pinned to it. */
const DIR = '/work/example'
/** v0.6.6 Stage B: how a rebuilt inspection starts Git: env -i, the clean variables, Git by absolute path. */
const LAUNCH: HelperLaunch = { env: ['PATH=/usr/bin:/bin', 'HOME=/home/tester', 'GIT_NO_LAZY_FETCH=1', 'GIT_ALLOW_PROTOCOL=cockpit-none'], git: '/usr/bin/git' }
const PREFIX = [CLEAN_ENV, '-i', ...LAUNCH.env, LAUNCH.git]
const accepted = (command: string): ScopedGit => {
  const verdict = scopedGit(command)
  if (!verdict.ok) throw new Error(`refused: ${command} (${verdict.reason})`)

  return verdict.git
}
const reasonOf = (command: string): string => {
  const verdict = scopedGit(command)
  if (verdict.ok) throw new Error(`accepted: ${command}`)

  return verdict.reason
}

// Commands every rule accepts: plain inspection, nothing quoted that a shell would read.
const PLAIN = [
  'git status',
  'git diff',
  'git diff --stat',
  'git log --oneline -5',
  'git show HEAD',
  'git show HEAD:hooks/swarm.ts',
  'git ls-files',
  'git rev-parse HEAD',
  'git grep -n routeTask hooks',
  'git diff main...HEAD -- hooks/swarm.ts',
  'git grep -n routeTask -- hooks tests',
  'git log --oneline -- hooks/swarm.ts',
  'git status --short -- hooks',
  'git diff --stat | git log --oneline',
  'git diff && git status',
]
// Commands no rule accepts, quoted or not: something would be written, run, expanded or read from outside Git inspection.
const NEVER = [
  'git diff > out.patch',
  'git diff >> out.patch',
  'git diff 2> /dev/null',
  'git diff < /etc/passwd',
  'git diff $(id)',
  'git diff `id`',
  'git diff "$(id)"',
  'git grep "$HOME"',
  'git grep $HOME',
  'git grep \\$HOME',
  'git diff\ngit push',
  'git diff --output=x',
  'git diff --output x',
  'git diff --out=x',
  'git diff --ext-diff',
  'git diff --ext',
  'git log --textconv',
  'git log --textc',
  'git diff --no-index /etc/passwd /dev/null',
  "git grep '--no-index'",
  'git -C /etc diff',
  'git -c core.pager=sh log',
  'git --git-dir=/x diff',
  'git --exec-path=/x diff',
  'cd /etc && git diff',
  'git diff | head',
  'git diff | tee out',
  'git diff; rm -rf x',
  'git diff & rm -rf x',
  'git diff || curl example.org',
  'env git diff',
  'env -S "git diff" true',
  'sudo git diff',
  'command git diff',
  'exec git diff',
  'nohup git diff',
  'timeout 5 git diff',
  'xargs git diff',
  'GIT_DIR=/x git diff',
  'GIT_EXTERNAL_DIFF=sh git diff',
  '/usr/bin/git diff',
  './git diff',
  'git push',
  'git commit -m x',
  'git checkout -- hooks',
  'git restore -- hooks',
  'git stash',
  'git config -l',
  'git cat-file -p HEAD',
  'git blame hooks/swarm.ts',
  'git difftool',
  'git help diff',
  'git diff --help',
  'git diff -h',
  'git log --format=%H',
  'git log --format',
  'git log --form=x',
  'git log --pretty=oneline',
  'git log --pretty',
  'git log --pre',
  'git log --p',
  'git show --show-signature',
  'git show --show-sig',
  'git log --s',
  'git log --oneline %G?',
  'git log -c',
  'git grep -O pattern',
  'git grep -Oless pattern',
  'git grep --open-files-in-pager pattern',
  'git grep --open-files-in-pager=sh pattern',
  'git grep --open=sh pattern',
  'git log --exec',
  // a word after `--` that begins with a dash: Git reads it as an option when an option before it swallowed the `--`
  'git diff -- --output=x',
  'git diff -- -O',
  'git log --author -- --show-signature',
  'git grep -e -- --open-files-in-pager=sh',
  'git log -- -p',
  'git log -- x%Gy',
  // Git reads options more loosely than they are typed: a bundle of short options, and any unambiguous prefix of a long one
  "git grep -nO'touch /tmp/canary #' -e .",
  'git grep -nOless -e .',
  'git grep -inO -e .',
  'git diff -pO/etc/passwd',
  "git grep --op='touch /tmp/canary #' -e .",
  'git grep --ope=sh -e .',
  'git grep --open-f=sh -e .',
  'git grep --no-ind -e x /etc/passwd',
  'git grep --no-i -e x',
  'git log --ou=/tmp/x',
  'git log --o=/tmp/x',
  'git diff --ex',
  'git diff --te',
  'git log --hel',
  'git log --exe=x',
  // a control character: a carriage return is a blank to the reader and a word character to bash, and a NUL can split a name
  'git log --oneline -1\r# ; touch /tmp/canary',
  'git log\r--output=/tmp/x',
  'git log --o\0utput=/tmp/x',
  'git log\x0b--oneline',
  'git log \x1b[0m',
  'git log\x7f',
  // a program whose name an object inherits is a program like any other
  'toString -x',
  'constructor --x',
  '__proto__ -x',
  'valueOf -x; git diff',
  '',
  '   ',
  'ls',
  'cat /etc/passwd',
  'npm test',
]

describe('the commander\'s rule: read-only Git inspection as typed', () => {
  test('plain inspection is accepted, with or without the `--` separator', () => {
    for (const command of PLAIN) expect([command, readOnlyShell(command)]).toEqual([command, true])
  })
  test('writes, programs, expansion, drivers, formats and wrappers are refused', () => {
    for (const command of NEVER) expect([command, readOnlyShell(command)]).toEqual([command, false])
  })
  test('nothing quoted is taken on trust, because the command runs as typed', () => {
    for (const command of ["git grep '$x'", "git grep 'a > b'", "git grep 'a < b'", "git grep '`x`'"]) expect([command, readOnlyShell(command)]).toEqual([command, false])
  })
  test('what only bash would expand is refused, because the command runs as typed', () => {
    // brace expansion writes the option the refusal list never saw; a pattern in an option could expand to one
    for (const command of ['git log --{output=/tmp/canary,}', 'git diff --o{utput=/tmp/canary,}', 'git log -{p,O/etc/passwd}', 'git log --since={1..2}', 'git log --outpu* x', 'git log --grep=fix*', 'git log -[pO]', "git grep 'a{2,3}' hooks"]) expect([command, readOnlyShell(command)]).toEqual([command, false])
    // a pattern that begins a word matches a file whose name begins with a dash as readily as any other
    for (const command of ['git diff *', 'git diff -- *', 'git log -- *.ts', 'git grep x ?', 'git diff [a-z]*', "git log -- '*.md'"]) expect([command, readOnlyShell(command)]).toEqual([command, false])
    // bash decides on the text, before quotes and backslashes are removed: a quoted or escaped brace still leaves a group
    for (const command of [
      'git log --{output=/tmp/canary\\},}', 'git log --{output=/tmp/canary,\\{}', "git log --{output=/tmp/canary,'{'}", 'git log --{output=/tmp/canary,"}"}', "git log --'{'output=/tmp/canary,}", 'git log --\\{output=/tmp/canary,}',
      'git log --{output=/tmp/canary,HEAD@{1}}', 'git log HEAD@{1..2}', 'git log HEAD@{a,b}', 'git diff {a..c}', 'git log }{', "git grep '{' hooks", 'git log --grep={',
      // and anything left over once a revision's own braces are set aside
      'git log HEAD@{1.}', 'git log HEAD@{1}}', 'git log HEAD@{1}{2}', "git log @'{'a,b'}'", 'git log @{a@{b}}', 'git log {@{1}', 'git log HEAD@{1..2..3}', 'git log --out@{1}',
    ]) expect([command, readOnlyShell(command)]).toEqual([command, false])
    // a revision's own braces hold nothing bash expands
    for (const command of ['git diff HEAD@{1}', 'git log stash@{0}', 'git show HEAD^{tree}', 'git log HEAD@{1}..HEAD', 'git log HEAD@{2.days.ago}', 'git log "HEAD@{2 days ago}"', 'git diff @{u}', 'git log HEAD^{/fix}', 'git diff @{-1} HEAD^{}', 'git log HEAD@{1.2}', 'git log HEAD@{.1}', 'git log -- hooks/*.ts']) expect([command, readOnlyShell(command)]).toEqual([command, true])
  })
  test('a harmless value that looks like a refused option is refused too: the rule follows how Git reads, not what was meant', () => {
    for (const command of ['git log -SOWNER', 'git grep -eTODO hooks', 'git grep --extended-regexp x', 'git log --output-indicator-new=x']) expect([command, readOnlyShell(command), agentInspection(command)]).toEqual([command, false, false])
    // and what it leaves alone
    for (const command of ['git log -Sneedle', 'git grep -e todo hooks', 'git grep -E x', 'git log --oneline --no-color --name-only --first-parent --follow hooks/a.ts', 'git ls-files -o --exclude-standard', 'git grep --heading --only-matching x', 'git diff --no-ext-diff --no-textconv --patience']) expect([command, readOnlyShell(command), agentInspection(command)]).toEqual([command, true, true])
  })
})

describe('a wildcard subagent\'s rule: the same, with single-quoted text as data', () => {
  test('everything the commander\'s rule accepts is accepted, and everything it must refuse is refused', () => {
    for (const command of PLAIN) expect([command, agentInspection(command)]).toEqual([command, true])
    for (const command of NEVER) expect([command, agentInspection(command)]).toEqual([command, false])
  })
  test('a single-quoted pattern may hold `$`, `<`, `>` and a backtick', () => {
    for (const command of ["git grep -n '\\$\\.process' -- hooks", "git grep '=>' -- hooks", "git grep 'a < b' hooks", "git grep '`x`' -- docs", "git grep '$(id)' -- hooks"]) expect([command, agentInspection(command)]).toEqual([command, true])
  })
  test('a word bash would have expanded is only text once the command is rebuilt', () => {
    // the escaped and quoted forms as well: each is one literal word to Git, which knows no such option
    for (const [typed, word] of [['git log --{output=/tmp/canary\\},}', '--{output=/tmp/canary},}'], ['git log --{output=/tmp/canary,\\{}', '--{output=/tmp/canary,{}'], ["git log --{output=/tmp/canary,'{'}", '--{output=/tmp/canary,{}']] as const) {
      expect([typed, agentInspection(typed)]).toEqual([typed, true])
      expect(argvOf(rebuildGit(typed, DIR, LAUNCH)).at(-1)).toBe(word)
      expect(parseShell(rebuildGit(typed, DIR, LAUNCH)).pipelines).toHaveLength(1)
    }
    const command = 'git log --{output=/tmp/canary,}'
    expect(agentInspection(command)).toBe(true)
    // Git is handed the braces themselves, as one word, and refuses the option it does not know
    expect(argvOf(rebuildGit(command, DIR, LAUNCH)).at(-1)).toBe('--{output=/tmp/canary,}')
    expect(rebuildGit(command, DIR, LAUNCH).endsWith("'--{output=/tmp/canary,}'")).toBe(true)
  })
  test('the same characters outside single quotes are still refused', () => {
    for (const command of [
      'git grep "$(id)" -- hooks',
      "git grep 'a' $(id)",
      "git grep 'a' > out",
      "git grep 'a' `id`",
      "git grep 'unterminated",
      "git grep \\' $(id) '",
      "git grep 'a'\n'b'",
      "git grep \"it's $HOME\"",
      "git grep 'x' '--output=y'",
    ]) expect([command, agentInspection(command)]).toEqual([command, false])
  })
})

describe('what runs is rebuilt, never the typed text', () => {
  test('every word is single-quoted behind --no-pager and the safe flags; diff, show and log lose their drivers', () => {
    // v0.6.6: the helper pins, the verified directory (wildcard commands too) and no submodule comparison
    const argv = argvOf(rebuildGit('git diff main...HEAD -- hooks/swarm.ts', DIR, LAUNCH))
    expect(argv).toEqual([...PREFIX, '--no-pager', ...GIT_SAFE, ...GIT_OVERRIDES, ...HELPER_PINS, '-C', DIR, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'main...HEAD', '--', 'hooks/swarm.ts'])
    expect(argvOf(rebuildGit('git grep -n x', DIR, LAUNCH))).toEqual([...PREFIX, '--no-pager', ...GIT_SAFE, ...GIT_OVERRIDES, ...HELPER_PINS, '-C', DIR, 'grep', '-n', 'x'])
    expect(rebuildGit('git status', DIR, LAUNCH)).toMatch(/^'\/usr\/bin\/env' '-i' 'PATH=\/usr\/bin:\/bin' /)            // v0.6.6 Stage B: the clean launch, Git by absolute path
  })
  test('a substitution inside single quotes stays text after the rebuild', () => {
    const rebuilt = rebuildGit("git grep '$(touch /tmp/pwned)' -- hooks", DIR, LAUNCH)
    const parsed = parseShell(rebuilt)
    expect(parsed.substitutions).toEqual([])
    expect(parsed.pipelines).toHaveLength(1)
    expect(parsed.pipelines[0]!.commands[0]!.argv.slice(-3)).toEqual(['$(touch /tmp/pwned)', '--', 'hooks'])
    expect(parsed.pipelines[0]!.commands[0]!.writes).toEqual([])
  })
  test('a quote inside a word cannot close the quoting', () => {
    const rebuilt = rebuildGit('git grep "it\'s; rm -rf x" -- docs', DIR, LAUNCH)
    const parsed = parseShell(rebuilt)
    expect(parsed.pipelines).toHaveLength(1)
    expect(parsed.pipelines[0]!.commands).toHaveLength(1)
    expect(parsed.pipelines[0]!.commands[0]!.argv.slice(-3)).toEqual(["it's; rm -rf x", '--', 'docs'])
  })
  test('a pipeline of inspections is rebuilt command by command', () => {
    const parsed = parseShell(rebuildGit('git diff --stat | git log --oneline', DIR, LAUNCH))
    expect(parsed.pipelines[0]!.commands.map(c => c.argv.includes('--no-pager'))).toEqual([true, true])
  })
  test('a scoped command is pinned to the verified directory and reads only the canonical paths it was checked for', () => {
    const git = accepted('git diff --stat main...HEAD -- hooks/swarm.ts ./tests')
    const argv = argvOf(rebuildGit('ignored: the pin is what runs', DIR, LAUNCH, { git, dir: '/work/example', paths: ['/work/example/hooks/swarm.ts', '/work/example/tests'] }))
    expect(argv).toEqual([...PREFIX, '--no-pager', ...GIT_SAFE, ...GIT_OVERRIDES, ...HELPER_PINS, '-C', '/work/example', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--stat', 'main...HEAD', '--', '/work/example/hooks/swarm.ts', '/work/example/tests'])
  })
  test('a file at a revision keeps its object name and still ends the options', () => {
    const git = accepted('git show HEAD~2:hooks/swarm.ts')
    expect(argvOf(rebuildGit('', DIR, LAUNCH, { git, dir: '/work/example', paths: [] })).slice(-6)).toEqual(['show', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD~2:hooks/swarm.ts', '--'])
  })
})

describe('the scoped rule: what a narrow scope may ask of Git', () => {
  test('diff, show, log, status, grep and ls-files with explicit paths', () => {
    expect(accepted('git diff main...HEAD -- hooks/swarm.ts')).toEqual({ sub: 'diff', words: ['main...HEAD'], commits: ['main', 'HEAD'], objects: [], paths: ['hooks/swarm.ts'] })
    expect(accepted('git diff --stat -U5 abc1234 def5678 -- hooks tests/swarm.test.ts').commits).toEqual(['abc1234', 'def5678'])
    expect(accepted('git diff --cached -- hooks').commits).toEqual([])
    expect(accepted('git log --oneline -n 20 --since=2026-10-01 main..HEAD -- hooks/')).toEqual({ sub: 'log', words: ['--oneline', '-n', '20', '--since=2026-10-01', 'main..HEAD'], commits: ['main', 'HEAD'], objects: [], paths: ['hooks/'] })
    expect(accepted('git log -5 -p --author=someone -Sneedle -- hooks/swarm.ts').words).toEqual(['-5', '-p', '--author=someone', '-Sneedle'])
    expect(accepted('git log origin/main.. -- hooks').commits).toEqual(['origin/main'])
    expect(accepted('git show --stat HEAD~2 -- hooks/swarm.ts').commits).toEqual(['HEAD~2'])
    expect(accepted('git show v0.6.0^ -- hooks').commits).toEqual(['v0.6.0^'])
    expect(accepted('git status --short -- hooks').sub).toBe('status')
    expect(accepted('git status -sb -- hooks').words).toEqual(['-sb'])
    expect(accepted('git ls-files -- hooks').sub).toBe('ls-files')
    expect(accepted('git ls-files -o --exclude-standard -- hooks tests').paths).toEqual(['hooks', 'tests'])
  })
  test('a file at a revision names its own path and needs no `--`', () => {
    expect(accepted('git show HEAD:hooks/swarm.ts')).toEqual({ sub: 'show', words: ['HEAD:hooks/swarm.ts'], commits: ['HEAD'], objects: [{ rev: 'HEAD', path: 'hooks/swarm.ts' }], paths: [] })
    expect(accepted('git show refs/heads/main:docs/a.md abc123:docs/b.md').objects).toEqual([{ rev: 'refs/heads/main', path: 'docs/a.md' }, { rev: 'abc123', path: 'docs/b.md' }])
    // a commit beside it is shown as a diff, so the paths are needed again
    expect(reasonOf('git show HEAD HEAD:hooks/swarm.ts')).toContain('name what to read')
  })
  test('git grep: the first word is the pattern unless -e names it, and the rest are revisions', () => {
    expect(accepted("git grep -n 'routeTask' -- hooks tests")).toEqual({ sub: 'grep', words: ['-n', 'routeTask'], commits: [], objects: [], paths: ['hooks', 'tests'] })
    expect(accepted("git grep -niE 'a|b' main -- hooks").commits).toEqual(['main'])
    expect(accepted('git grep -e foo -e bar HEAD~1 -- hooks')).toEqual({ sub: 'grep', words: ['-e', 'foo', '-e', 'bar', 'HEAD~1'], commits: ['HEAD~1'], objects: [], paths: ['hooks'] })
    expect(accepted("git grep -n '\\$\\.process\\.run' -- hooks").words).toEqual(['-n', '\\$\\.process\\.run'])
    // a pattern may look like anything: it is the pattern, never a revision
    expect(accepted("git grep 'HEAD:secret' -- hooks").commits).toEqual([])
    expect(accepted('git grep -A 2 -B2 -C 3 -m 5 x -- hooks').words).toEqual(['-A', '2', '-B2', '-C', '3', '-m', '5', 'x'])
  })
  test('what the scoped rule accepts in everyday use, the wildcard rule accepts too', () => {
    for (const command of [
      'git diff main...HEAD -- hooks/swarm.ts', 'git diff --stat -U5 abc1234 def5678 -- hooks', 'git log --oneline -n 20 main..HEAD -- hooks/', 'git log -5 -p -Sneedle -- hooks/swarm.ts',
      'git show --stat HEAD~2 -- hooks/swarm.ts', 'git show HEAD:hooks/swarm.ts', 'git status -sb -- hooks', "git grep -niE 'a|b' main -- hooks", 'git grep -e foo -e bar HEAD~1 -- hooks', 'git ls-files -o --exclude-standard -- hooks',
    ]) {
      expect([command, scopedGit(command).ok]).toEqual([command, true])
      expect([command, agentInspection(command)]).toEqual([command, true])
    }
  })

  test('a command without its paths is refused, and told the form', () => {
    for (const command of ['git diff', 'git diff main', 'git diff main...HEAD', 'git status', 'git log', 'git log --oneline -5', 'git show', 'git show HEAD', 'git grep foo', 'git ls-files', 'git diff --']) {
      const reason = reasonOf(command)
      expect([command, reason.includes('name what to read')]).toEqual([command, true])
      expect(reason).toContain('-- <path inside your scope>')
    }
    // a path typed before `--` is read as a revision, so the paths are still missing
    expect(reasonOf('git diff main hooks/swarm.ts')).toContain('name what to read')
    expect(reasonOf('git grep')).toContain('needs a pattern')
    expect(reasonOf('git grep -- hooks')).toContain('needs a pattern')
  })
  test('pipes, chains, redirects, substitutions and second lines are refused', () => {
    for (const command of [
      'git diff -- hooks | head', 'git diff -- hooks | git log -- hooks', 'git diff -- hooks && git push', 'git diff -- hooks; rm -rf x', 'git diff -- hooks & rm x', 'git diff -- hooks || true',
      'git diff -- hooks > /tmp/x', 'git diff -- hooks >> /tmp/x', 'git diff -- hooks 2>&1', 'git diff -- hooks < /etc/passwd', 'git diff -- "$HOME"', 'git diff -- $(pwd)', 'git diff -- `pwd`', 'git diff -- hooks\ngit push', 'git diff -- hooks <<EOF\nx\nEOF',
      'git log --since=$(id) -- hooks', "git grep 'a' -- hooks > out",
    ]) expect([command, scopedGit(command).ok]).toEqual([command, false])
  })
  test('wrappers, assignments, another path to git and global options are refused', () => {
    for (const command of [
      'env git diff -- hooks', 'sudo git diff -- hooks', 'GIT_DIR=/x git diff -- hooks', 'GIT_WORK_TREE=/ git diff -- hooks', 'command git diff -- hooks', 'xargs git diff -- hooks', 'timeout 5 git diff -- hooks', '/usr/bin/git diff -- hooks',
      'exec git diff -- hooks', 'nohup git diff -- hooks', 'time git diff -- hooks', '! git diff -- hooks', 'git -C /etc diff -- hooks', 'git -c core.pager=sh diff -- hooks', 'git --git-dir=/x diff -- hooks', 'git --work-tree=/ diff -- hooks',
      'git --exec-path=/x diff -- hooks', 'git --no-pager diff -- hooks', 'git --literal-pathspecs diff -- hooks',
    ]) expect([command, scopedGit(command).ok]).toEqual([command, false])
  })
  test('only six subcommands exist under a narrow scope', () => {
    for (const command of [
      'git push -- hooks', 'git commit -- hooks', 'git checkout -- hooks', 'git restore -- hooks', 'git stash -- hooks', 'git add -- hooks', 'git rm -- hooks', 'git clean -n -- hooks', 'git rev-parse HEAD -- hooks', 'git cat-file -p HEAD:secret',
      'git ls-tree HEAD -- hooks', 'git blame -- hooks/x', 'git config --get user.email', 'git archive HEAD -- hooks', 'git bundle create x HEAD', 'git worktree list', 'git apply x', 'git reflog -- hooks', 'git difftool -- hooks',
      'git submodule foreach id', 'git for-each-ref', 'git fetch', 'git diff-tree HEAD -- hooks', 'git diff-files -- hooks', 'git whatchanged -- hooks', 'git range-diff a b -- hooks', 'git format-patch -1 -- hooks', 'git shortlog -- hooks',
      'git name-rev HEAD', 'git describe', 'git help -- hooks', 'git', 'git --', 'git DIFF -- hooks',
    ]) expect([command, scopedGit(command).ok]).toEqual([command, false])
    expect(reasonOf('git blame -- hooks/x')).toContain('not available under a narrow scope')
  })
  test('an option outside the subcommand\'s list is refused, whatever it would do', () => {
    const refused: Record<string, string[]> = {
      diff: ['--no-index', '--output=x', '-O/etc/passwd', '-Oorder', '--ext-diff', '--textconv', '-C', '-C90', '--find-copies-harder', '--find-copies', '-B', '--relative=../x', '--src-prefix=x', '--line-prefix=x', '--submodule=diff',
        '--exit-code', '--pickaxe-all', '-G.', '-S', '--word-diff-regex=.', '--anchored=x', '--function-context', '-W', '-R', '--binary', '--text', '-a', '--color-moved', '--no-prefix', '-l999', '--raw', '-z', '--patch-with-raw', '--dirstat',
        '--help', '-h', '--sta', '--cach', '--unif=3', '--name-onl', '--follow', '--full-diff', '--all', '-n', '-5', '--oneline', '-L1,5:secret.txt', '-U', '-Ux', '--unified', '--stat=x', '--color=sometimes', '--abbrev=999'],
      log: ['--format=%H', '--pretty=fuller', '--pretty', '--show-signature', '-L1,5:secret.txt', '-L:fn:secret.txt', '--follow', '--full-diff', '--source', '--walk-reflogs', '-g', '--reflog', '--stdin', '--no-walk', '--ignore-missing', '--bisect',
        '--glob=refs/*', '--branches', '--tags', '--remotes', '--exclude=x', '--notes=x', '--show-notes', '--raw', '--cc', '-c', '-m', '--diff-merges=on', '--remerge-diff', '--output=x', '--not', '--max-count=abc', '--max-count', '--date=format:%s',
        '--since', '--textconv', '--ext-diff', '-O', '-C', '--find-copies-harder', '--no-index', '-z', '--help'],
      show: ['--format=%B', '--pretty=raw', '--textconv', '--ext-diff', '--show-signature', '--raw', '-L1,5:x', '--follow', '--output=x', '-O', '-C', '--find-copies-harder', '--no-index', '--notes', '-n', '-5', '--all'],
      status: ['--porcelain=v3', '--ignored', '--column', '-z', '--show-stash', '--untracked-files=../x', '--ahead-behind', '-v', '--verbose', '--find-renames', '--ignore-submodules=all', '--output=x', '-u'],
      grep: ['-O', '-Oless', '--open-files-in-pager', '--open-files-in-pager=sh', '-f', '--no-index', '--textconv', '--recurse-submodules', '--threads=4', '-P', '--perl-regexp', '-h', '--help', '-c', '-z', '--null', '--exclude-standard',
        '--no-exclude-standard', '-W', '--function-context', '-p', '--show-function', '--max-depth=x', '-q', '--ext-grep', '--color=always', '-L', '-nO'],
      'ls-files': ['--with-tree=HEAD', '-x', '--exclude-from=/etc/passwd', '-X', '--exclude-per-directory=x', '-i', '--ignored', '--error-unmatch', '-z', '--format=%(path)', '--eol', '--recurse-submodules', '--resolve-undo', '-c', '-t', '-v',
        '-k', '--killed', '--directory', '--debug', '--sparse', '--abbrev'],
    }
    for (const [sub, options] of Object.entries(refused)) for (const option of options) {
      const command = sub === 'grep' ? `git grep ${option} pattern -- hooks` : `git ${sub} ${option} -- hooks`
      expect([command, scopedGit(command).ok]).toEqual([command, false])
    }
    expect(reasonOf('git log --full-diff -- hooks')).toContain('not on the list of options')
    expect(reasonOf('git log --full-diff -- hooks')).toContain('wildcard read scope')
  })
  test('bundles and abbreviations that Git would read as a refused option are not on any list', () => {
    for (const command of [
      "git grep -nO'touch /tmp/canary #' -e . -- hooks", 'git grep -inO -e . -- hooks', "git grep --op='touch /tmp/canary #' -e . -- hooks", 'git grep --no-ind -e x -- hooks', 'git diff -pO/etc/passwd -- hooks', 'git log -pL1,2:README.md -- hooks',
      'git log --ou=/tmp/x -- hooks', 'git log --form=%H -- hooks', 'git log -nS -- hooks', 'git log -pn 5 -- hooks', 'git grep -ne . -- hooks', 'git status -sz -- hooks',
    ]) expect([command, scopedGit(command).ok]).toEqual([command, false])
    // a bundle of flags that are each on the list is the flags themselves
    for (const command of ['git grep -niwF x -- hooks', 'git status -sb -- hooks', 'git diff -pw -- hooks', 'git log -ps -- hooks']) expect([command, scopedGit(command).ok]).toEqual([command, true])
  })
  test('control characters and inherited program names are refused without an error', () => {
    for (const command of ['git diff -- hooks\r# ; touch /tmp/canary', 'git log --o\0neline -- hooks', 'git diff -- hooks\x0b', 'toString -x', 'constructor --x', '__proto__ -x', 'valueOf -x', 'hasOwnProperty -x -- hooks']) {
      expect([command, scopedGit(command).ok]).toEqual([command, false])
    }
  })
  test('an option that takes a value takes a plain one, and never the `--`', () => {
    for (const command of ['git log -n -- hooks', 'git log -n -5 -- hooks', 'git log -n abc -- hooks', 'git log -n 99999 -- hooks', 'git grep -e -- hooks', 'git grep -e -x -- hooks', 'git grep -e', 'git grep -A x pat -- hooks', 'git grep -C -- hooks', 'git grep -m -- hooks']) {
      expect([command, scopedGit(command).ok]).toEqual([command, false])
    }
    expect(reasonOf('git grep -e -- hooks')).toContain('does not begin with a dash')
  })
  test('a revision is a plain name: nothing that addresses a tree, a file, the index or the reflog', () => {
    for (const command of [
      'git diff HEAD:secret HEAD:other -- hooks', 'git diff HEAD^{tree} -- hooks', 'git log HEAD^{tree} -- hooks', 'git log HEAD^{/fix} -- hooks', 'git diff a..b..c -- hooks', 'git diff ... -- hooks', 'git diff .. -- hooks', 'git log ^a..b -- hooks',
      'git diff "a b" -- hooks', 'git diff @{upstream} -- hooks', 'git diff HEAD@{yesterday} -- hooks', 'git diff main^! -- hooks', 'git diff stash@{0} -- hooks', 'git log :/fix -- hooks', 'git diff :0:secret -- hooks', 'git diff ./hooks -- hooks',
      'git diff ../x -- hooks', 'git diff /etc/passwd -- hooks', 'git diff "" -- hooks', 'git diff a....b -- hooks', 'git diff a...b...c -- hooks', 'git grep foo HEAD:secret -- hooks', 'git grep foo HEAD^{tree} -- hooks',
      'git grep -e foo HEAD:secret -- hooks', 'git grep HEAD:secret -e foo -- hooks', 'git status HEAD -- hooks', 'git ls-files HEAD -- hooks', 'git ls-files hooks',
    ]) expect([command, scopedGit(command).ok]).toEqual([command, false])
    expect(reasonOf('git diff HEAD^{tree} -- hooks')).toContain('not a plain revision')
    expect(reasonOf('git status HEAD -- hooks')).toContain('takes no revision')
  })
  test('a file at a revision is <plain revision>:<path from the root>, for git show only', () => {
    for (const command of [
      'git show HEAD^{tree}', 'git show HEAD:', 'git show HEAD:../x', 'git show HEAD:hooks/../secret', 'git show HEAD:/etc/passwd', 'git show HEAD:./x', 'git show HEAD:hooks//x', 'git show :0:secret', 'git show :secret', 'git show HEAD:a:b',
      'git show HEAD~1..HEAD:x', 'git show ^HEAD:x', 'git show @{u}:x', 'git show HEAD@{1}:x', 'git show :/fix', 'git show HEAD:hooks/*.ts', 'git show HEAD:~/x', 'git show HEAD:-x', 'git show "HEAD:a\\\\b"',
    ]) expect([command, scopedGit(command).ok]).toEqual([command, false])
    expect(reasonOf('git show HEAD:../x')).toContain('<revision>:<path>')
  })
  test('a path is literal: no wildcard, magic, home or option look-alike', () => {
    for (const path of ['*', 'hooks/*.ts', ':(glob)**', ':!hooks', ':/', ':(top)x', ':(exclude)hooks', '~/x', '~', '-x', '--output=x', '--', "''", 'hooks/[a]', '{a,b}', 'hooks/?', '-']) {
      const command = `git diff -- ${path}`
      expect([command, scopedGit(command).ok]).toEqual([command, false])
    }
    expect(reasonOf('git diff -- :!hooks')).toContain('not a literal path')
    // one command names a bounded number of paths and revisions
    expect(scopedGit(`git diff -- ${Array.from({ length: SCOPED_MAX_PATHS }, (_, n) => `f${n}`).join(' ')}`).ok).toBe(true)
    expect(scopedGit(`git diff -- ${Array.from({ length: SCOPED_MAX_PATHS + 1 }, (_, n) => `f${n}`).join(' ')}`).ok).toBe(false)
    expect(scopedGit(`git log ${Array.from({ length: SCOPED_MAX_COMMITS }, (_, n) => `r${n}`).join(' ')} -- hooks`).ok).toBe(true)
    expect(scopedGit(`git log ${Array.from({ length: SCOPED_MAX_COMMITS + 1 }, (_, n) => `r${n}`).join(' ')} -- hooks`).ok).toBe(false)
  })
  test('the shape alone grants nothing: a literal path outside the scope still passes here and is the caller\'s to refuse', () => {
    expect(accepted('git diff -- /etc/passwd ../other hooks/../secret').paths).toEqual(['/etc/passwd', '../other', 'hooks/../secret'])
    expect(accepted('git show HEAD:secret.txt').objects).toEqual([{ rev: 'HEAD', path: 'secret.txt' }])
  })
  test('a command that is not git at all says so, so the caller can name the general rule', () => {
    for (const command of ['ls', 'cat /etc/passwd', 'npm test', '', 'gitk', 'github']) {
      const verdict = scopedGit(command)
      expect([command, verdict.ok, verdict.ok ? null : verdict.isGit]).toEqual([command, false, false])
    }
    const verdict = scopedGit('git push')
    expect(verdict.ok ? null : verdict.isGit).toBe(true)
  })
})
