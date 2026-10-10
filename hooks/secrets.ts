// One list of credential shapes, shared by every place Cockpit keeps or sends
// free text. It is a list of shapes, not a proof: a credential that matches no
// shape here is not caught. See PRIVACY.md.
const PRIVATE_KEY = '-----BEGIN [A-Z ]{0,20}PRIVATE KEY'
// a name that says secret, then a value (no leading wildcard: it would make long runs quadratic): api_key=…, SECRET_KEY: …, db-password = …, authToken=…
const NAMED_VALUE = '(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|credential|private[_-]?key|access[_-]?key|session[_-]?key|authorization|auth[_-]?(?:token|key|secret))[A-Za-z0-9_.-]{0,40}["\']?\\s*[=:]\\s*["\']?[^\\s"\']{3,}'
const SAID_IN_WORDS = '\\b(?:password|passphrase|passcode|secret|token|api\\s+key)\\s+(?:is|was)\\s+\\S+'
// inside a URL, on a command line, or a webhook that is itself the secret
const URL_USERINFO = '\\b[a-z][a-z0-9+.-]{0,20}:\\/\\/[^\\s\\/@:]{0,64}:[^\\s\\/@]{1,128}@'
const CLI_USER = '(?:^|\\s)(?:-u|--user)\\s+\\S+:\\S+'
const WEBHOOK = 'hooks\\.slack\\.com\\/services\\/'
const BEARER = '\\bBearer\\s+[A-Za-z0-9._~+\\/-]{8,}'
const PREFIXED = '\\b(?:sk-|sk_live_|sk_test_|rk_live_|pk_live_|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|xox[abeprs]-|npm_|hf_|re_|rnd_)[A-Za-z0-9_-]{8,}'
const JWT = '\\beyJ[A-Za-z0-9_-]{1,1024}\\.[A-Za-z0-9_-]{1,1024}\\.[A-Za-z0-9_-]{1,1024}'
// a long unbroken run of letters and digits: a key or a digest, whatever it is called
const LONG_RUN = '(?<![A-Za-z0-9+_=-])(?=[A-Za-z0-9+_=-]*[0-9])(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}'

const ANY_CASE = [PRIVATE_KEY, NAMED_VALUE, SAID_IN_WORDS, URL_USERINFO, CLI_USER, WEBHOOK, BEARER, PREFIXED, JWT]
// AWS long-term (AKIA), temporary (ASIA) and the other documented key-ID kinds
const AWS_KEY_ID = '\\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\\b'
const EXACT_CASE = [AWS_KEY_ID, '\\bAIza[A-Za-z0-9_-]{20,}',
  // forty characters of mixed-case base64: the shape of a cloud secret key
  '(?<![A-Za-z0-9+\\/])(?=[A-Za-z0-9+\\/]{40}(?![A-Za-z0-9+\\/]))(?=[A-Za-z0-9+\\/]*[a-z])(?=[A-Za-z0-9+\\/]*[A-Z])(?=[A-Za-z0-9+\\/]*[0-9])[A-Za-z0-9+\\/]{40}']
// a line of a pasted .env: NAME=value
const ENV_LINE = '\\b[A-Z][A-Z0-9_]{2,}=\\S{6,}'

const build = (any: readonly string[], exact: readonly string[], flags: string): RegExp[] => [new RegExp(any.join('|'), `${flags}i`), new RegExp(exact.join('|'), flags)]
/** Shapes a stored snapshot or text is judged by: named values, known prefixes, key IDs, private keys. */
const NARROW = build(ANY_CASE, EXACT_CASE, '')
/** Everything a prompt shown to an outside router is judged by: the narrow shapes, .env lines and long runs. */
const BROAD = build([...ANY_CASE, LONG_RUN], [...EXACT_CASE, ENV_LINE], '')
const REDACT = build(ANY_CASE.slice(1), [...EXACT_CASE, ENV_LINE], 'g')
// a private key is replaced from its header through its END line (or the end of the text): the body is the secret
const PEM = new RegExp(`${PRIVATE_KEY}[\\s\\S]*?(?:-----END [A-Z ]{0,20}PRIVATE KEY-----|$)`, 'g')
/** No text longer than this is scanned: every stored field is cut well below it, and anything longer is withheld. */
export const SCAN_MAX = 20_000

/** Whether text carries a credential shape that is stored or shown as is (no long-run or .env heuristics). */
export const secretText = (text: string): boolean => text.length > 4 * SCAN_MAX || NARROW.some(re => re.test(text))
/** The broad test for a prompt that would leave the machine: any match withholds it. */
export const carriesCredential = (text: string): boolean => text.length > SCAN_MAX || BROAD.some(re => re.test(text))
export const REDACTED = '[redacted]'
/** Text with each credential-shaped span replaced; useful state around it is kept. Not a guarantee. */
export const redactSecrets = (text: string): string => REDACT.reduce((out, re) => out.replace(re, REDACTED), text.slice(0, SCAN_MAX).replace(PEM, REDACTED))
