// What a tool call is (READ, EDIT, TEST, GIT, ...) and which verification
// gates a Bash command exercises. A gate is only settled from a command's
// real result, and only when that result is the check's own: a check piped
// into `tail`, or followed by `; echo done`, proves nothing either way.

import type { ActivityKind, GateName, GateState } from '../types'
import { basename, parseShell, unwrap } from './shell'
import type { Connector } from './shell'

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'dlx', 'exec', 'x', 'poetry', 'uv', 'pipenv', 'bundle', 'hatch', 'rye'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])

/** Commands that change nothing a check depends on and cannot fail a chain meaningfully. */
const INERT = new Set(['cd', 'echo', 'printf', 'export', 'set', 'source', '.', 'pushd', 'popd', 'true', ':', 'pwd', 'mkdir', 'date', 'sleep', 'unset', 'umask', 'which', 'type'])

const scriptGate = (script: string): GateName | null => {
  if (/^(test|tests|spec|e2e|unit|integration|coverage|vitest|jest)(:|$)/.test(script)) return 'TEST'
  if (/^(type-?check|types|tsc|check-types|check:types)(:|$)/.test(script)) return 'TYPE'
  if (/^(build|compile|bundle)(:|$)/.test(script)) return 'BUILD'
  if (/^(lint|eslint|biome|format:check|fmt:check|check|validate|stylelint)(:|$)/.test(script)) return 'CODE'
  if (/^(audit|security|scan)(:|$)/.test(script)) return 'SECURITY'

  return null
}

const TOOL_GATES: readonly { tool: RegExp; args?: RegExp; gate: GateName }[] = [
  { tool: /^(vitest|jest|mocha|ava|pytest|py\.test|tox|nox|rspec|phpunit|ctest|karma)$/, gate: 'TEST' },
  { tool: /^(playwright|cypress)$/, args: /^(test|run)\b/, gate: 'TEST' },
  { tool: /^(go|cargo|deno|dotnet|swift|mix|flutter|dart|zig)$/, args: /^(test|nextest)\b/, gate: 'TEST' },
  { tool: /^(mvn|mvnw|gradle|gradlew)$/, args: /\b(test|verify|check)\b/, gate: 'TEST' },
  { tool: /^(rails|rake)$/, args: /^(test|spec)\b/, gate: 'TEST' },
  { tool: /^(make|just|task)$/, args: /^(test|tests|check)\b/, gate: 'TEST' },
  { tool: /^(python|python3)$/, args: /^-m (pytest|unittest)\b/, gate: 'TEST' },
  { tool: /^claude$/, args: /^plugin test\b/, gate: 'TEST' },
  { tool: /^(node|tsx|bun)$/, args: /(^|\s)--test\b/, gate: 'TEST' },
  { tool: /^(tsc|vue-tsc|mypy|pyright|pyre|flow)$/, gate: 'TYPE' },
  { tool: /^cargo$/, args: /^check\b/, gate: 'TYPE' },
  { tool: /^go$/, args: /^vet\b/, gate: 'TYPE' },
  { tool: /^(python|python3)$/, args: /^-m (mypy|pyright)\b/, gate: 'TYPE' },
  { tool: /^(make|just|task)$/, args: /^(typecheck|type-check|types)\b/, gate: 'TYPE' },
  { tool: /^(go|cargo|dotnet|swift|zig)$/, args: /^build\b/, gate: 'BUILD' },
  { tool: /^(vite|next|nuxt|astro|parcel)$/, args: /^build\b/, gate: 'BUILD' },
  { tool: /^(webpack|rollup|esbuild|tsup)$/, gate: 'BUILD' },
  { tool: /^(mvn|mvnw|gradle|gradlew)$/, args: /\b(package|compile|install|build|assemble)\b/, gate: 'BUILD' },
  { tool: /^(make|just|task)$/, args: /^(build|all|$)/, gate: 'BUILD' },
  { tool: /^(docker|podman)$/, args: /^(build|buildx build|compose build)\b/, gate: 'BUILD' },
  { tool: /^cmake$/, args: /--build\b/, gate: 'BUILD' },
  { tool: /^(eslint|flake8|pylint|rubocop|shellcheck|stylelint|golangci-lint|clippy-driver)$/, gate: 'CODE' },
  { tool: /^(biome|ruff)$/, args: /^(check|lint|ci|format --check)\b/, gate: 'CODE' },
  { tool: /^prettier$/, args: /(^|\s)(--check|-c)\b/, gate: 'CODE' },
  { tool: /^cargo$/, args: /^(clippy|fmt\b.*--check)\b/, gate: 'CODE' },
  { tool: /^(make|just|task)$/, args: /^(lint|fmt-check)\b/, gate: 'CODE' },
  { tool: /^claude$/, args: /^plugin validate\b/, gate: 'CODE' },
  { tool: /^(pip-audit|bandit|semgrep|trivy|gitleaks|osv-scanner|govulncheck|trufflehog|grype|safety)$/, gate: 'SECURITY' },
  { tool: /^snyk$/, args: /^(test|code test)\b/, gate: 'SECURITY' },
  { tool: /^cargo$/, args: /^(audit|deny)\b/, gate: 'SECURITY' },
  { tool: /^bundle$/, args: /^audit\b/, gate: 'SECURITY' },
]

