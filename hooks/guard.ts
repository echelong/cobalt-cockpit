// The blast-radius guard: which commands are genuinely destructive, and what
// each would do. It reads the command's structure (shell.ts), so ordinary
// development commands, and destructive text that is only quoted, pass.

import type { GuardFinding } from '../types'
import { basename, parseShell, unwrap } from './shell'
import type { Pipeline, Simple } from './shell'

export type GuardContext = {
  /** The session's working directory; deletes beneath it are the project's own. */
  cwd?: string
  home?: string
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const TEMP_ROOTS = ['/tmp/', '/var/tmp/', '/dev/shm/', '$TMPDIR/', '${TMPDIR}/']
const PRODUCTION = /\bprod(uction)?\b/i

const finding = (rule: string, title: string, effect: string): GuardFinding => ({ rule, title, effect })

/** True when a short-flag cluster (`-fdx`) or a long flag carries the letter or name. */
const hasFlag = (args: readonly string[], letter: string, ...long: string[]): boolean =>
  args.some(arg => {
    if (arg === '--') return false
    if (arg.startsWith('--')) return long.some(name => arg === name || arg.startsWith(`${name}=`))

    return letter !== '' && /^-[A-Za-z]+$/.test(arg) && arg.includes(letter)
  })

const operands = (args: readonly string[]): string[] => {
  const dashes = args.indexOf('--')
  const before = dashes < 0 ? args : args.slice(0, dashes)
  const after = dashes < 0 ? [] : args.slice(dashes + 1)

  return [...before.filter(arg => !arg.startsWith('-')), ...after]
}

/** Why deleting `target` recursively reaches past the project, or null. */
const broadTarget = (target: string, context: GuardContext): string | null => {
  const path = target.length > 1 ? target.replace(/\/+$/, '') : target
  if (path === '' || path === '/' || path === '/*') return 'the filesystem root'
  if (/^(~|\$HOME|\$\{HOME\})(\/\*)?$/.test(path)) return 'your home directory'
  if (path === '.' || path === './*' || path === '*' || path === '.*' || path === './.*') {
    return 'everything in the working directory'
  }
  if (path === '..' || path.startsWith('../')) return 'a directory outside the working directory'
  if (path === '.git' || path.endsWith('/.git')) return 'the repository itself (.git)'
  // `$DIR/` and `$DIR/*`: with the variable unset this is `/` or `/*`
  if (/^\$(\{\w+\}|\w+)(\/\*?)?$/.test(target) && /\/\*?$/.test(target)) {
    return `whatever ${target} expands to (the filesystem root if the variable is unset)`
  }
  const isAbsolute = path.startsWith('/') || path.startsWith('~') || /^\$(\{HOME\}|HOME)\b/.test(path)
  if (!isAbsolute) return null
  if (TEMP_ROOTS.some(root => `${path}/`.startsWith(root))) return null
  const home = context.home
  const expanded =
    home === undefined ? path : path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home)
  const cwd = context.cwd?.replace(/\/+$/, '')
  if (cwd !== undefined && cwd !== '' && cwd !== '/') {
    if (expanded === cwd) return 'the whole working directory'
    if (expanded.startsWith(`${cwd}/`)) return null
  }

  return `${target}, outside the working directory`
}

const gitCommand = (args: readonly string[]): { sub: string; rest: string[] } | null => {
  let at = 0
  while (at < args.length) {
    const arg = args[at] as string
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
      at += 2
    } else if (arg.startsWith('-')) {
      at += 1
    } else {
      return { sub: arg, rest: args.slice(at + 1) }
    }
  }

  return null
}

