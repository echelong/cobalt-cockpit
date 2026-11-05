// Commander planning and worker delegation requests. Both are untrusted model output:
// they are parsed strictly, any violation rejects the whole document, and the router
// (not the model) still picks every task's model.
import { lexicalFeatures, normalizeOwned } from './core/engine.ts'
import { KINDS, RISKS } from './router.ts'
import type { Kind, Risk, TaskSpec } from './router.ts'

export const MAX_PLAN_TASKS = 12
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/

export type Parsed = { ok: true; tasks: TaskSpec[] } | { ok: false; reason: string }

/** The last ```json fenced block after `marker` (or anywhere when marker is null). */
export const lastJsonBlock = (text: string, marker: string | null = null): string | null => {
  const from = marker === null ? text : text.slice(Math.max(0, text.lastIndexOf(marker)))
  if (marker !== null && !text.includes(marker)) return null
  const blocks = [...from.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  return blocks.length ? blocks[blocks.length - 1][1] : null
}

const relOwned = (p: unknown): string | null => {
  if (typeof p !== 'string' || !p.trim()) return null
  if (p.trim() === '*' ) return '*'
  if (p.startsWith('/') || p.includes('\\') || p.split('/').includes('..')) return null
  const n = normalizeOwned(p)
  return n === '*' && p.trim() !== '*' ? null : n
}

export const validateTasks = (raw: unknown, opts: { max: number; depth: number; parent: string | null; existing: ReadonlySet<string>; idPrefix?: string }): Parsed => {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)) ? (raw as { tasks: unknown[] }).tasks : null
  if (!list) return { ok: false, reason: 'document has no "tasks" array' }
  if (list.length === 0) return { ok: false, reason: 'no tasks' }
  if (list.length > opts.max) return { ok: false, reason: `${list.length} tasks exceed the limit of ${opts.max}` }
  const out: TaskSpec[] = []; const ids = new Set<string>()
  for (const [i, t] of list.entries()) {
    const o = (t ?? {}) as Record<string, unknown>
    const where = `task ${i + 1}`
    if (typeof o.id !== 'string' || !ID.test(o.id)) return { ok: false, reason: `${where}: id must match ${ID}` }
    const id = `${opts.idPrefix ?? ''}${o.id}`
    if (ids.has(id) || opts.existing.has(id)) return { ok: false, reason: `${where}: duplicate id ${id}` }
    if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 200) return { ok: false, reason: `${where}: title required (max 200)` }
    if (!(KINDS as readonly string[]).includes(o.kind as string)) return { ok: false, reason: `${where}: kind must be one of ${KINDS.join('|')}` }
    if (!(RISKS as readonly string[]).includes(o.risk as string)) return { ok: false, reason: `${where}: risk must be one of ${RISKS.join('|')}` }
    if (typeof o.complexity !== 'number' || !Number.isInteger(o.complexity) || o.complexity < 1 || o.complexity > 5) return { ok: false, reason: `${where}: complexity 1-5` }
    if (o.mode !== 'read' && o.mode !== 'write') return { ok: false, reason: `${where}: mode read|write` }
    if (!Array.isArray(o.owned) || o.owned.length === 0 || o.owned.length > 20) return { ok: false, reason: `${where}: owned must list 1-20 repository-relative paths` }
    const owned: string[] = []
    for (const p of o.owned) { const n = relOwned(p); if (n === null) return { ok: false, reason: `${where}: owned path ${JSON.stringify(p)} is not a safe repository-relative path` }; owned.push(n) }
    const deps = Array.isArray(o.dependencies) ? o.dependencies : []
    if (!deps.every(d => typeof d === 'string')) return { ok: false, reason: `${where}: dependencies must be ids` }
    if (typeof o.prompt !== 'string' || !o.prompt.trim() || o.prompt.length > 8000) return { ok: false, reason: `${where}: prompt required (max 8000 chars)` }
    const priority = o.priority === undefined ? 5 : o.priority
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 9) return { ok: false, reason: `${where}: priority 0-9` }
    ids.add(id)
    out.push({ id, title: o.title.trim(), kind: o.kind as Kind, risk: o.risk as Risk, complexity: o.complexity, mode: o.mode, owned, dependencies: (deps as string[]).map(d => opts.existing.has(d) ? d : `${opts.idPrefix ?? ''}${d}`), prompt: o.prompt, priority, depth: opts.depth, parent: opts.parent, ...(typeof o.contextTokens === 'number' ? { contextTokens: o.contextTokens } : {}) })
  }
  for (const t of out) for (const d of t.dependencies) if (!ids.has(d) && !opts.existing.has(d)) return { ok: false, reason: `task ${t.id}: unknown dependency ${d}` }
  const visiting = new Set<string>(), done = new Set<string>()
  const byId = new Map(out.map(t => [t.id, t]))
  const cyc = (id: string): boolean => { if (done.has(id)) return false; if (visiting.has(id)) return true; visiting.add(id); const r = (byId.get(id)?.dependencies ?? []).some(cyc); visiting.delete(id); done.add(id); return r }
  if (out.some(t => cyc(t.id))) return { ok: false, reason: 'dependency cycle' }
  return { ok: true, tasks: out }
}

