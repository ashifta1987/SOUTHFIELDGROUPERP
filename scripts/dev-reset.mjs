// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// DEV-ONLY RESET of the Southfield ERP database. NEVER run this on production. See docs/DEV_RESET.md.
//
// Ledgers and audit are append-only by design (triggers refuse update/delete/truncate). This is a sanctioned,
// owner-authorised admin operation that empties a DEV database of synthetic data. It runs in ONE transaction and uses
// `set local session_replication_role = replica` so the guard triggers are skipped for that transaction only;
// no trigger is dropped or altered, and the setting reverts at COMMIT/ROLLBACK.
//
// Refuses to run unless ALL of these hold:
//   SUPABASE_REF (default = the DEV ref) is in the hard-coded DEV allow-list,
//   CONFIRM_DEV_RESET=yes, DB_PASSWORD is set, and the database is not flagged production (app.settings 'environment').
// Steps: 1) one transaction: stash KEEP rows, TRUNCATE all other app tables, restore KEEP rows (counts before/after printed)
//        2) Auth: delete every user except KEEP_EMAILS (Auth Admin API, SUPABASE_SECRET_KEY from env, never stored)
//        3) Storage: delete every object in every bucket (Storage API); buckets and policies stay
//        4) one small transaction: empty audit tables again (the auth deletes wrote some) and write ONE audit.user_log note.
// Env: DB_PASSWORD, CONFIRM_DEV_RESET=yes, SUPABASE_SECRET_KEY (steps 2–3; skipped with a warning if absent),
//      DRY_RUN=yes (step 1 only, rolled back), SKIP_BACKUP_CHECK=yes (otherwise a backups/dev-full-*.ndjson.gz from the
//      last 24h must exist — run scripts/dev-backup.mjs first).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
import pg from 'pg'
import { readdirSync, statSync } from 'node:fs'

const DEV_REFS = ['fxwoabbwzcifxzqsmrie'] // allow-list: DEV only. Do not add a production ref here, ever.
const APP = ['acct', 'audit', 'core', 'field', 'help', 'hr', 'inv', 'master', 'msg', 'ops', 'prod', 'purch', 'sales']
// Configuration the app needs to run, seeded by migrations (or scripts/help-seed.mjs): kept in full.
const KEEP = [
  'core.roles', 'core.rights', 'core.role_rights', 'core.doc_types', 'core.forms', 'core.law_rules',
  'master.uoms', 'master.credit_terms', 'msg.templates', 'acct.schedule3_lines', 'help.pages', 'ops.backup_runs',
]
// Kept in part: only the listed rows survive.
const PARTIAL = {
  'core.settings': 'company_id is null', // group-level settings and their version history
  'core.user_profiles': 'user_id in (select id from auth.users where email = any($1))',
  'core.user_roles': 'company_id is null and valid_to is null and user_id in (select id from auth.users where email = any($1))',
}
const KEEP_EMAILS = ['phase0.admin@southfield.test', 'phase0.staff@southfield.test', 'phase0.store@southfield.test', 'phase0.investor@southfield.test']

const pw = process.env.DB_PASSWORD
const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
if (!DEV_REFS.includes(ref)) { console.error(`REFUSED: ${ref} is not in the DEV allow-list. This script must never run on production.`); process.exit(2) }
if (process.env.CONFIRM_DEV_RESET !== 'yes') { console.error('REFUSED: set CONFIRM_DEV_RESET=yes'); process.exit(2) }
const dry = process.env.DRY_RUN === 'yes'
if (!dry && process.env.SKIP_BACKUP_CHECK !== 'yes') {
  const fresh = existsRecentBackup()
  if (!fresh) { console.error('REFUSED: no backups/dev-full-*.ndjson.gz from the last 24h. Run scripts/dev-backup.mjs first.'); process.exit(2) }
  console.log(`backup found: ${fresh}`)
}
function existsRecentBackup() {
  try {
    const f = readdirSync('backups').filter((x) => /^dev-full-.*\.ndjson\.gz$/.test(x)).map((x) => `backups/${x}`)
      .filter((x) => Date.now() - statSync(x).mtimeMs < 86400000).sort().pop()
    return f
  } catch { return undefined }
}

const c = new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
const q = async (sql, p) => (await c.query(sql, p)).rows

async function counts() {
  const ts = (await q(`select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname = any($1) order by 1`, [APP])).map((r) => r.t)
  const out = {}
  for (const t of ts) out[t] = Number((await q(`select count(*)::bigint n from ${t}`))[0].n)
  return out
}