const assessGit = (args: readonly string[]): GuardFinding[] => {
  const command = gitCommand(args)
  if (command === null) return []
  const { sub, rest } = command
  const found: GuardFinding[] = []

  if (sub === 'reset' && hasFlag(rest, '', '--hard')) {
    const target = operands(rest)[0] ?? 'HEAD'
    found.push(
      finding(
        'git-reset-hard',
        'git reset --hard',
        `Moves the branch to ${target} and discards every uncommitted change to tracked files. Git keeps no copy of them.`,
      ),
    )
  }
  if (sub === 'clean' && hasFlag(rest, 'f', '--force') && !hasFlag(rest, 'n', '--dry-run') && !hasFlag(rest, 'i', '--interactive')) {
    const extras = [
      hasFlag(rest, 'd') ? 'untracked directories' : '',
      hasFlag(rest, 'x') ? 'ignored files too (build output, .env, dependencies)' : '',
      hasFlag(rest, 'X') ? 'ignored files only' : '',
    ].filter(Boolean)
    found.push(
      finding(
        'git-clean',
        'git clean',
        `Permanently deletes untracked files${extras.length > 0 ? `, ${extras.join(', ')}` : ''}. They are not in git and cannot be restored.`,
      ),
    )
  }
  if (sub === 'push') {
    const refs = operands(rest)
    const where = refs.length > 0 ? refs.join(' ') : 'the upstream branch'
    const isForced = hasFlag(rest, 'f', '--force', '--force-with-lease', '--force-if-includes', '--mirror')
    const isLease = hasFlag(rest, '', '--force-with-lease') && !hasFlag(rest, 'f', '--force')
    const forcedRef = refs.slice(1).find(ref => ref.startsWith('+'))
    const deleted = refs.slice(1).find(ref => ref.startsWith(':'))
    if (isForced || forcedRef !== undefined) {
      found.push(
        finding(
          'git-force-push',
          isLease ? 'git push --force-with-lease' : 'git push --force',
          isLease
            ? `Overwrites ${where} on the remote unless it moved since your last fetch. Remote commits missing locally are dropped.`
            : `Overwrites ${where} on the remote. Commits there that are not in your local branch are lost for everyone.`,
        ),
      )
    }
    if (hasFlag(rest, 'd', '--delete') || deleted !== undefined) {
      found.push(finding('git-push-delete', 'git push --delete', `Deletes ${where} on the remote.`))
    }
  }
  if (sub === 'checkout' || sub === 'restore') {
    const paths = operands(rest)
    const isWholeTree = paths.includes('.') || paths.includes(':/')
    const isStagedOnly = sub === 'restore' && hasFlag(rest, 'S', '--staged') && !hasFlag(rest, 'W', '--worktree')
    const isForced = sub === 'checkout' && hasFlag(rest, 'f', '--force')
    if ((isWholeTree && !isStagedOnly) || isForced) {
      found.push(
        finding(
          'git-discard',
          `git ${sub} ${isForced ? '--force' : '.'}`,
          'Discards uncommitted changes to tracked files in the working tree. Git keeps no copy of them.',
        ),
      )
    }
  }
  if (sub === 'stash' && rest[0] === 'clear') {
    found.push(finding('git-stash-clear', 'git stash clear', 'Deletes every stash entry.'))
  }
  if (sub === 'filter-branch' || sub === 'filter-repo') {
    found.push(finding('git-rewrite', `git ${sub}`, 'Rewrites the repository history: every rewritten commit gets a new id.'))
  }

  return found
}

const assessDelete = (program: string, args: readonly string[], wrappers: readonly string[], context: GuardContext): GuardFinding[] => {
  if (program !== 'rm') return []
  const isRecursive = hasFlag(args, 'r', '--recursive') || hasFlag(args, 'R')
  if (!isRecursive) return []
  if (hasFlag(args, '', '--no-preserve-root')) {
    return [finding('rm-root', 'rm --no-preserve-root', 'Recursively deletes from the filesystem root.')]
  }
  const targets = operands(args)
  if (wrappers.includes('xargs')) {
    return [finding('rm-xargs', 'xargs rm -r', 'Recursively deletes every path piped in; the list is not visible in the command.')]
  }

  return targets
    .map(target => ({ target, reason: broadTarget(target, context) }))
    .filter((one): one is { target: string; reason: string } => one.reason !== null)
    .map(one => finding('rm-recursive', `rm -r ${one.target}`, `Recursively deletes ${one.reason}. This cannot be undone.`))
}