/** The gate a single command exercises, or null. */
export const gateOfCommand = (argv: readonly string[]): GateName | null => {
  const run = unwrap(argv)
  if (run === null) return null
  let words = [run.program, ...run.args]
  // `npx vitest`, `uv run pytest`, `bundle exec rspec`: the tool is what runs
  for (let guard = 0; guard < 4; guard++) {
    const head = words[0]
    if (head === undefined) return null
    if (head === 'bundle' && words[1] === 'audit') break
    if (RUNNERS.has(head) || (head === 'run' && guard > 0)) {
      words = words.slice(1).filter((word, index) => index > 0 || !word.startsWith('-'))
      continue
    }
    break
  }
  const tool = basename(words[0] ?? '')
  const rest = words.slice(1)

  if (PACKAGE_MANAGERS.has(tool)) {
    const first = rest[0] ?? ''
    if (first === 'audit') return 'SECURITY'
    if (first === 'test' || first === 't') return 'TEST'
    if (tool === 'deno' && first === 'check') return 'TYPE'
    if (tool === 'deno' && first === 'lint') return 'CODE'
    const script = first === 'run' || first === 'run-script' ? (rest[1] ?? '') : first
    if (first === 'exec' || first === 'dlx' || first === 'x') return gateOfCommand(rest.slice(1))

    return scriptGate(script)
  }
  const args = rest.join(' ')
  const rule = TOOL_GATES.find(one => one.tool.test(tool) && (one.args === undefined || one.args.test(args)))

  return rule?.gate ?? null
}

export type GateReading = { gate: GateName; state: GateState; evidence: string }

export type BashReading = {
  activity: ActivityKind
  /** The gates the command exercised. */
  gates: GateName[]
  /** Reads the gates off the command's outcome. */
  read: (outcome: 'ok' | 'error' | 'unknown') => GateReading[]
}

const ACTIVITY_OF_GATE: Record<GateName, ActivityKind> = {
  TEST: 'TEST',
  TYPE: 'TYPE',
  BUILD: 'BUILD',
  CODE: 'LINT',
  SECURITY: 'AUDIT',
  GIT: 'GIT',
}

