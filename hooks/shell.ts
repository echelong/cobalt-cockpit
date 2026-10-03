// A small reader of shell command text: enough structure to tell which
// program a command runs and with which arguments, so a guard matches what
// would execute and not what is merely quoted (`echo "rm -rf /"`, a commit
// message that mentions `git reset --hard`). Not a shell: it never expands.

export type Simple = {
  /** The words of one command, quotes removed, wrappers still in place. */
  argv: string[]
  /** The command's own text in the source. */
  raw: string
  /** Files written by `>` and `>>`. */
  writes: string[]
  /** The body of a here-document fed to it, when it has one. */
  heredoc: string | null
}

export type Connector = '&&' | '||' | ';' | '&' | null

export type Pipeline = {
  commands: Simple[]
  raw: string
  /** What joins this pipeline to the next one; null on the last. */
  next: Connector
}

export type Parsed = {
  pipelines: Pipeline[]
  /** The bodies of `$(...)` and backtick substitutions, to read in turn. */
  substitutions: string[]
  hasPipefail: boolean
}

type Item =
  | { kind: 'word'; text: string; start: number; end: number }
  | { kind: 'op'; text: string; start: number; end: number }

const OPERATORS = ['&&', '||', ';;', '|&', '&>>', '&>', '<<<', '<<-', '<<', '>>', '>|', ';', '|', '&', '(', ')', '<', '>']

const closing = (source: string, from: number): number => {
  // the index of the `)` matching the `$(` whose body starts at `from`
  let depth = 1
  for (let i = from; i < source.length; i++) {
    const char = source[i]
    if (char === '\\') i++
    else if (char === "'") {
      const end = source.indexOf("'", i + 1)
      i = end < 0 ? source.length : end
    } else if (char === '"') {
      i++
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1
    } else if (char === '<' && source[i + 1] === '<' && source[i + 2] !== '<') {
      // a here-document's body is text: its quotes and parentheses close nothing
      const doc = /^<<-?[ \t]*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(source.slice(i))
      if (doc !== null) {
        const body = source.indexOf('\n', i)
        const end = new RegExp(`\\n\\t*${(doc[2] as string).replace(/[.]/g, '\\.')}[ \\t]*(\\n|$)`).exec(
          body < 0 ? '' : source.slice(body),
        )
        if (body >= 0 && end !== null) i = body + end.index + end[0].length - 1
        else i += doc[0].length - 1
      }
    } else if (char === '(') depth++
    else if (char === ')' && --depth === 0) return i
  }

  return source.length
}

