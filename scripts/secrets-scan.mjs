// Secrets scan for CI and laptops (Phase 9). Scans the tracked working tree and the whole git history for:
//   Supabase secret keys (sb_secret_…), service-role JWTs, private keys, Postgres URLs with an inline password,
//   AWS/Google/WhatsApp-style tokens, and — when DB_PASSWORD or SCAN_LITERALS is set in the environment — those exact
//   values. Findings are printed masked (first 4 characters + length), never in full. Exits 1 on any finding.
// Usage: node scripts/secrets-scan.mjs [--no-history] [--no-tree]
import { execFileSync } from 'node:child_process'

const args = new Set(process.argv.slice(2))
const literals = [process.env.DB_PASSWORD, ...(process.env.SCAN_LITERALS ?? '').split(',')].filter((s) => s && s.length >= 8)

const RULES = [
  { id: 'supabase-secret-key', re: /sb_secret_[A-Za-z0-9_-]{16,}/g },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'postgres-url-with-password', re: /postgres(?:ql)?:\/\/[^\s:@'"`/]+:(?!\$\{|\$[A-Z_]|<|\*{3}|password@|PASSWORD@|\[)[^\s@'"`]{6,}@/g, check: (s) => !s.includes('${') && !s.includes('$DB_') },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'meta-access-token', re: /\bEAA[A-Za-z0-9]{60,}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, check: jwtIsSecret },
]
// Files that legitimately mention the patterns (this scanner, docs that describe them).
const ALLOW_FILES = [/^scripts\/secrets-scan\.mjs$/, /^pnpm-lock\.yaml$/]

function jwtIsSecret(tok) {
  try {
    const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'))
    // The legacy anon key is browser-safe by design; anything else (service_role, user sessions, OIDC) is not.
    return payload.role !== 'anon'
  } catch { return true }
}
const mask = (s) => `${s.slice(0, 4)}…(${s.length} chars)`

function scanText(text, where, findings) {
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) {
      if (r.check && !r.check(m[0])) continue
      findings.push({ rule: r.id, where, value: mask(m[0]) })
    }
  }
  for (const lit of literals) if (text.includes(lit)) findings.push({ rule: 'env-literal', where, value: mask(lit) })
}

const git = (a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 })
const findings = []

if (!args.has('--no-tree')) {
  for (const f of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    if (ALLOW_FILES.some((re) => re.test(f))) continue
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip)$/i.test(f)) continue
    let text
    try { text = git(['show', `:${f}`]) } catch { continue }
    scanText(text, `tree:${f}`, findings)
  }
}

if (!args.has('--no-history')) {
  let hist = ''
  try { hist = git(['log', '--all', '-p', '--no-color', '--format=@@COMMIT %H']) } catch { hist = '' }
  let commit = '', file = ''
  for (const line of hist.split('\n')) {
    if (line.startsWith('@@COMMIT ')) { commit = line.slice(9, 17); continue }
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    if (ALLOW_FILES.some((re) => re.test(file))) continue
    scanText(line, `history:${commit}:${file}`, findings)
  }
}

const unique = [...new Map(findings.map((f) => [`${f.rule}|${f.where}|${f.value}`, f])).values()]
if (unique.length) {
  console.log(`✗ ${unique.length} possible secret(s) found (values masked):`)
  console.table(unique)
  console.log('Rotate any real key that was ever committed, then remove it from the tree. History rewrites need the owner\'s approval.')
  process.exit(1)
}
console.log(`✓ no secrets found (${args.has('--no-tree') ? '' : 'tracked tree'}${args.has('--no-tree') || args.has('--no-history') ? '' : ' + '}${args.has('--no-history') ? '' : 'full git history'}${literals.length ? `, plus ${literals.length} literal value(s) from the environment` : ''})`)
