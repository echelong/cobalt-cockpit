// CI preflight (used by .github/workflows/cline-adapter.yml, never by Cockpit itself). Checks, with the adapter's own
// code, that this machine can run the offline suite with real isolation, and stops the job with the reason when it
// cannot. Nothing is skipped or weakened: the same checks gate every worker in production.
//   node --experimental-transform-types --no-warnings --import ./loader/register.mjs test/ci-preflight.ts <cline-version>
//   ... test/ci-preflight.ts --probe     only the sandbox probe (exit 0 when bubblewrap can establish it)
import { bwrapAvailable, trustedBwrap } from '../src/sandbox.ts'
import { loadCatalog, trustedCline } from '../src/catalog.ts'
import { transportProblem } from '../src/broker.ts'

const fail = (why: string): never => { process.stderr.write(`::error title=Cline adapter preflight::${why}\n`); process.exit(1) }
const expectCline = process.argv[2]
if (!expectCline) fail('usage: ci-preflight.ts <expected cline version> | --probe')
if (expectCline === '--probe') {
  const p = await bwrapAvailable()
  process.stdout.write(`sandbox: ${p.ok ? 'OK' : 'FAIL'} ${p.detail}\n`)
  process.exit(p.ok ? 0 : 1)
}

process.stdout.write(`node ${process.version} at ${process.execPath}\n`)
let bwrap = ''
try { bwrap = trustedBwrap() } catch (e) { fail((e as Error).message) }
const bw = await bwrapAvailable()
process.stdout.write(`sandbox: ${bw.ok ? 'OK' : 'FAIL'} ${bw.detail}\n`)
if (!bw.ok) fail(`bubblewrap ${bwrap} cannot establish the sandbox: ${bw.detail}`)
let cline = ''
try { cline = trustedCline().bin } catch (e) { fail((e as Error).message) }
const catalog = await loadCatalog().catch((e: Error) => fail(`the installed Cline catalog cannot be loaded: ${e.message}`))
process.stdout.write(`cline ${catalog.clineVersion} at ${cline} · catalog ${catalog.source}\n`)
if (catalog.clineVersion !== expectCline) fail(`installed Cline is ${catalog.clineVersion}, expected ${expectCline}`)
const unsafe = transportProblem()
if (unsafe) fail(`the credential broker would refuse to run here: ${unsafe}`)
process.stdout.write('preflight: OK\n')