export const parsePlan = (text: string, existing: ReadonlySet<string> = new Set()): Parsed => {
  const block = lastJsonBlock(text)
  if (!block) return { ok: false, reason: 'no ```json plan block in the commander output' }
  let doc: unknown
  try { doc = JSON.parse(block) } catch (e) { return { ok: false, reason: `plan JSON invalid: ${(e as Error).message}` } }
  return validateTasks(doc, { max: MAX_PLAN_TASKS, depth: 1, parent: null, existing })
}

export const REQUEST_MARKER = 'COCKPIT_REQUEST'
/** A worker's request for more work; validated like a plan, one level deeper, prefixed by its parent id. */
export const parseRequest = (text: string, parent: TaskSpec, maxChildren: number, existing: ReadonlySet<string>): Parsed | null => {
  const block = lastJsonBlock(text, REQUEST_MARKER)
  if (block === null) return null
  let doc: unknown
  try { doc = JSON.parse(block) } catch (e) { return { ok: false, reason: `request JSON invalid: ${(e as Error).message}` } }
  return validateTasks(doc, { max: maxChildren, depth: (parent.depth ?? 0) + 1, parent: parent.id, existing, idPrefix: `${parent.id}.` })
}

/** Small tasks go straight to the coder; the commander plans only substantial ones. */
export const needsCommander = (goal: string, flags: { swarm?: boolean; single?: boolean }): { commander: boolean; reason: string } => {
  if (flags.single) return { commander: false, reason: '--single: one coder task' }
  if (flags.swarm) return { commander: true, reason: '--swarm: commander decomposes the goal' }
  const f = lexicalFeatures({ prompt: goal, files: [], milestones: 0, errorStreak: 0 })
  const items = goal.split('\n').filter(l => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l)).length
  if (f.architecture) return { commander: true, reason: 'architecture wording: commander plans' }
  if (f.parallel && items >= 2) return { commander: true, reason: `independent parts (${items} items): commander plans` }
  if (items >= 3) return { commander: true, reason: `${items} listed parts: commander plans` }
  if (goal.length > 1500) return { commander: true, reason: 'long goal: commander plans' }
  return { commander: false, reason: 'bounded goal: one coder task, no commander call' }
}

export const plannerPrompt = (goal: string, repoSummary: string): string => `You are the commander of a Cobalt Cockpit mission. Decompose the GOAL into bounded tasks for separate workers.
Do not edit files. Inspect the repository read-only as needed, then answer with ONE fenced \`\`\`json block:
{"tasks":[{"id":"short-kebab-id","title":"...","kind":"${KINDS.join('|')}","risk":"${RISKS.join('|')}","complexity":1-5,"mode":"read|write","owned":["repo/relative/path"],"dependencies":["other-id"],"priority":0-9,"prompt":"complete self-contained instructions"}]}
Rules: at most ${MAX_PLAN_TASKS} tasks; prefer few; tasks that write must own disjoint paths unless one depends on the other;
owned paths are repository-relative (no leading slash, no ..); use "*" only when a task truly needs the whole tree;
each prompt must be self-contained. Cockpit, not you, chooses each worker's model.
Repository: ${repoSummary}
GOAL:
${goal}`

export const workerPrompt = (t: TaskSpec, ctx: { evidence?: string[]; readOnly: boolean; allowedTools: string[] }): string => `${t.prompt}

-- Cobalt Cockpit worker contract --
Task: ${t.id} · ${t.title}
${ctx.readOnly ? 'This task is READ-ONLY: do not modify files.' : `You may modify only: ${t.owned.join(', ')} (repository-relative; "*" means the whole tree).`}
Allowed tools: ${ctx.allowedTools.join(', ')}. Any other tool, launching agents, or Git commits/branches aborts the run.
Cockpit runs the tests, type checks and Git checks itself after you finish; your own claims are not accepted as verification.
If more independent work is needed, do not start it: end your reply with a line ${REQUEST_MARKER} followed by a \`\`\`json block {"tasks":[...]} in the commander's task format.
${ctx.evidence?.length ? `\nEvidence from the previous attempt (fix these):\n${ctx.evidence.map(e => `- ${e}`).join('\n')}` : ''}`
