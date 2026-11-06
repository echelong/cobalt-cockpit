// The CLI as tests run it in a child process: the production entry (src/cli.ts main) with the test seams set from
// leading arguments, never from the environment. The shipped launcher (bin/cockpit-cline) has no way to set them.
//   cli-under-test.ts --seam-upstream http://127.0.0.1:PORT --seam-cline-bin /abs/fake-cline.mjs -- <cli args>
import { setTestSeams } from '../../src/seams.ts'
import { main } from '../../src/cli.ts'

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
if (sep < 0) { process.stderr.write('cli-under-test: seam arguments must end with --\n'); process.exit(2) }
const seamArgs = argv.slice(0, sep)
for (let i = 0; i < seamArgs.length; i += 2) {
  const [k, v] = [seamArgs[i], seamArgs[i + 1]]
  if (k === '--seam-upstream') setTestSeams({ brokerUpstream: v })
  else if (k === '--seam-cline-bin') setTestSeams({ clineBin: v })
  else { process.stderr.write(`cli-under-test: unknown seam ${k}\n`); process.exit(2) }
}
process.exit(await main(argv.slice(sep + 1)))
