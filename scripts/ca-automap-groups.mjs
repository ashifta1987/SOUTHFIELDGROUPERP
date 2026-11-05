#!/usr/bin/env node
// Maps custom Tally groups by Tally's own inheritance rule (a custom group takes the nature of its nearest PREDEFINED ancestor).
//   DB_PASSWORD=... node scripts/ca-automap-groups.mjs --company SFB [--dry-run] [--process]
// For every Tally group that has no ERP mapping yet: walk up the `parent` chain (group masters in ops.import_rows) to the nearest mapped
// (predefined) group, create a mirrored ERP account group as a CHILD of the parent's ERP group (api.upsert_account_group), and map it with
// api.set_tally_group_map (the same RPC as the "Map this head" screen). --process then re-runs api.import_process on the processed batches
// that still have rows waiting for a map. Reads via DB_PASSWORD (read-only SQL); writes only through the RPCs, signed in as Admin
// (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD from .env.test.local, never printed). Prints counts only, never names.
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

function loadEnv(file) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}
loadEnv('.env.test.local')
loadEnv('.env.local')
const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const flag = (n) => argv.includes(`--${n}`)
const die = (m) => { console.error(m); process.exit(1) }
const code = opt('company')
if (!code) die('Usage: --company <code> [--dry-run] [--process]')
if (!process.env.DB_PASSWORD) die('Set DB_PASSWORD')

const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
const db = new pg.Client({ host: 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: process.env.DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await db.connect()
const q = async (sql, args) => (await db.query(sql, args)).rows

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
{
  const { error } = await sb.auth.signInWithPassword({ email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD })
  if (error) die('Admin sign-in failed.')
}
const rpc = async (fn, args) => {
  const { data, error } = await sb.schema('api').rpc(fn, { p_client_request_id: randomUUID(), ...args })
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data
}

const [co] = await q('select id from core.companies where code = $1', [code])
if (!co) die('Unknown company')
const company = co.id
const count = async () => (await q(`select
  (select count(*)::int from acct.account_groups where company_id = $1) groups,
  (select count(*)::int from acct.accounts where company_id = $1) accounts,
  (select count(*)::int from master.party_companies where company_id = $1) parties,
  (select count(*)::int from ops.bug_items where company_id = $1 and kind = 'map_head' and status = 'open') map_head_open,
  (select count(*)::int from ops.import_rows r join ops.import_batches b on b.id = r.batch_id where b.company_id = $1 and b.status = 'processed' and r.result = 'bug' and r.message = 'waiting_map') waiting_rows`, [company]))[0]
console.log(code, 'BEFORE', await count())

// Group masters, newest batch first per name.
const groups = await q(`select distinct on (r.name) r.name, r.payload->>'parent' parent, r.payload->>'reserved' reserved
  from ops.import_rows r join ops.import_batches b on b.id = r.batch_id
  where b.company_id = $1 and r.object_type = 'group' and b.status in ('processed', 'approved') and r.name is not null order by r.name, b.created_at desc`, [company])
const byName = new Map(groups.map((g) => [g.name, g]))
const maps = new Map((await q('select m.tally_group, g.id, g.nature, g.is_party_group from ops.tally_group_map m join acct.account_groups g on g.id = m.account_group_id where m.company_id = $1', [company])).map((m) => [m.tally_group, m]))
const existingErp = new Map((await q('select name, id from acct.account_groups where company_id = $1', [company])).map((g) => [g.name, g.id]))

// Resolve in parent-first order. depth = number of custom groups above the nearest mapped ancestor.
const todo = []
for (const g of groups) {
  if (maps.has(g.name)) continue
  const chain = []
  let cur = g
  const seen = new Set()
  while (cur && !maps.has(cur.name) && !seen.has(cur.name)) { seen.add(cur.name); chain.push(cur); cur = byName.get(cur.parent) ?? (maps.has(cur.parent) ? { name: cur.parent } : null) }
  if (!cur || !maps.has(cur.name)) { console.log('  skipped: a custom group has no resolvable predefined ancestor (owner/CA to decide)'); continue }
  todo.push({ g, depth: chain.length, ancestor: cur.name })
}
todo.sort((a, b) => a.depth - b.depth)
console.log(code, 'custom groups to map:', todo.length, 'by depth', JSON.stringify(todo.reduce((a, t) => ((a[t.depth] = (a[t.depth] ?? 0) + 1), a), {})))

let done = 0
for (const t of todo) {
  const anc = maps.get(t.ancestor)
  const parentMap = maps.get(t.g.parent)
  if (!parentMap) { console.log('  parent not mapped yet, skipped'); continue }
  if (t.g.reserved) { console.log('  reserved-name group left alone'); continue }
  if (flag('dry-run')) { done++; continue }
  let erpId = existingErp.get(t.g.name)
  if (!erpId) {
    // The mirrored group is a CHILD of the parent's ERP group. is_party_group is inherited so debtors/creditors ledgers still become parties.
    const r = await rpc('upsert_account_group', { p: { company_id: company, name: t.g.name, parent_id: parentMap.id, nature: anc.nature, is_party_group: anc.is_party_group ?? '' } })
    erpId = r.id
  }
  await rpc('set_tally_group_map', { p_company_id: company, p_tally_group: t.g.name, p_account_group_id: erpId })
  maps.set(t.g.name, { tally_group: t.g.name, id: erpId, nature: anc.nature, is_party_group: anc.is_party_group })
  done++
}
console.log(code, 'groups mapped:', done)

if (flag('process') && !flag('dry-run')) {
  const batches = await q(`select distinct b.id, b.created_at from ops.import_batches b join ops.import_rows r on r.batch_id = b.id
    where b.company_id = $1 and b.status = 'processed' and r.result = 'bug' and r.message = 'waiting_map' order by b.created_at`, [company])
  for (const b of batches) {
    const res = await rpc('import_process', { p_batch_id: b.id })
    console.log(code, 'processed a batch ->', JSON.stringify(res.counts ?? res))
  }
}
console.log(code, 'AFTER', await count())
await db.end()
