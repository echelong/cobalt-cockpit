// Test seams: the only way to point Cockpit at stand-ins. Production code never sets them, and no environment
// variable, command-line flag or configuration file reaches them: a test sets them inside its own process
// (test/helpers.ts) or through its own entry point (test/fixtures/cli-under-test.ts), never through the
// shipped launcher.
//   - brokerUpstream: a stand-in for the Cline API, and only on this machine's loopback, named by an IP literal
//     (127.0.0.1 or [::1]; a host name such as localhost could be resolved elsewhere). Production always uses
//     https://api.cline.bot.
//   - clineBin: a stand-in Cline for workers. Like the real one it runs only inside the sandbox, holding only
//     the broker's fake token; it never runs on the host and never sees the person's sign-in.
import { isAbsolute } from 'node:path'

export type Seams = { brokerUpstream: string | null; clineBin: string | null }
const seams: Seams = { brokerUpstream: null, clineBin: null }

/** The current seams (a copy): null means the production behaviour. */
export const testSeams = (): Readonly<Seams> => ({ ...seams })

/** Why `u` is not a loopback origin a test stand-in may use, or null. Judged on the parsed, normalised URL. */
export const loopbackOriginProblem = (u: string): string | null => {
  let url: URL; try { url = new URL(u) } catch { return 'not a URL' }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return 'an origin only (no credentials, path, query or fragment)'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'http or https only'
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') return 'a stand-in must be on loopback, named by 127.0.0.1 or [::1]'
  return null
}

/** Sets test seams (tests only). A brokerUpstream off loopback, or a clineBin that is not an absolute path, is refused. */
export const setTestSeams = (s: Partial<Seams>): void => {
  if (s.brokerUpstream != null) { const why = loopbackOriginProblem(s.brokerUpstream); if (why) throw new Error(`test seam brokerUpstream ${s.brokerUpstream}: ${why}`) }
  if (s.clineBin != null && !isAbsolute(s.clineBin)) throw new Error(`test seam clineBin ${s.clineBin}: an absolute path is required`)
  if (s.brokerUpstream !== undefined) seams.brokerUpstream = s.brokerUpstream === null ? null : new URL(s.brokerUpstream).origin
  if (s.clineBin !== undefined) seams.clineBin = s.clineBin
}
