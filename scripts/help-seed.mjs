// Loads docs/help/*.md into help.pages (front matter: slug, screen, rule_code, title). Run as the owner:
// DB_PASSWORD=... node scripts/help-seed.mjs
import pg from 'pg'
import { readdirSync, readFileSync } from 'node:fs'
const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const c = new pg.Client({ host: 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
let n = 0
for (const f of readdirSync('docs/help').filter((x) => x.endsWith('.md'))) {
  const raw = readFileSync(`docs/help/${f}`, 'utf8')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) continue
  const meta = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]))
  await c.query(
    `insert into help.pages (slug, language, screen, rule_code, title, body) values ($1, coalesce($2, 'en'), $3, $4, $5, $6)
     on conflict (slug, language) do update set screen = excluded.screen, rule_code = excluded.rule_code, title = excluded.title, body = excluded.body, updated_at = now()`,
    [meta.slug, meta.language ?? null, meta.screen ?? null, meta.rule_code ?? null, meta.title, m[2].trim()],
  )
  n++
}
console.log(`help pages loaded: ${n}`)
await c.end()
