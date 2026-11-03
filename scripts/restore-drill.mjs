// Restore drill without Docker (Phase 9). DEV only; synthetic data only.
//  1. Opens one REPEATABLE READ snapshot and takes a logical dump of the key tables (rows as JSON) plus a schema
//     fingerprint (tables, columns, constraints, indexes, policies, function bodies) and row counts of every table in
//     the app schemas, with checksums — all from that same snapshot.
//  2. Restores each dumped table from the files into a temporary copy (CREATE TEMP TABLE … LIKE, inside a transaction
//     that is always rolled back) and checks the restored checksum and row count against the dump-time values.
//  3. Optionally records the drill through the sanctioned RPC api.record_backup_run as the synthetic E2E Admin
//     (--record; needs .env.local and .env.test.local, the same files the Playwright tests use).
// Files go to ./backups/drill-<timestamp>/ (gitignored). Usage: DB_PASSWORD=... node scripts/restore-drill.mjs [--record]
import pg from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'

const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
const APP = ['acct', 'audit', 'core', 'field', 'help', 'hr', 'inv', 'master', 'msg', 'ops', 'prod', 'purch', 'sales']
const KEY_TABLES = ['core.companies', 'core.gstins', 'core.user_roles', 'core.settings', 'master.parties', 'master.products', 'acct.accounts',
  'acct.vouchers', 'acct.gl_entries', 'acct.bill_allocations', 'sales.documents', 'sales.document_lines', 'inv.stock_ledger']
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dir = `backups/drill-${stamp}`
mkdirSync(dir, { recursive: true })
const sha = (s) => createHash('sha256').update(s).digest('hex')
const t0 = Date.now()

const c = new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
const q = async (sql, p) => (await c.query(sql, p)).rows
// Order-independent content checksum of a relation (md5 of the sorted row md5s).
const checksumSql = (rel) => `select count(*)::bigint as n, coalesce(md5(string_agg(h, '' order by h)), md5('')) as sum from (select md5(t::text) h from ${rel} t) x`

const SCHEMA_SQL = `
  select json_build_object(
    'tables', (select json_agg(json_build_object('t', n.nspname || '.' || c.relname, 'rls', c.relrowsecurity,
               'cols', (select json_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end order by a.attnum)
                        from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)) order by 1)
               from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname = any($1)),
    'constraints', (select json_agg(conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) order by 1)
                    from pg_constraint where connamespace = any (select oid from pg_namespace where nspname = any($1))),
    'indexes', (select json_agg(indexdef order by indexdef) from pg_indexes where schemaname = any($1)),
    'policies', (select json_agg(schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') order by 1)
                 from pg_policies where schemaname = any($1)),
    'functions', (select json_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) order by 1)
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('api', 'app')),
    'views', (select json_agg(c.relname || ' ' || md5(pg_get_viewdef(c.oid)) order by 1) from pg_class c where c.relkind = 'v' and c.relnamespace = 'api'::regnamespace)
  ) as s`

// ─── 1. Dump (one snapshot) ───
await q('begin isolation level repeatable read read only')
const schema = await q(SCHEMA_SQL, [APP])
const schemaText = JSON.stringify(schema[0].s, null, 1)
writeFileSync(`${dir}/schema.json`, schemaText)

const allTables = (await q(`select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname = any($1) order by 1`, [APP])).map((r) => r.t)
const counts = {}
for (const t of allTables) counts[t] = Number((await q(`select count(*)::bigint as n from ${t}`))[0].n)
writeFileSync(`${dir}/row-counts.json`, JSON.stringify(counts, null, 1))

const manifest = { taken_at: new Date().toISOString(), project: ref, region: 'ap-south-1', snapshot: 'repeatable read', schema_sha256: sha(schemaText), tables: {} }
let bytes = Buffer.byteLength(schemaText)
for (const t of KEY_TABLES) {
  const [{ n, sum }] = await q(checksumSql(t))
  const [{ j }] = await q(`select coalesce(json_agg(t), '[]'::json)::text as j from ${t} t`)
  writeFileSync(`${dir}/${t}.json`, j)
  bytes += Buffer.byteLength(j)
  manifest.tables[t] = { rows: Number(n), checksum: sum, file_sha256: sha(j) }
}
await q('commit')
writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 1))
const dumpSecs = ((Date.now() - t0) / 1000).toFixed(1)

