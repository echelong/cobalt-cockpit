// A node:test file whose only test outlives --test-timeout (scratch.spec.ts runs it). Not part of the suite.
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp, tmpRootDir } from '../scratch.ts'

test('never finishes', async () => {
  writeFileSync(join(tmp('timeout'), 'f.txt'), 'x')
  process.stdout.write(`ROOT=${tmpRootDir()}\n`)
  await new Promise(() => {})
})
