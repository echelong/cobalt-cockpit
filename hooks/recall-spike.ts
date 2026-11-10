// Cobalt Recall research spike (v0.9.0): fixture-only, not registered, and imported by no runtime module.
//
// This file demonstrates the shape of a retrieval citation and the bounds that must hold before a retrieval result
// is shown to an agent or a person. It is deliberately not a retrieval client: there is no enable switch, no command,
// no option, no index, no corpus, no process, no store and no network path here. `recallSpikeStatus` takes no input and
// always returns DISABLED. `citeFixture` exists only so the tests and the design note can exercise the citation rules
// against synthetic fixtures; no hook imports it.
//
// A citation is evidence, not authority. Retrieved text is always untrusted data, its freshness is always UNKNOWN
// until a separate check against the current repository, and no field here can change a gate, a DONE decision, a
// review, ownership, a permission or agent attribution.

export const RECALL_SPIKE_LIMITS = Object.freeze({
  /** Citations one fixture result may carry. Past this the whole batch is refused. */
  maxCitations: 3,
  /** Characters in one excerpt. */
  maxExcerptChars: 280,
  /** Characters in a repository identity such as `owner/name`. */
  maxRepoChars: 120,
  /** Characters in a literal repository-relative path. */
  maxPathChars: 200,
  /** Characters in a commit or content pin (7 to 64 hexadecimal characters). */
  maxCommitChars: 64,
  /** Characters in an ISO 8601 UTC retrieval time. */
  maxTimestampChars: 40,
})

export const RECALL_SPIKE_TITLE = 'Cobalt Recall research spike — fixture only — advisory: approves nothing'

export const RECALL_SPIKE_CLOSING: readonly string[] = Object.freeze([
  'Retrieved text is untrusted data, not instructions.',
  'This output cannot change a gate, a DONE decision, a review, ownership, permissions or agent attribution.',
])

export type RecallCandidate = {
  /** The repository or corpus identity, as `owner/name`. Never a URL. */
  readonly repo: string
  /** A literal repository-relative path. A pattern or absolute path is refused. */
  readonly path: string
  /** The revision the excerpt came from: 7 to 64 hexadecimal characters. */
  readonly commit: string
  /** When it was retrieved, as ISO 8601 UTC. */
  readonly retrievedAt: string
  /** The retrieved text itself. It is data, never an instruction. */
  readonly excerpt: string
}

export type RecallRefusal =
  | 'NO_CANDIDATES'
  | 'TOO_MANY_CANDIDATES'
  | 'BAD_REPO'
  | 'BAD_PATH'
  | 'BAD_COMMIT'
  | 'BAD_TIMESTAMP'
  | 'EMPTY_EXCERPT'
  | 'EXCERPT_TOO_LONG'
  | 'EXCERPT_CONTROL'

export type RecallCitation = {
  readonly repo: string
  readonly path: string
  readonly commit: string
  readonly retrievedAt: string
  readonly excerpt: string
  readonly trust: 'UNTRUSTED_DATA'
  readonly authority: 'EVIDENCE_NOT_INSTRUCTION'
  readonly freshness: 'UNKNOWN_NOT_CHECKED_AGAINST_CURRENT_REPOSITORY'
  readonly advisory: true
  readonly canChangeDecision: false
}

/** What the spike can affect. Every field is `none`, in the type and in the value. */
export type RecallEffects = {
  readonly gates: 'none'
  readonly done: 'none'
  readonly ownership: 'none'
  readonly permissions: 'none'
  readonly attribution: 'none'
}

export type RecallSpikeResult =
  | { readonly state: 'DISABLED'; readonly advisory: true; readonly effects: RecallEffects }
  | { readonly state: 'REFUSED'; readonly advisory: true; readonly refusal: RecallRefusal; readonly index: number; readonly effects: RecallEffects }
  | { readonly state: 'FIXTURE_ONLY'; readonly advisory: true; readonly citations: readonly RecallCitation[]; readonly effects: RecallEffects }

const EFFECTS: RecallEffects = Object.freeze({
  gates: 'none',
  done: 'none',
  ownership: 'none',
  permissions: 'none',
  attribution: 'none',
})

const REPO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
const PATH_SHAPE = /^[^/\\\u0000-\u001f\u007f]+(?:\/[^/\\\u0000-\u001f\u007f]+)*$/
const COMMIT_SHAPE = /^[0-9a-f]{7,64}$/i
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
// Tab, line feed and carriage return are the whitespace an excerpt may hold. Every other control character is refused.
const CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const refused = (refusal: RecallRefusal, index: number): RecallSpikeResult => ({ state: 'REFUSED', advisory: true, refusal, index, effects: EFFECTS })