const assessDisk = (program: string, args: readonly string[], command: Simple): GuardFinding[] => {
  const device = /^\/dev\/(sd|nvme|vd|hd|mmcblk|disk|mapper\/)/
  if (program.startsWith('mkfs') || program === 'wipefs') {
    return [finding('disk', program, 'Destroys the filesystem on the target device.')]
  }
  if (program === 'dd' && args.some(arg => arg.startsWith('of=') && device.test(arg.slice(3)))) {
    return [finding('disk', 'dd to a disk', 'Overwrites a block device directly.')]
  }
  if (program === 'shred' && args.some(arg => device.test(arg))) {
    return [finding('disk', 'shred a disk', 'Overwrites a block device with noise.')]
  }
  if (command.writes.some(path => device.test(path))) {
    return [finding('disk', 'write to a disk', 'Redirects output onto a block device.')]
  }
  if ((program === 'chmod' || program === 'chown') && hasFlag(args, 'R', '--recursive')) {
    const target = operands(args).slice(1).find(path => /^(\/|~|\$HOME|\$\{HOME\})\/?$/.test(path))
    if (target !== undefined) {
      return [finding('perm', `${program} -R ${target}`, `Changes ownership or permissions of everything under ${target}.`)]
    }
  }

  return []
}

const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'duckdb', 'clickhouse-client', 'cockroach', 'cqlsh', 'bq', 'snowsql', 'turso'])
const DESTRUCTIVE_SQL = /\b(drop\s+(database|schema|table|keyspace)|truncate\s+(table\s+)?[\w"`.[]+)/i
const UNBOUNDED_DELETE = /\bdelete\s+from\s+[\w`.[\]]+\s*(;|$|["'])/i

const assessSql = (pipeline: Pipeline): GuardFinding[] => {
  const client = pipeline.commands
    .map(command => unwrap(command.argv))
    .find(run => run !== null && SQL_CLIENTS.has(run.program))
  if (client === undefined || client === null) return []
  const text = [pipeline.raw, ...pipeline.commands.map(command => command.heredoc ?? '')].join('\n')
  const dropped = DESTRUCTIVE_SQL.exec(text)
  if (dropped !== null) {
    return [finding('sql-drop', `${client.program}: ${dropped[0].replace(/\s+/g, ' ')}`, 'Drops or empties database objects. The data is gone unless a backup exists.')]
  }
  if (UNBOUNDED_DELETE.test(text)) {
    return [finding('sql-delete', `${client.program}: DELETE without WHERE`, 'Deletes every row of the table.')]
  }

  return []
}

/** Database tools whose named subcommand drops or resets a database. */
const DB_RESETS: readonly { tool: RegExp; action: RegExp; title: string }[] = [
  { tool: /^prisma$/, action: /\bmigrate reset\b|\bdb push\b.*--force-reset/, title: 'prisma reset' },
  { tool: /^(rails|rake)$/, action: /\bdb:(drop|reset|purge|migrate:reset|schema:load)\b/, title: 'rails db reset' },
  { tool: /^manage\.py$/, action: /^(flush|reset_db)\b/, title: 'django flush' },
  { tool: /^artisan$/, action: /^(migrate:fresh|migrate:reset|db:wipe)\b/, title: 'artisan database wipe' },
  { tool: /^(sequelize|sequelize-cli)$/, action: /\bdb:drop\b|\bdb:migrate:undo:all\b/, title: 'sequelize drop' },
  { tool: /^typeorm$/, action: /\bschema:drop\b/, title: 'typeorm schema:drop' },
  { tool: /^knex$/, action: /\bmigrate:rollback\b.*--all/, title: 'knex rollback --all' },
  { tool: /^drizzle-kit$/, action: /^drop\b/, title: 'drizzle-kit drop' },
  { tool: /^alembic$/, action: /\bdowngrade base\b/, title: 'alembic downgrade base' },
  { tool: /^supabase$/, action: /^db reset\b|^projects delete\b/, title: 'supabase reset' },
  { tool: /^mix$/, action: /^ecto\.(drop|reset)\b/, title: 'ecto drop' },
  { tool: /^diesel$/, action: /^database reset\b/, title: 'diesel database reset' },
  { tool: /^sqlx$/, action: /^database (drop|reset)\b/, title: 'sqlx database drop' },
  { tool: /^flyway$/, action: /\bclean\b/, title: 'flyway clean' },
  { tool: /^liquibase$/, action: /\bdrop-?all\b/i, title: 'liquibase dropAll' },
  { tool: /^dotnet$/, action: /^ef database drop\b/, title: 'dotnet ef database drop' },
  { tool: /^dropdb$/, action: /.?/, title: 'dropdb' },
  { tool: /^mysqladmin$/, action: /\bdrop\b/, title: 'mysqladmin drop' },
  { tool: /^redis-cli$/, action: /\bflush(all|db)\b/i, title: 'redis flush' },
  { tool: /^(mongosh|mongo)$/, action: /dropDatabase\s*\(|\.drop\s*\(|deleteMany\s*\(\s*\{\s*\}\s*\)/, title: 'mongo drop' },
]

/** Infrastructure tools whose named subcommand tears resources down. */
const TEARDOWNS: readonly { tool: RegExp; action: RegExp; title: string; effect: string }[] = [
  { tool: /^(terraform|tofu|terragrunt)$/, action: /^destroy\b|\bapply\b.*-destroy\b|^run-all destroy\b/, title: 'terraform destroy', effect: 'Destroys the infrastructure this configuration manages.' },
  { tool: /^pulumi$/, action: /^destroy\b|^stack rm\b/, title: 'pulumi destroy', effect: 'Destroys the resources of the stack.' },
  { tool: /^helm$/, action: /^(uninstall|delete)\b/, title: 'helm uninstall', effect: 'Removes the release and the resources it created.' },
  { tool: /^(docker|podman)$/, action: /^system prune\b.*(\s-\w*a\w*\b|--all\b|--volumes\b)|^volume (rm|prune)\b|^compose down\b.*(\s-v\b|--volumes\b)/, title: 'docker volume/system prune', effect: 'Deletes containers, images or volumes, including the data in them.' },
  { tool: /^docker-compose$/, action: /^down\b.*(\s-v\b|--volumes\b)/, title: 'docker-compose down -v', effect: 'Stops the stack and deletes its volumes, including the data in them.' },
  { tool: /^aws$/, action: /\bs3 rb\b|\bs3 rm\b.*--recursive|\s(delete|terminate|destroy|purge|deregister)-[a-z-]+/, title: 'aws delete', effect: 'Deletes cloud resources in the AWS account.' },
  { tool: /^(gcloud|az|doctl|oci)$/, action: /\b(delete|destroy|purge)\b/, title: 'cloud resource delete', effect: 'Deletes cloud resources in the account.' },
  { tool: /^gsutil$/, action: /^(-m )?rm\b.*-r\b|^rb\b/, title: 'gsutil rm -r', effect: 'Deletes bucket contents or the bucket.' },
  { tool: /^heroku$/, action: /^(apps:destroy|pg:reset|addons:destroy)\b/, title: 'heroku destroy', effect: 'Destroys the app, add-on or database.' },
  { tool: /^(fly|flyctl)$/, action: /\bdestroy\b/, title: 'fly destroy', effect: 'Destroys the app, machine or volume.' },
  { tool: /^vercel$/, action: /^(remove|rm)\b/, title: 'vercel remove', effect: 'Removes the deployment or project.' },
  { tool: /^netlify$/, action: /^sites:delete\b/, title: 'netlify sites:delete', effect: 'Deletes the site.' },
  { tool: /^firebase$/, action: /^(firestore:delete|database:remove|projects:delete|hosting:disable)\b/, title: 'firebase delete', effect: 'Deletes production data or disables hosting.' },
  { tool: /^wrangler$/, action: /\bdelete\b/, title: 'wrangler delete', effect: 'Deletes the Worker, database, bucket or namespace.' },
  { tool: /^gh$/, action: /^repo delete\b/, title: 'gh repo delete', effect: 'Deletes the GitHub repository.' },
  { tool: /^(npm|pnpm|yarn)$/, action: /^unpublish\b/, title: 'npm unpublish', effect: 'Removes the published package version for everyone.' },
]

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'pnpm', 'yarn', 'bun', 'npm', 'bundle', 'poetry', 'uv', 'pipenv', 'python', 'python3', 'php', 'node', 'exec', 'run', 'dlx', 'x', 'bin/rails', 'bin/rake'])

/** The tool a command runs once package runners are stripped, with its arguments as text. */
const toolOf = (program: string, args: readonly string[]): { tool: string; action: string }[] => {
  const words = [program, ...args]
  const candidates: { tool: string; action: string }[] = []
  for (let at = 0; at < Math.min(words.length, 5); at++) {
    const word = words[at] as string
    candidates.push({ tool: basename(word), action: words.slice(at + 1).join(' ') })
    if (!RUNNERS.has(word) && !RUNNERS.has(basename(word)) && !word.startsWith('-')) break
  }

  return candidates
}

const assessTools = (program: string, args: readonly string[]): GuardFinding[] => {
  const found: GuardFinding[] = []
  for (const { tool, action } of toolOf(program, args)) {
    for (const rule of DB_RESETS) {
      if (rule.tool.test(tool) && rule.action.test(action)) {
        found.push(finding('db-reset', rule.title, 'Drops or resets a database: its data is gone unless a backup exists.'))
      }
    }
    for (const rule of TEARDOWNS) {
      if (rule.tool.test(tool) && rule.action.test(action)) found.push(finding('teardown', rule.title, rule.effect))
    }
    if (/^(kubectl|oc)$/.test(tool) && /(^|\s)delete\b/.test(action)) {
      const isWide = /--all\b|\s-A\b|--all-namespaces\b|\b(namespace|namespaces|ns|pv|pvc|crd|node|nodes)\b|\s-f\b|--filename\b/.test(` ${action}`)
      if (isWide || PRODUCTION.test(action)) {
        found.push(finding('teardown', 'kubectl delete', 'Deletes cluster resources; workloads and their data can go with them.'))
      }
    }
  }

  return found
}

const assessFind = (program: string, args: readonly string[], context: GuardContext): GuardFinding[] => {
  if (program !== 'find') return []
  const isDeleting = args.includes('-delete') || args.some((arg, index) => arg === '-exec' && basename(args[index + 1] ?? '') === 'rm')
  if (!isDeleting) return []
  const roots = args.slice(0, Math.max(0, args.findIndex(arg => arg.startsWith('-'))))
  const broad = roots
    .filter(root => root !== '.' && !root.startsWith('./'))
    .map(root => broadTarget(root, context))
    .find(reason => reason !== null)

  return broad === undefined || broad === null
    ? []
    : [finding('find-delete', 'find -delete', `Deletes every match under ${broad}.`)]
}

const SSH_VALUED = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'])

/** What an `ssh host command...` runs on the other side. */
const remoteCommand = (args: readonly string[]): string => {
  let at = 0
  while (at < args.length && (args[at] as string).startsWith('-')) {
    at += SSH_VALUED.has(args[at] as string) ? 2 : 1
  }

  return args.slice(at + 1).join(' ')
}

const assessText = (source: string, context: GuardContext, depth: number): GuardFinding[] => {
  if (depth > 3 || source.trim() === '') return []
  const parsed = parseShell(source)
  const found: GuardFinding[] = []

  for (const pipeline of parsed.pipelines) {
    found.push(...assessSql(pipeline))
    for (const command of pipeline.commands) {
      const run = unwrap(command.argv)
      if (run === null) continue
      const { program, args, wrappers } = run
      if (program === 'git') found.push(...assessGit(args))
      found.push(...assessDelete(program, args, wrappers, context))
      found.push(...assessDisk(program, args, command))
      found.push(...assessFind(program, args, context))
      found.push(...assessTools(program, args))

      // a script handed to a shell, locally or on another host, is read too
      if (program === 'eval') found.push(...assessText(args.join(' '), context, depth + 1))
      if (SHELLS.has(program)) {
        // `-c`, and clusters that end in it (`-lc`)
        const flag = args.findIndex(arg => /^-[A-Za-z]*c$/.test(arg))
        if (flag >= 0) found.push(...assessText(args[flag + 1] ?? '', context, depth + 1))
        if (command.heredoc !== null) found.push(...assessText(command.heredoc, context, depth + 1))
      }
      if (program === 'ssh') found.push(...assessText(remoteCommand(args), {}, depth + 1))
    }
  }
  for (const body of parsed.substitutions) found.push(...assessText(body, context, depth + 1))

  return found
}

/** Every destructive effect of a command line, each rule reported once. */
export const assessCommand = (command: string, context: GuardContext = {}): GuardFinding[] => {
  const seen = new Set<string>()
  const found = assessText(command, context, 0).filter(one => {
    const key = `${one.rule}:${one.title}`
    if (seen.has(key)) return false
    seen.add(key)

    return true
  })
  if (found.length > 0 && PRODUCTION.test(command)) {
    found.push(finding('production', 'production target', 'The command names production.'))
  }

  return found
}