const scan = (source: string, substitutions: string[]): { items: Item[]; heredocs: Map<number, string> } => {
  const items: Item[] = []
  const heredocs = new Map<number, string>()
  const pending: { delimiter: string; isIndented: boolean; item: number }[] = []
  let word = ''
  let hasWord = false
  let wordStart = 0
  let i = 0

  const endWord = (end: number) => {
    if (hasWord) items.push({ kind: 'word', text: word, start: wordStart, end })
    word = ''
    hasWord = false
  }
  const begin = () => {
    if (!hasWord) wordStart = i
    hasWord = true
  }
  const substitution = (body: string) => {
    if (body.trim() !== '') substitutions.push(body)
  }

  while (i < source.length) {
    const char = source[i] as string

    if (char === '\n') {
      endWord(i)
      items.push({ kind: 'op', text: ';', start: i, end: i + 1 })
      i++
      // the lines that follow are the pending here-documents' bodies
      while (pending.length > 0) {
        const doc = pending.shift() as { delimiter: string; isIndented: boolean; item: number }
        const lines: string[] = []
        while (i < source.length) {
          const eol = source.indexOf('\n', i)
          const line = source.slice(i, eol < 0 ? source.length : eol)
          i = eol < 0 ? source.length : eol + 1
          if ((doc.isIndented ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
          lines.push(line)
        }
        heredocs.set(doc.item, lines.join('\n'))
      }
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord(i)
      i++
      continue
    }
    if (char === '#' && !hasWord) {
      const eol = source.indexOf('\n', i)
      i = eol < 0 ? source.length : eol
      continue
    }
    if (char === '\\') {
      if (source[i + 1] === '\n') {
        i += 2
        continue
      }
      begin()
      word += source[i + 1] ?? ''
      i += 2
      continue
    }
    if (char === "'") {
      begin()
      const end = source.indexOf("'", i + 1)
      word += source.slice(i + 1, end < 0 ? source.length : end)
      i = end < 0 ? source.length : end + 1
      continue
    }
    if (char === '"') {
      begin()
      i++
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && /["\\$`\n]/.test(source[i + 1] ?? '')) {
          word += source[i + 1] === '\n' ? '' : source[i + 1]
          i += 2
        } else if (source[i] === '$' && source[i + 1] === '(') {
          const end = closing(source, i + 2)
          substitution(source.slice(i + 2, end))
          word += source.slice(i, end + 1)
          i = end + 1
        } else {
          word += source[i]
          i++
        }
      }
      i++
      continue
    }
    if (char === '$' && source[i + 1] === '(') {
      begin()
      const end = closing(source, i + 2)
      substitution(source.slice(i + 2, end))
      word += source.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (char === '`') {
      begin()
      const end = source.indexOf('`', i + 1)
      const stop = end < 0 ? source.length : end
      substitution(source.slice(i + 1, stop))
      word += source.slice(i, stop + 1)
      i = stop + 1
      continue
    }

    const operator = OPERATORS.find(one => source.startsWith(one, i))
    if (operator !== undefined) {
      const isRedirect = operator.includes('<') || operator.includes('>')
      // `2>` and `1>>`: the digits before a redirection name a descriptor
      if (isRedirect && hasWord && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      } else {
        endWord(i)
      }
      const start = i
      i += operator.length
      if (isRedirect && source[i] === '&') {
        // `>&2`, `2>&1`: a descriptor copy, no file
        i++
        while (i < source.length && /[\d-]/.test(source[i] as string)) i++
        continue
      }
      if (operator === '<<' || operator === '<<-') {
        while (source[i] === ' ' || source[i] === '\t') i++
        const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(source.slice(i))
        if (match !== null) {
          pending.push({ delimiter: match[2] as string, isIndented: operator === '<<-', item: items.length })
          i += match[0].length
        }
        items.push({ kind: 'op', text: '<<', start, end: i })
        continue
      }
      items.push({ kind: 'op', text: operator, start, end: i })
      continue
    }

    begin()
    word += char
    i++
  }
  endWord(i)

  return { items, heredocs }
}

/** Reads a command line into pipelines of simple commands. */
export const parseShell = (source: string): Parsed => {
  const substitutions: string[] = []
  const { items, heredocs } = scan(source, substitutions)
  const pipelines: Pipeline[] = []
  let commands: Simple[] = []
  let current: Simple | null = null
  let commandStart = 0
  let pipelineStart = 0
  let redirect: string | null = null

  const endCommand = (end: number) => {
    if (current !== null && (current.argv.length > 0 || current.writes.length > 0)) {
      current.raw = source.slice(commandStart, end).trim()
      commands.push(current)
    }
    current = null
  }
  const endPipeline = (end: number, next: Connector) => {
    endCommand(end)
    if (commands.length > 0) {
      pipelines.push({ commands, raw: source.slice(pipelineStart, end).trim(), next })
    } else if (next !== null && pipelines.length > 0) {
      const last = pipelines[pipelines.length - 1] as Pipeline
      if (last.next === null) last.next = next
    }
    commands = []
  }
  const open = (start: number): Simple => {
    if (current === null) {
      if (commands.length === 0) pipelineStart = start
      commandStart = start
      current = { argv: [], raw: '', writes: [], heredoc: null }
    }

    return current
  }

  items.forEach((item, index) => {
    if (item.kind === 'word') {
      const command = open(item.start)
      if (redirect !== null) {
        if (redirect.includes('>')) command.writes.push(item.text)
        redirect = null
      } else {
        command.argv.push(item.text)
      }

      return
    }
    redirect = null
    switch (item.text) {
      case '|':
      case '|&':
        endCommand(item.start)
        break
      case '&&':
      case '||':
      case '&':
        endPipeline(item.start, item.text)
        break
      case ';':
      case ';;':
      case '(':
      case ')':
        endPipeline(item.start, ';')
        break
      case '<<': {
        const body = heredocs.get(index)
        open(item.start).heredoc = body ?? ''
        break
      }
      default:
        open(item.start)
        redirect = item.text
    }
  })
  endPipeline(source.length, null)
  if (pipelines.length > 0) (pipelines[pipelines.length - 1] as Pipeline).next = null

  return {
    pipelines,
    substitutions,
    hasPipefail: /\bset\s+-[A-Za-z]*o\s+pipefail\b/.test(source),
  }
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time'])
/** Wrappers that run the command after them, and how many values their flags take. */
const WRAPPERS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  nohup: [],
  command: [],
  builtin: [],
  exec: ['-a'],
  stdbuf: ['-i', '-o', '-e'],
  setsid: [],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a'],
}

export type Unwrapped = {
  /** The program's name without its directory. */
  program: string
  /** Its arguments. */
  args: string[]
  /** The wrappers it ran under, outermost first (`sudo`, `xargs`). */
  wrappers: string[]
}

/** Strips assignments, shell keywords and wrappers down to the program run. */
export const unwrap = (argv: readonly string[]): Unwrapped | null => {
  let words = [...argv]
  const wrappers: string[] = []
  for (let guard = 0; guard < 8; guard++) {
    while (words.length > 0 && (ASSIGNMENT.test(words[0] as string) || KEYWORDS.has(words[0] as string))) {
      words = words.slice(1)
    }
    const head = words[0]
    if (head === undefined) return null
    const name = basename(head)
    const valued = WRAPPERS[name]
    if (valued === undefined) return { program: name, args: words.slice(1), wrappers }
    // `command -v tsc` looks a program up; it runs nothing
    if (name === 'command' && /^-[vV]+$/.test(words[1] ?? '')) return { program: name, args: words.slice(1), wrappers }
    wrappers.push(name)
    let at = 1
    while (at < words.length) {
      const word = words[at] as string
      if (word === '--') {
        at++
        break
      }
      if (!word.startsWith('-')) break
      at += valued.includes(word) ? 2 : 1
    }
    // `timeout 30 cmd`: the duration is the first operand
    if (name === 'timeout' && at < words.length) at++
    // `env VAR=1 cmd`: assignments are stripped on the next pass
    words = words.slice(at)
  }

  return null
}

export { basename }