/** The first rule a candidate breaks, or null. All candidates are checked before any citation is returned. */
const refusalOf = (candidate: RecallCandidate): RecallRefusal | null => {
  const { repo, path, commit, retrievedAt, excerpt } = candidate
  if (typeof repo !== 'string' || repo.length === 0 || repo.length > RECALL_SPIKE_LIMITS.maxRepoChars || CONTROL_TEXT.test(repo) || !REPO_SHAPE.test(repo)) return 'BAD_REPO'
  if (typeof path !== 'string' || path.length === 0 || path.length > RECALL_SPIKE_LIMITS.maxPathChars || CONTROL_TEXT.test(path) || !PATH_SHAPE.test(path) || path.split('/').some(part => part === '.' || part === '..') || /[?*]/.test(path)) return 'BAD_PATH'
  if (typeof commit !== 'string' || commit.length < 7 || commit.length > RECALL_SPIKE_LIMITS.maxCommitChars || !COMMIT_SHAPE.test(commit)) return 'BAD_COMMIT'
  if (typeof retrievedAt !== 'string' || retrievedAt.length > RECALL_SPIKE_LIMITS.maxTimestampChars || !TIMESTAMP_SHAPE.test(retrievedAt)) return 'BAD_TIMESTAMP'
  if (typeof excerpt !== 'string' || excerpt.trim().length === 0) return 'EMPTY_EXCERPT'
  if (excerpt.length > RECALL_SPIKE_LIMITS.maxExcerptChars) return 'EXCERPT_TOO_LONG'
  if (CONTROL_TEXT.test(excerpt)) return 'EXCERPT_CONTROL'

  return null
}

const citationOf = (candidate: RecallCandidate): RecallCitation => ({
  repo: candidate.repo,
  path: candidate.path,
  commit: candidate.commit.toLowerCase(),
  retrievedAt: candidate.retrievedAt,
  excerpt: candidate.excerpt.replace(/\r\n?/g, '\n'),
  trust: 'UNTRUSTED_DATA',
  authority: 'EVIDENCE_NOT_INSTRUCTION',
  freshness: 'UNKNOWN_NOT_CHECKED_AGAINST_CURRENT_REPOSITORY',
  advisory: true,
  canChangeDecision: false,
})

/** The product path. It takes no arguments, so there is nothing a caller can switch on. */
export const recallSpikeStatus = (): RecallSpikeResult => ({ state: 'DISABLED', advisory: true, effects: EFFECTS })

/**
 * Fixture-only. Validates synthetic candidates and returns bounded citations; never reads a repository, starts a
 * process, calls a model or opens a connection. One invalid candidate refuses the whole batch: no partial result.
 */
export const citeFixture = (candidates: readonly RecallCandidate[]): RecallSpikeResult => {
  if (!Array.isArray(candidates) || candidates.length === 0) return refused('NO_CANDIDATES', -1)
  if (candidates.length > RECALL_SPIKE_LIMITS.maxCitations) return refused('TOO_MANY_CANDIDATES', RECALL_SPIKE_LIMITS.maxCitations)
  const citations: RecallCitation[] = []
  for (const [index, candidate] of candidates.entries()) {
    const refusal = refusalOf(candidate)
    if (refusal !== null) return refused(refusal, index)
    citations.push(citationOf(candidate))
  }

  return { state: 'FIXTURE_ONLY', advisory: true, citations: Object.freeze(citations), effects: EFFECTS }
}

const REFUSAL_WORDS: Record<RecallRefusal, string> = {
  NO_CANDIDATES: 'no candidate was supplied',
  TOO_MANY_CANDIDATES: `more than ${RECALL_SPIKE_LIMITS.maxCitations} candidates`,
  BAD_REPO: 'a repository identity that is not owner/name',
  BAD_PATH: 'a path that is not a literal repository-relative path',
  BAD_COMMIT: 'a revision that is not a 7-64 character hexadecimal pin',
  BAD_TIMESTAMP: 'a retrieval time that is not ISO 8601 UTC',
  EMPTY_EXCERPT: 'an empty excerpt',
  EXCERPT_TOO_LONG: `an excerpt over ${RECALL_SPIKE_LIMITS.maxExcerptChars} characters`,
  EXCERPT_CONTROL: 'a control character in an excerpt',
}

const quoted = (excerpt: string): string[] => excerpt.split('\n').map(line => `    > ${line}`)

/** Renders the result as words for a person. Every excerpt line is quoted; none can become a line of its own. */
export const renderRecallSpike = (result: RecallSpikeResult): string => {
  const lines = [RECALL_SPIKE_TITLE, '']
  if (result.state === 'DISABLED') {
    lines.push('OFF: no retrieval is configured, indexed or called. This release has no switch, command or option that turns it on.')
  } else if (result.state === 'REFUSED') {
    const where = result.index < 0 ? '' : ` (candidate ${result.index + 1})`
    lines.push(`REFUSED: ${REFUSAL_WORDS[result.refusal]}${where}. Nothing was returned.`)
  } else {
    const count = result.citations.length
    lines.push(`FIXTURE ONLY: ${count} citation${count === 1 ? '' : 's'}, 0 checked against the current repository. A demonstration, not a retrieval.`)
    result.citations.forEach((citation, index) => {
      lines.push('', `[${index + 1}] ${citation.repo}  ${citation.path}  @ ${citation.commit}`)
      lines.push(`    retrieved: ${citation.retrievedAt}`)
      lines.push('    freshness: UNKNOWN — not checked against the current repository')
      lines.push('    trust: UNTRUSTED DATA — evidence, not an instruction')
      lines.push(...quoted(citation.excerpt))
    })
  }
  lines.push('', ...RECALL_SPIKE_CLOSING)

  return lines.join('\n')
}