/** Classifies a Bash command: its activity, and how its result bears on the gates. */
export const readBash = (command: string): BashReading => {
  const parsed = parseShell(command)
  const checks: { gate: GateName; isMasked: boolean }[] = []
  let isGit = false
  let hasOther = false

  parsed.pipelines.forEach((pipeline, index) => {
    const isLast = index === parsed.pipelines.length - 1
    // a failure here still fails the whole command only under `&&` or at the end
    const isCarried = isLast || pipeline.next === '&&'
    const before: Connector[] = parsed.pipelines.slice(0, index).map(one => one.next)
    const isReached = before.every(next => next === '&&' || next === ';')
    let hasCheck = false
    pipeline.commands.forEach((simple, at) => {
      const gate = gateOfCommand(simple.argv)
      if (gate === null) return
      hasCheck = true
      const isPiped = at < pipeline.commands.length - 1 && !parsed.hasPipefail
      checks.push({ gate, isMasked: isPiped || !isCarried || !isReached })
    })
    // beside a check, the rest of its pipeline only filters its output; a
    // pipeline without one fails by its last command
    const deciding = unwrap(pipeline.commands[pipeline.commands.length - 1]?.argv ?? [])
    if (pipeline.commands.some(simple => /^(git|gh)$/.test(unwrap(simple.argv)?.program ?? ''))) isGit = true
    else if (!hasCheck && deciding !== null && !INERT.has(deciding.program)) hasOther = true
  })

  const gates = [...new Set(checks.map(one => one.gate))]
  const first = gates[0]
  const activity: ActivityKind = first !== undefined ? ACTIVITY_OF_GATE[first] : isGit ? 'GIT' : 'BASH'
  const label = command.replace(/\s+/g, ' ').trim().slice(0, 80)

  const read = (outcome: 'ok' | 'error' | 'unknown'): GateReading[] =>
    gates.map(gate => {
      const isMasked = checks.some(one => one.gate === gate && one.isMasked)
      if (outcome === 'unknown') {
        return { gate, state: 'pending', evidence: `${label} (result not known yet)` }
      }
      if (isMasked) {
        return { gate, state: 'pending', evidence: `${label} (exit status masked; report the result)` }
      }
      if (outcome === 'ok') return { gate, state: 'pass', evidence: `${label} (exit 0)` }
      // a failure is the check's own only when nothing else in the chain could have failed
      const isOwn = !hasOther && !isGit
      if (!isOwn) {
        return { gate, state: 'pending', evidence: `${label} (failed; unclear which step)` }
      }

      return {
        gate,
        state: 'fail',
        evidence: gates.length > 1 ? `${label} (failed: one of ${gates.join(', ')})` : `${label} (failed)`,
      }
    })

  return { activity, gates, read }
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ToolSearch', 'ListAgents'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode'])

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The activity a tool call is, and a short word about its target. */
export const activityOf = (tool: string, input: Record<string, unknown>): { kind: ActivityKind; detail: string } => {
  if (tool === 'Bash') {
    const command = text(input['command'])

    return { kind: readBash(command).activity, detail: command.replace(/\s+/g, ' ').trim().slice(0, 40) }
  }
  if (READ_TOOLS.has(tool)) {
    const target = text(input['file_path']) || text(input['path']) || text(input['pattern']) || text(input['query'])

    return { kind: 'READ', detail: target.includes('/') ? basename(target) : target.slice(0, 40) }
  }
  if (EDIT_TOOLS.has(tool)) {
    return { kind: 'EDIT', detail: basename(text(input['file_path']) || text(input['notebook_path'])) }
  }
  if (WEB_TOOLS.has(tool)) {
    const url = text(input['url'])
    const host = url !== '' && URL.canParse(url) ? new URL(url).hostname : ''

    return { kind: 'WEB', detail: host || text(input['query']).slice(0, 40) }
  }
  if (tool === 'Agent' || tool === 'Task') {
    return { kind: 'AGENT', detail: text(input['description']).slice(0, 40) }
  }
  if (PLAN_TOOLS.has(tool)) return { kind: 'PLAN', detail: '' }

  return { kind: 'TOOL', detail: tool.replace(/^mcp__/, '').replace(/__/g, ':').slice(0, 40) }
}