// Production guard: refuse if the database says it is production.
const env = await q(`select value from core.settings where company_id is null and key = 'environment' order by effective_from desc nulls last limit 1`).catch(() => [])
if (env[0] && String(env[0].value).replace(/"/g, '') === 'production') { console.error('REFUSED: this database is marked production.'); process.exit(2) }

const before = await counts()
const tables = Object.keys(before)
const wipe = tables.filter((t) => !KEEP.includes(t))

// ─── 1. Database wipe (one transaction) ───
let after
try {
  await q('begin')
  await q('set local session_replication_role = replica') // skips guard triggers for THIS transaction only
  // Safety: the TRUNCATE ... CASCADE closure must not reach a KEEP table.
  const closure = (await q(`
    with recursive deps(rel) as (
      select (n.nspname || '.' || c.relname)::regclass::oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1)
      union
      select f.conrelid from pg_constraint f join deps d on f.confrelid = d.rel where f.contype = 'f')
    select distinct rel::regclass::text as t from deps`, [wipe])).map((r) => r.t)
  // KEEP tables that reference a wiped table (e.g. master.credit_terms -> core.companies) get truncated by CASCADE:
  // stash them whole and restore them after.
  const reached = closure.filter((t) => KEEP.includes(t))
  if (reached.length) console.log(`KEEP tables inside the cascade (stashed and restored whole): ${reached.join(', ')}`)
  // Stash the partial-keep tables (they are in the cascade closure) and restore the kept rows after TRUNCATE.
  const partialTables = Object.keys(PARTIAL)
  for (const t of partialTables) {
    const stash = `stash_${t.replace('.', '_')}`
    await q(`create temp table ${stash} on commit drop as select * from ${t} where ${PARTIAL[t]}`, PARTIAL[t].includes('$1') ? [KEEP_EMAILS] : [])
  }
  // user_roles/settings may point (assigned_by/set_by) at users that are about to be deleted: clear those pointers in the stash.
  for (const [t, col] of [['core.user_roles', 'assigned_by'], ['core.settings', 'set_by']]) {
    const stash = `stash_${t.replace('.', '_')}`
    await q(`update ${stash} set ${col} = null where ${col} is not null and ${col} not in (select id from auth.users where email = any($1))`, [KEEP_EMAILS])
  }
  for (const t of reached) await q(`create temp table stash_${t.replace('.', '_')} on commit drop as select * from ${t}`)
  const list = [...new Set([...wipe, ...partialTables])]
  await q(`truncate table ${list.join(', ')} restart identity cascade`)
  for (const t of [...partialTables, ...reached]) await q(`insert into ${t} select * from stash_${t.replace('.', '_')}`)
  after = await counts()
  if (dry) { await q('rollback'); console.log('DRY RUN: rolled back') } else await q('commit')
} catch (e) {
  await q('rollback').catch(() => {})
  console.error('ABORTED, nothing changed:', e.message, e.detail ?? '')
  await c.end(); process.exit(1)
}

const big = Object.entries(before).filter(([, n]) => n > 0).map(([t, n]) => ({ table: t, before: n, after: after[t], kept: KEEP.includes(t) || t in PARTIAL ? 'KEEP' : 'WIPE' }))
console.log(`tables: ${tables.length}; wipe ${wipe.length}; keep ${KEEP.length} full + ${Object.keys(PARTIAL).length} partial`)
console.table(big.sort((a, b) => b.before - a.before))
if (dry) { await c.end(); process.exit(0) }

// ─── 2 + 3. Auth users and storage objects ───
const key = process.env.SUPABASE_SECRET_KEY
const base = `https://${ref}.supabase.co`
let removedUsers = 0, removedObjects = 0
if (!key) console.warn('SUPABASE_SECRET_KEY not set: auth/storage cleanup skipped')
else {
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const ur = await fetch(`${base}/auth/v1/admin/users?per_page=1000`, { headers: h })
  if (!ur.ok) throw new Error(`list users: ${ur.status}`)
  const users = (await ur.json()).users ?? []
  for (const u of users) {
    if (KEEP_EMAILS.includes(u.email)) continue
    const r = await fetch(`${base}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: h })
    if (!r.ok) { console.error(`delete user ${u.email}: ${r.status} ${await r.text()}`); continue }
    removedUsers++
  }
  console.log(`auth users removed: ${removedUsers}; kept: ${users.length - removedUsers}`)

  const buckets = await (await fetch(`${base}/storage/v1/bucket`, { headers: h })).json()
  const listAll = async (bucket, prefix) => {
    const files = []
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${base}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: h, body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) })
      const items = await r.json()
      if (!Array.isArray(items)) throw new Error(`list ${bucket}/${prefix}: ${JSON.stringify(items)}`)
      for (const it of items) {
        const path = prefix ? `${prefix}/${it.name}` : it.name
        if (it.id === null) files.push(...(await listAll(bucket, path))) // folder
        else files.push(path)
      }
      if (items.length < 1000) break
    }
    return files
  }
  for (const b of buckets) {
    const files = await listAll(b.name, '')
    for (let i = 0; i < files.length; i += 100) {
      const r = await fetch(`${base}/storage/v1/object/${b.name}`, { method: 'DELETE', headers: h, body: JSON.stringify({ prefixes: files.slice(i, i + 100) }) })
      if (!r.ok) console.error(`delete in ${b.name}: ${r.status} ${await r.text()}`)
    }
    console.log(`bucket ${b.name}: ${files.length} object(s) removed`)
    removedObjects += files.length
  }
}

// ─── 4. Audit note (and drop the audit rows the auth deletes just wrote) ───
try {
  await q('begin')
  await q('set local session_replication_role = replica')
  await q('truncate table audit.row_history, audit.user_log restart identity')
  await q(`insert into audit.user_log (user_id, event, detail) values (null, 'admin_action', $1::jsonb)`,
    [JSON.stringify({ action: 'dev_reset', note: 'owner-authorised DEV reset', date: new Date().toISOString().slice(0, 10), project: ref, users_removed: removedUsers, objects_removed: removedObjects })])
  await q('commit')
  console.log('audit note written (audit.user_log event admin_action, action dev_reset)')
} catch (e) { await q('rollback').catch(() => {}); console.error('audit note skipped:', e.message) }

const final = await counts()
console.log('final non-empty tables:')
console.table(Object.entries(final).filter(([, n]) => n > 0).map(([table, rows]) => ({ table, rows })))
await c.end()
