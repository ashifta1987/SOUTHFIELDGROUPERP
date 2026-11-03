// Logical backup of the whole DEV database (app schemas + auth.users without password hashes + storage.objects
// metadata) as gzip'd NDJSON, from ONE repeatable-read snapshot. pg_dump is not available here, so this is the
// same approach as scripts/restore-drill.mjs. Output goes to ./backups/ (git-ignored). DEV only; synthetic data.
// Usage: DB_PASSWORD=... node scripts/dev-backup.mjs
import pg from 'pg'
import { createWriteStream, mkdirSync, statSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { once } from 'node:events'

const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
if (ref !== 'fxwoabbwzcifxzqsmrie') { console.error('DEV project only'); process.exit(2) }
const APP = ['acct', 'audit', 'core', 'field', 'help', 'hr', 'inv', 'master', 'msg', 'ops', 'prod', 'purch', 'sales']
mkdirSync('backups', { recursive: true })
const file = `backups/dev-full-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.gz`
const c = new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
const gz = createGzip(); const out = createWriteStream(file); gz.pipe(out)
const write = async (o) => { if (!gz.write(JSON.stringify(o) + '\n')) await once(gz, 'drain') }
await c.query('begin isolation level repeatable read read only')
const tables = (await c.query(`select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname = any($1) order by 1`, [APP])).rows.map((r) => r.t)
const counts = {}
for (const t of tables.concat(['auth.users', 'auth.identities', 'storage.buckets', 'storage.objects'])) {
  const sel = t === 'auth.users' ? `select to_jsonb(u) - 'encrypted_password' - 'confirmation_token' - 'recovery_token' - 'email_change_token_new' - 'email_change_token_current' - 'reauthentication_token' as j from auth.users u`
    : t === 'auth.identities' ? `select to_jsonb(i) as j from auth.identities i` : `select to_jsonb(x) as j from ${t} x`
  await c.query(`declare cur no scroll cursor for ${sel}`)
  let n = 0
  for (;;) {
    const { rows } = await c.query('fetch 5000 from cur')
    if (!rows.length) break
    for (const r of rows) await write({ t, r: r.j })
    n += rows.length
  }
  await c.query('close cur')
  counts[t] = n
}
await c.query('rollback'); await c.end()
await write({ manifest: { taken_at: new Date().toISOString(), project: ref, counts } })
gz.end(); await once(out, 'finish')
console.log(`backup: ${file} (${(statSync(file).size / 1048576).toFixed(1)} MiB), tables: ${Object.keys(counts).length}, rows: ${Object.values(counts).reduce((a, b) => a + b, 0)}`)
