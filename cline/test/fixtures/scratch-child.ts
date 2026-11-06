// A test process using the scratch manager (scratch.spec.ts drives it). argv[2]: ok | fail | hang.
// Prints its roots and os.tmpdir() as one JSON line, then exits, throws or waits to be signalled.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homeRootDir, homeTmp, tmp, tmpRootDir } from '../scratch.ts'

const a = tmp('child'); writeFileSync(join(a, 'f.txt'), 'x'); homeTmp('canary')
process.stdout.write(`${JSON.stringify({ pid: process.pid, tmpRoot: tmpRootDir(), homeRoot: homeRootDir(), osTmp: tmpdir(), fixture: a })}\n`)
const mode = process.argv[2]
if (mode === 'fail') throw new Error('a failing test process')
if (mode === 'hang') setInterval(() => {}, 60_000)
