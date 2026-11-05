// Runs one mission in its own process so a test can kill the supervisor (crash tests).
// argv[2]: JSON { root, repo, data, tasks, config?, mode: 'create'|'recover', id? }
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Mission } from '../../src/supervisor.ts'
import { config, deps, mission, resolutions } from '../helpers.ts'

const o = JSON.parse(process.argv[2]) as { root: string; repo: string; data: string; tasks?: never; config?: unknown; mode: 'create' | 'recover'; id?: string; out: string }
const c = config(o.config ?? {})
const e = { root: o.root, repo: o.repo, data: o.data }
const m = o.mode === 'create' ? await mission(e, { tasks: o.tasks, config: c }) : Mission.open(o.root, o.id as string, c, await resolutions(c), deps(e))
writeFileSync(join(o.out, 'mission-id'), m.header.id)
const v = await m.run()
writeFileSync(join(o.out, 'verdict.json'), JSON.stringify(v))
process.exit(0)