// ─── 2. Restore into temporary copies and verify (always rolled back) ───
const results = []
await q('begin')
try {
  for (const t of KEY_TABLES) {
    const file = `${dir}/${t}.json`
    const text = readFileSync(file, 'utf8')
    const fileOk = sha(text) === manifest.tables[t].file_sha256
    const tmp = `drill_${t.replace('.', '_')}`
    await q(`create temp table ${tmp} (like ${t}) on commit drop`)
    await q(`insert into ${tmp} select * from json_populate_recordset(null::${t}, $1::json)`, [text])
    const [{ n, sum }] = await q(checksumSql(tmp))
    const ok = fileOk && Number(n) === manifest.tables[t].rows && sum === manifest.tables[t].checksum
    results.push({ table: t, rows: Number(n), file_intact: fileOk, checksum_match: sum === manifest.tables[t].checksum, ok })
  }
} finally {
  await q('rollback')
}
// The schema fingerprint must be reproducible (a restore is checked against it).
await q('begin isolation level repeatable read read only')
const again = sha(JSON.stringify((await q(SCHEMA_SQL, [APP]))[0].s, null, 1))
await q('commit')
await c.end()
const allOk = results.every((r) => r.ok)
const schemaStable = again === manifest.schema_sha256 // false only if a migration landed during the drill
const totalSecs = ((Date.now() - t0) / 1000).toFixed(1)
console.table(results)
console.log(`Dump: ${KEY_TABLES.length} key tables + schema fingerprint + ${allTables.length} row counts, ${(bytes / 1048576).toFixed(1)} MB, ${dumpSecs} s. Restore + verify: ${totalSecs} s total.`)
console.log(`Schema fingerprint sha256 ${manifest.schema_sha256.slice(0, 16)}…  schema re-read ${schemaStable ? 'identical' : 'CHANGED during the drill (a migration ran?)'}  Result: ${allOk ? 'OK' : 'FAILED'}  Files: ${dir}/`)
writeFileSync(`${dir}/result.json`, JSON.stringify({ allOk, schemaStable, results, dumpSecs, totalSecs, bytes }, null, 1))

// ─── 3. Record the drill through the RPC (as the synthetic E2E Admin) ───
if (process.argv.includes('--record')) {
  const env = {}
  for (const f of ['.env.local', '.env.test.local']) if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim()
  }
  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
  const { error: e1 } = await sb.auth.signInWithPassword({ email: env.E2E_ADMIN_EMAIL, password: env.E2E_ADMIN_PASSWORD })
  if (e1) { console.error('sign-in failed:', e1.message); process.exit(1) }
  const { data, error } = await sb.schema('api').rpc('record_backup_run', {
    p_client_request_id: randomUUID(),
    p: {
      kind: 'restore_drill', status: allOk ? 'ok' : 'failed', started_at: new Date(t0).toISOString(), finished_at: new Date().toISOString(),
      location: 'Supabase DEV ap-south-1 (Mumbai) → logical dump on the office laptop (India)', size_bytes: bytes, checksum: manifest.schema_sha256,
      note: `Phase 9 logical restore drill (no Docker): ${KEY_TABLES.length} key tables dumped as JSON from one snapshot, restored into temporary copies, `
        + `row counts and content checksums matched=${allOk}; schema fingerprint + ${allTables.length} table row counts. Not a full database restore (see DEPLOYMENT_GUIDE).`,
    },
  })
  if (error) { console.error('record failed:', error.message); process.exit(1) }
  console.log('Recorded in ops.backup_runs:', data)
  await sb.auth.signOut()
}
process.exit(allOk ? 0 : 1)
