import { describe, expect, test } from 'claude-code/testing'
import { GIT_OVERRIDES, GIT_SAFE, HELPER_PINS } from '../hooks/git-integrity'
import { parseShell } from '../hooks/shell'
import { start, world } from './world'

// A narrowly scoped helper's Git inspection, through the real tool hook: what reaches the host, and what never does.

type Engine = Parameters<typeof start>[0]
const SWARM = 'mcp__cobalt-cockpit__swarm'
const options = { options: { orchestration: true, maxSubagents: 32, maxSonnetAgents: 16, maxHaikuAgents: 24 } }
const ROOT = '/work/example'
const SCOPE = [`${ROOT}/hooks/swarm.ts`, `${ROOT}/tests`]
const assign = ($: Engine, id: string, owned: string[], mode: 'read' | 'write' = 'read', extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: SWARM, action: 'assign', task_id: id, tier: 'SONNET', role: 'REVIEW', objective: `Review ${id}`, scope: `Scope ${id}`, owned_resources: owned, mode, spawn_reason: 'Independent bounded review', ...extra } as never)
const spawn = ($: Engine, id: string, subagentType = 'cobalt-cockpit:reviewer') =>
  $.agent.spawn({ prompt: `Review ${id}`, description: `[task:${id}] bounded review`, subagentType, tool_use_id: `spawn-${id}`, parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
const git = async ($: Engine, agentId: string | undefined, command: string) => (await $.tool.call({ tool: 'Bash', agentId, command } as never)) as { deny?: string }
const reviewer = async ($: Engine, owned: string[] = SCOPE, mode: 'read' | 'write' = 'read') => {
  await start($)
  await assign($, 'rev', owned, mode)

  return (await spawn($, 'rev', mode === 'write' ? 'cobalt-cockpit:worker' : 'cobalt-cockpit:reviewer')).agentId!
}
const sentOf = (w: ReturnType<typeof world>): string[][] => w.ran.filter(call => call['tool'] === 'Bash').map(call => parseShell(String(call['command'])).pipelines[0]!.commands[0]!.argv)
// v0.6.6: the helper pins come before the directory; diff, log, show and status also ignore submodules
const HEAD = ['git', '--no-pager', ...GIT_SAFE, ...GIT_OVERRIDES, ...HELPER_PINS, '-C', ROOT]
const NO_SUB = '--ignore-submodules=all'

describe('a scoped reviewer inspects Git inside its scope', () => {
  test('diff, log, show, status, grep and ls-files reach the host pinned, hardened and with canonical paths', options, async ($, on) => {
    const w = world(on); const a = await reviewer($)
    expect((await git($, a, 'git diff --stat main...HEAD -- hooks/swarm.ts')).deny).toBeUndefined()
    expect((await git($, a, 'git log --oneline -5 -- hooks/swarm.ts tests/swarm.test.ts')).deny).toBeUndefined()
    expect((await git($, a, 'git show HEAD~1 -- ./tests')).deny).toBeUndefined()
    expect((await git($, a, 'git show HEAD:hooks/swarm.ts')).deny).toBeUndefined()
    expect((await git($, a, 'git status --short -- tests')).deny).toBeUndefined()
    expect((await git($, a, "git grep -n '\\$\\.process' -- tests")).deny).toBeUndefined()
    expect((await git($, a, `git ls-files -- ${ROOT}/tests`)).deny).toBeUndefined()
    expect(sentOf(w)).toEqual([
      [...HEAD, 'diff', '--no-ext-diff', '--no-textconv', NO_SUB, '--stat', 'main...HEAD', '--', `${ROOT}/hooks/swarm.ts`],
      [...HEAD, 'log', '--no-ext-diff', '--no-textconv', NO_SUB, '--oneline', '-5', '--', `${ROOT}/hooks/swarm.ts`, `${ROOT}/tests/swarm.test.ts`],
      [...HEAD, 'show', '--no-ext-diff', '--no-textconv', NO_SUB, 'HEAD~1', '--', `${ROOT}/tests`],
      [...HEAD, 'show', '--no-ext-diff', '--no-textconv', NO_SUB, 'HEAD:hooks/swarm.ts', '--'],
      [...HEAD, 'status', NO_SUB, '--short', '--', `${ROOT}/tests`],
      [...HEAD, 'grep', '-n', '\\$\\.process', '--', `${ROOT}/tests`],
      [...HEAD, 'ls-files', '--', `${ROOT}/tests`],
    ])
    // nothing but the rebuilt command was sent: no word of it is outside single quotes
    for (const call of w.ran.filter(c => c['tool'] === 'Bash')) expect(String(call['command'])).toMatch(/^'git'(?: '(?:[^']|'\\'')*')+$/)
  })
  test('every revision is proved to be a commit before the command runs', options, async ($, on) => {
    const w = world(on); const a = await reviewer($)
    await git($, a, 'git diff main...HEAD -- hooks/swarm.ts')
    const proofs = w.runs.filter(argv => argv[0] === 'git' && argv.includes('--verify')).map(argv => argv.at(-1))
    expect(proofs).toContain('main^{commit}')
    expect(proofs).toContain('HEAD^{commit}')
    w.nonCommits.push('deadbeef')
    const refused = await git($, a, 'git diff deadbeef -- hooks/swarm.ts')
    expect(refused.deny).toContain('does not name a commit')
    expect((await git($, a, 'git show deadbeef:hooks/swarm.ts')).deny).toContain('does not name a commit')
    expect(sentOf(w)).toHaveLength(1)
  })
  test('a scoped writer may inspect what it owns, and nothing else changes for its shell', options, async ($, on) => {
    const w = world(on); const a = await reviewer($, [`${ROOT}/hooks/swarm.ts`], 'write')
    expect((await git($, a, 'git diff -- hooks/swarm.ts')).deny).toBeUndefined()
    expect((await git($, a, 'git diff -- hooks/alerts.ts')).deny).toContain('outside owned')
    expect((await git($, a, 'npm test')).deny).toContain('wildcard')
    expect((await git($, a, 'git commit -am x')).deny).toContain('not available under a narrow scope')
    expect(sentOf(w)).toHaveLength(1)
  })
})

describe('what a scoped inspection costs the host', () => {
  test('one realpath per path, one rev-parse per revision and one tree listing per distinct commit more than a wildcard inspection, and nothing for a refusal of shape', options, async ($, on) => {
    const w = world(on); await start($)
    await assign($, 'wide', ['*']); await assign($, 'narrow', SCOPE)
    const wide = (await spawn($, 'wide')).agentId!; const narrow = (await spawn($, 'narrow')).agentId!
    const cost = async (agentId: string, command: string): Promise<string[]> => {
      const before = w.runs.length
      await git($, agentId, command)

      // a revision proof (a peel) reads `--verify`; v0.6.6's check of whether HEAD is a commit reads `HEAD`
      return w.runs.slice(before).map(argv => argv[0] === 'git' ? `git ${argv.find(a => ['rev-parse', 'config', 'check-attr', 'ls-files', 'ls-tree'].includes(a))}${argv.some(a => a.endsWith('^{commit}')) ? ' --verify' : argv.includes('--verify') ? ' HEAD' : ''}` : String(argv[0]))
    }
    const wildcard = await cost(wide, 'git diff main...HEAD -- hooks/swarm.ts')
    const scoped = await cost(narrow, 'git diff main...HEAD -- hooks/swarm.ts')
    // repository identity (two git, two realpath), Git's excludes and attributes files checked before Git reads them (v0.6.4: one
    // rev-parse, two config and one stat, which also answers for the absent attributes and alternates files) and the filter check
    // are what a wildcard inspection already paid
    const inputs = ['git rev-parse', 'git config', 'git config', 'stat']
    // v0.6.6: then whether HEAD is a commit, and the repository-state check (configuration, which also answers the filter check,
    // where the packs are, the promisor pack listing, the index's stage entries and HEAD's tree), which both kinds pay before
    // anything is read; a scoped one checks it first, then its paths and revisions, and lists the tree of each distinct commit
    // they name (here both names are one commit)
    const state = ['git rev-parse HEAD', 'git config', 'git rev-parse', 'find', 'git ls-files', 'git ls-tree']
    expect(wildcard).toEqual(['git rev-parse', 'git rev-parse', 'realpath', 'realpath', ...inputs, ...state])
    expect(scoped).toEqual(['git rev-parse', 'git rev-parse', 'realpath', 'realpath', ...inputs, ...state, 'realpath', 'git rev-parse --verify', 'git rev-parse --verify', 'git ls-tree'])
    // a command refused for its shape, or for a path outside the scope, runs no revision proof at all
    expect(await cost(narrow, 'git log --full-diff -- hooks/swarm.ts')).toEqual([])
    expect((await cost(narrow, 'git diff main...HEAD -- README.md')).filter(run => run.includes('--verify'))).toEqual([])
    expect(await cost(narrow, 'cat README.md')).toEqual([])
  })
})

describe('a read-only Git command does not widen a scope', () => {
  test('paths outside the owned resources are refused, however they are spelled', options, async ($, on) => {
    const w = world(on); const a = await reviewer($)
    for (const command of [
      'git diff -- hooks/alerts.ts',
      'git diff -- hooks',
      'git diff -- .',
      'git diff -- hooks/../secret.ts',
      'git diff -- tests/../hooks/alerts.ts',
      'git diff -- /etc/passwd',
      'git diff -- ../other/x',
      `git diff -- ${ROOT}`,
      'git diff -- /',
      'git diff main...HEAD -- hooks/swarm.ts hooks/alerts.ts',
      'git log -p -- hooks/swarm.ts README.md',
      'git show HEAD -- SECURITY.md',
      'git status -- .',
      'git grep -n password -- .',
      `git grep -n password -- ${ROOT}/hooks`,
      'git ls-files -- /',
      'git ls-files -o -- ..',
    ]) {
      const out = await git($, a, command)
      expect([command, out.deny?.includes('read outside owned resources')]).toEqual([command, true])
      expect(out.deny).toContain('does not widen a scope')
    }
    expect(sentOf(w)).toEqual([])
  })
  test('a file at a revision must be an owned path', options, async ($, on) => {
    const w = world(on); const a = await reviewer($)
    for (const command of ['git show HEAD:hooks/alerts.ts', 'git show HEAD:secret.txt', 'git show HEAD:hooks', 'git show HEAD:tests/x.ts HEAD:README.md']) {
      expect([command, (await git($, a, command)).deny?.includes('read outside owned resources')]).toEqual([command, true])
    }
    expect((await git($, a, 'git show HEAD:tests/x.ts')).deny).toBeUndefined()
    expect(sentOf(w)).toHaveLength(1)
  })
  test('a directory that became a link into the scope does not open what it used to hold', options, async ($, on) => {
    // `private` was a directory at an earlier commit and is now a link to `tests`, which the task owns. realpath follows
    // the link; Git reads <rev>:<path> by name in that commit's tree and does not.
    const w = world(on); const a = await reviewer($)
    w.links[`${ROOT}/private`] = `${ROOT}/tests`
    const out = await git($, a, 'git show HEAD~1:private/key.txt')
    expect(out.deny).toContain('read outside owned resources')
    expect(out.deny).toContain('…/private/key.txt')
    // as a path after `--` it is the resolved path that Git is given, so that is what must be owned, and is
    expect((await git($, a, 'git log --oneline -3 -- private/key.txt')).deny).toBeUndefined()
    expect(sentOf(w)).toEqual([[...HEAD, 'log', '--no-ext-diff', '--no-textconv', NO_SUB, '--oneline', '-3', '--', `${ROOT}/tests/key.txt`]])
    // and a link that leads out of the scope is refused both ways
    w.links[`${ROOT}/tests/out`] = `${ROOT}/secret`
    expect((await git($, a, 'git show HEAD:tests/out/key.txt')).deny).toContain('read outside owned resources')
    expect((await git($, a, 'git diff -- tests/out/key.txt')).deny).toContain('read outside owned resources')
    expect(sentOf(w)).toHaveLength(1)
  })
  test('the refusal names the scope without a home directory\'s user name', options, async ($, on) => {
    world(on); const a = await reviewer($, ['/var/home/alice/work/repo/hooks/swarm.ts'])
    const out = await git($, a, 'git diff -- /var/home/alice/work/repo/README.md')
    expect(out.deny).toContain('read outside owned resources')
    expect(out.deny).not.toContain('alice')
  })
  test('unsafe syntax, flags and programs never reach the host, and each refusal says why', options, async ($, on) => {
    const w = world(on); const a = await reviewer($)
    const cases: [string, string][] = [
      ['git diff', 'name what to read'],
      ['git diff main...HEAD', 'name what to read'],
      ['git log --full-diff -- hooks/swarm.ts', 'not on the list of options'],
      ['git log -L1,5:README.md -- hooks/swarm.ts', 'not on the list of options'],
      ['git log --follow -- hooks/swarm.ts', 'not on the list of options'],
      ['git diff --no-index /etc/passwd hooks/swarm.ts', 'one plain command'],
      ['git diff --output=/tmp/x -- hooks/swarm.ts', 'one plain command'],
      ['git diff --ext-diff -- hooks/swarm.ts', 'one plain command'],
      ['git diff -Oorder -- hooks/swarm.ts', 'not on the list of options'],
      ['git grep -Oless x -- tests', 'not on the list of options'],
      ['git grep --open-files-in-pager=sh x -- tests', 'not on the list of options'],
      ['git log --format=%H -- hooks/swarm.ts', 'not on the list of options'],
      ['git show --show-signature HEAD -- tests', 'not on the list of options'],
      ['git diff -- hooks/swarm.ts | head', 'one plain git command'],
      ['git diff -- hooks/swarm.ts && git push', 'one plain git command'],
      ['git diff -- hooks/swarm.ts > /tmp/x', 'one plain command'],
      ['git diff $(id) -- hooks/swarm.ts', 'one plain command'],
      ['git diff -- "$HOME"', 'one plain command'],
      ['git -C /etc diff -- hooks/swarm.ts', 'not available under a narrow scope'],
      ['git -c core.pager=sh diff -- hooks/swarm.ts', 'not available under a narrow scope'],
      ['git diff HEAD:README.md HEAD:LICENSE -- hooks/swarm.ts', 'not a plain revision'],
      ['git grep x HEAD:docs -- tests', 'not a plain revision'],
      ['git diff HEAD^{tree} -- hooks/swarm.ts', 'not a plain revision'],
      ['git diff -- :(top)README.md', 'one plain git command'],
      ['git diff -- :!tests', 'not a literal path'],
      ['git diff -- tests/*', 'not a literal path'],
      ['git push origin main', 'not available under a narrow scope'],
      ['git checkout -- hooks/swarm.ts', 'not available under a narrow scope'],
      ['git rev-parse HEAD', 'not available under a narrow scope'],
    ]
    for (const [command, why] of cases) {
      const out = await git($, a, command)
      expect([command, out.deny?.includes(why)]).toEqual([command, true])
      expect(out.deny).toStartWith('SWARM / ')
      expect(out.deny).toContain('Owned: ')
    }
    expect(sentOf(w)).toEqual([])
  })
  test('a command that is not Git meets the general rule, with the way to search', options, async ($, on) => {
    const w = world(on); const a = await reviewer($)
    // a wrapper or an assignment in front of git is not a Git inspection either: it is refused as any other program is
    for (const command of ['cat hooks/swarm.ts', 'ls tests', 'grep -rn x tests', 'rg x tests', 'find . -name x', 'head -5 hooks/swarm.ts', 'touch tests/x', 'GIT_DIR=/x git diff -- hooks/swarm.ts', 'env git diff -- hooks/swarm.ts', 'sudo git diff -- hooks/swarm.ts']) {
      const out = await git($, a, command)
      expect([command, out.deny?.includes('read-only tasks may use inspection tools only')]).toEqual([command, true])
      expect(out.deny).toContain('git grep -n <pattern> -- <path>')
    }
    expect(sentOf(w)).toEqual([])
  })
  test('an unverifiable repository or an active filter refuses scoped inspection too', options, async ($, on) => {
    const w = world(on); const a = await reviewer($)
    w.indexFlags = 'H a\0'; w.gitFilterConfig = 'filter.hide.clean\nexternal command\0'; w.gitFilterAttributes = 'a\0filter\0hide\0'
    expect((await git($, a, 'git diff -- hooks/swarm.ts')).deny).toContain('safe repository identity')
    w.gitFilterConfig = ''; w.gitFilterAttributes = ''; w.gitPrefix = '../elsewhere/'
    expect((await git($, a, 'git diff -- hooks/swarm.ts')).deny).toContain('safe repository identity')
    expect(sentOf(w)).toEqual([])
  })
  test('cancellation and an ended task still stop everything', options, async ($, on) => {
    const w = world(on); const a = await reviewer($)
    await $.tool.call({ tool: SWARM, action: 'cancel', task_id: 'rev' } as never)
    expect((await git($, a, 'git diff -- hooks/swarm.ts')).deny).toContain('cancellation requested')
    await $.turn.complete({ agentId: a, turnId: `turn-${a}`, reason: 'aborted', answer: '', durationMs: 5, isAborted: true } as never)
    expect((await git($, a, 'git diff -- hooks/swarm.ts')).deny).toBeDefined()
    expect(sentOf(w)).toEqual([])
  })
  test('another task\'s scope is not this task\'s', options, async ($, on) => {
    const w = world(on); await start($)
    await assign($, 'one', [`${ROOT}/hooks`]); await assign($, 'two', [`${ROOT}/docs`])
    const one = (await spawn($, 'one')).agentId!; const two = (await spawn($, 'two')).agentId!
    expect((await git($, one, 'git diff -- hooks/swarm.ts')).deny).toBeUndefined()
    expect((await git($, two, 'git diff -- hooks/swarm.ts')).deny).toContain('read outside owned resources')
    expect((await git($, two, 'git diff -- docs/a.md')).deny).toBeUndefined()
    expect((await git($, one, 'git diff -- docs/a.md')).deny).toContain('read outside owned resources')
    expect(sentOf(w)).toHaveLength(2)
  })
})

describe('a wildcard reader keeps the v0.6.0 rule, with the path separator', () => {
  test('`--` and its paths are accepted, and the command is not narrowed; v0.6.6: it runs in the verified directory', options, async ($, on) => {
    const w = world(on); const a = await reviewer($, ['*'])
    expect((await git($, a, 'git diff main...HEAD -- hooks/swarm.ts')).deny).toBeUndefined()
    expect((await git($, a, "git grep -n '\\$\\.process' -- hooks")).deny).toBeUndefined()
    expect((await git($, a, 'git log --oneline -5')).deny).toBeUndefined()
    expect(sentOf(w)).toEqual([
      [...HEAD, 'diff', '--no-ext-diff', '--no-textconv', NO_SUB, 'main...HEAD', '--', 'hooks/swarm.ts'],
      [...HEAD, 'grep', '-n', '\\$\\.process', '--', 'hooks'],
      [...HEAD, 'log', '--no-ext-diff', '--no-textconv', NO_SUB, '--oneline', '-5'],
    ])
  })
  test('what it refused before it refuses still, and the pager and output options in every form Git reads', options, async ($, on) => {
    const w = world(on); const a = await reviewer($, ['*'])
    for (const command of [
      'git diff -- --output=x', 'git log --author -- --show-signature', 'git grep -e -- --open-files-in-pager=sh', 'git diff --output=x', 'git log --format=%H', 'git show --show-sig', 'git grep -Oless x', 'git diff > x', 'git diff $(id)',
      // bundled and abbreviated forms of the pager and output options, which v0.6.0 let through
      "git grep -nO'touch /tmp/canary #' -e .", "git grep --op='touch /tmp/canary #' -e .", 'git grep --ope=sh -e .', 'git grep --no-ind -e x', 'git diff -pO/etc/passwd', 'git log --ou=/tmp/x', 'git log --oneline -1\r# ; touch /tmp/canary',
      'git grep "$(id)"', 'git -C /etc diff', 'git diff | head', 'env git diff', 'git push', 'cat README.md', 'npm test',
    ]) expect([command, (await git($, a, command)).deny !== undefined]).toEqual([command, true])
    expect(sentOf(w)).toEqual([])
  })
  test('the commander\'s own inspection with `--` is read-only, so it is not held behind a running helper', options, async ($, on) => {
    const w = world(on); await reviewer($, ['*'])
    expect((await git($, undefined, 'git diff main...HEAD -- hooks/swarm.ts')).deny).toBeUndefined()
    expect((await git($, undefined, 'git status --short -- hooks')).deny).toBeUndefined()
    // an effect is still held while the helper owns the repository
    expect((await git($, undefined, 'npm test')).deny).toContain('held until active ownership releases')
    // and the commander's command is never rewritten: it runs as typed, under the host's own permissions
    expect(w.ran.filter(call => call['tool'] === 'Bash').map(call => call['command'])).toEqual(['git diff main...HEAD -- hooks/swarm.ts', 'git status --short -- hooks'])
  })
})
