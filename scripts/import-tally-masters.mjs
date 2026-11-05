#!/usr/bin/env node
// Loads a TallyPrime "All Masters" XML file (groups, ledgers, stock groups/items, units, employees) into the ERP without the browser,
// through the SAME parser and the SAME RPCs as the Import data screen (api.import_create_batch → import_stage_rows → import_process_step
// → import_process). The file is streamed, so a 30 MB+ UTF-16 file works in Node.
//
//   npx tsx scripts/import-tally-masters.mjs --company SFB --file <Master.xml> --dry-run
//   npx tsx scripts/import-tally-masters.mjs --company SFB --file <Master.xml> --map-predefined      (chart + mapping, then load)
//   npx tsx scripts/import-tally-masters.mjs --company SFB --file <Master.xml>                        (load only; groups stay "Map this head")
//
// --dry-run          print counts per object type and the Tally groups with their ledger counts. Names of ledgers/parties/items are never printed.
// --map-predefined   (Admin) make sure the company has an account group for each of Tally's PREDEFINED groups (the ones the file marks with
//                    RESERVEDNAME), then map them through api.set_tally_group_map (the "Map this head" RPC). Custom groups are never mapped.
// --force            load even when the company named in the file does not look like the chosen company.
// Signs in as E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (.env.test.local), never printed.
import { readFileSync, existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { streamTallyRows } from './lib/tallyStream.mjs'
import { companyNameMatches } from '../src/features/import/tally/reports/index.ts'

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
const flag = (n) => argv.includes(`--${n}`)
const opt = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const die = (m) => {
  console.error(m)
  process.exit(1)
}
const code = opt('company')
const path = opt('file')
if (!code || !path) die('Usage: --company <code> --file <Master.xml> [--dry-run] [--map-predefined] [--force]')
if (!existsSync(path)) die('File not found.')

// ── Stream-parse ──
const rows = []
const t0 = Date.now()
const total = statSync(path).size
const { messages, companyName } = await streamTallyRows(
  path,
  (r) => {
    for (const x of r) rows.push(x)
  },
  { perBatch: 100, onBytes: (n) => process.stdout.write(`  reading ${Math.round((n / total) * 100)}%\r`) },
)
process.stdout.write('\n')
const counts = {}
for (const r of rows) counts[r.object_type] = (counts[r.object_type] ?? 0) + 1
console.log(`Masters file: ${messages} messages → ${rows.length} rows in ${Math.round((Date.now() - t0) / 1000)} s · company named in the file: ${companyName ?? '-'}`)
console.log(`  by type: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`)

// Tally groups with the number of ledgers directly under them
const groups = rows.filter((r) => r.object_type === 'group')
const ledgers = rows.filter((r) => r.object_type === 'ledger')
const under = new Map()
for (const l of ledgers) under.set(l.payload.parent ?? '(no group)', (under.get(l.payload.parent ?? '(no group)') ?? 0) + 1)
const seen = new Set()
const groupList = []
for (const g of groups) {
  if (seen.has(g.name)) continue
  seen.add(g.name)
  groupList.push({ name: g.name, parent: g.payload.parent ?? '', predefined: Boolean(g.payload.reserved), ledgers: under.get(g.name) ?? 0 })
}
console.log(`  ${groupList.length} distinct groups (${groupList.filter((g) => g.predefined).length} predefined by Tally, ${groupList.filter((g) => !g.predefined).length} custom)`)
for (const g of groupList) console.log(`    ${g.predefined ? 'predefined' : 'CUSTOM    '}  ${g.name.padEnd(30)} under ${(g.parent || '-').padEnd(24)} ledgers ${g.ledgers}`)
const orphan = [...under.keys()].filter((k) => !seen.has(k))
for (const k of orphan) console.log(`    ledgers under "${k}" (no such group in the file): ${under.get(k)}`)
const dupNames = ledgers.length - new Set(ledgers.map((l) => l.name)).size
console.log(`  duplicate ledger names inside the file: ${dupNames}`)
if (flag('dry-run')) {
  console.log('Dry run: nothing was sent.')
  process.exit(0)
}

// ── Sign in ──
const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const email = process.env.E2E_ADMIN_EMAIL
const password = process.env.E2E_ADMIN_PASSWORD
if (!url || !key) die('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are needed (.env.local).')
if (!email || !password) die('E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are needed (environment or .env.test.local).')
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const signIn = await sb.auth.signInWithPassword({ email, password })
if (signIn.error) die(`Sign-in failed: ${signIn.error.message}`)
const api = sb.schema('api')
const rpc = async (fn, args, opts = {}) => {
  const body = opts.idempotent === false ? args : { p_client_request_id: randomUUID(), ...args }
  const { data, error } = await api.rpc(fn, body)
  if (error) throw new Error(`${fn}: ${error.message}${error.hint ? ` [${error.hint}]` : ''}`)
  return data
}
const { data: companies, error: cErr } = await api.from('companies').select('id, code, name, short_name').ilike('code', code)
if (cErr) die(`Could not read companies: ${cErr.message}`)
const company = (companies ?? [])[0]
if (!company) die(`No company with code ${code}.`)
console.log(`Company: ${company.code} · ${company.name}`)
if (!companyNameMatches(companyName, [company.name, company.short_name]) && !flag('force')) die(`The file names the company "${companyName}", which does not look like ${company.name}. Check the company, or add --force.`)

// ── Chart of accounts for Tally's predefined groups, and the mapping ──
// Natures follow Tally's own definition of its predefined groups. Sundry Debtors / Creditors are the party groups.
const NATURE = {
  'Branch / Divisions': 'liability', 'Capital Account': 'equity', 'Current Assets': 'asset', 'Current Liabilities': 'liability',
  'Direct Expenses': 'expense', 'Direct Incomes': 'income', 'Fixed Assets': 'asset', 'Indirect Expenses': 'expense', 'Indirect Incomes': 'income',
  Investments: 'asset', 'Loans (Liability)': 'liability', 'Misc. Expenses (ASSET)': 'asset', 'Purchase Accounts': 'expense', 'Sales Accounts': 'income',
  'Suspense A/c': 'liability', 'Bank Accounts': 'asset', 'Bank OD A/c': 'liability', 'Cash-in-Hand': 'asset', 'Deposits (Asset)': 'asset',
  'Duties & Taxes': 'liability', 'Loans & Advances (Asset)': 'asset', Provisions: 'liability', 'Reserves & Surplus': 'equity',
  'Secured Loans': 'liability', 'Stock-in-Hand': 'asset', 'Sundry Creditors': 'liability', 'Sundry Debtors': 'asset', 'Unsecured Loans': 'liability',
  'Retained Earnings': 'equity',
}
if (flag('map-predefined')) {
  const predefined = groupList.filter((g) => g.predefined)
  const unknown = predefined.filter((g) => !NATURE[g.name])
  if (unknown.length > 0) console.log(`  predefined groups with no known nature (left unmapped): ${unknown.map((g) => g.name).join(', ')}`)
  const todo = predefined.filter((g) => NATURE[g.name])
  const { data: have } = await api.from('account_groups').select('id, name, tally_groups').eq('company_id', company.id)
  const byName = new Map((have ?? []).map((g) => [g.name, g]))
  // parents first
  const depth = (g) => (g.parent && NATURE[g.parent] ? 1 + depth(todo.find((x) => x.name === g.parent) ?? { parent: '' }) : 0)
  let created = 0
  let mapped = 0
  for (const g of [...todo].sort((a, b) => depth(a) - depth(b))) {
    let ag = byName.get(g.name)
    if (!ag) {
      const r = await rpc('upsert_account_group', {
        p: { company_id: company.id, name: g.name, nature: NATURE[g.name], parent_id: byName.get(g.parent)?.id ?? null, is_party_group: g.name === 'Sundry Debtors' ? 'debtors' : g.name === 'Sundry Creditors' ? 'creditors' : null },
      })
      ag = { id: r.id, name: g.name, tally_groups: [] }
      byName.set(g.name, ag)
      created++
    }
    if (!(ag.tally_groups ?? []).includes(g.name)) {
      await rpc('set_tally_group_map', { p_company_id: company.id, p_tally_group: g.name, p_account_group_id: ag.id })
      mapped++
    }
  }
  console.log(`Chart: ${created} account groups created, ${mapped} Tally groups mapped (${todo.length} predefined in the file).`)
}

// ── Stage and process (same steps as the Import screen) ──
const batch = await rpc('import_create_batch', {
  p: { company_id: company.id, source: 'tally_xml', kind: 'masters', file_name: path.split('/').pop(), storage_path: null, as_of: null, totals: { rows: rows.length, counts } },
})
console.log(`Batch ${batch.code}`)
const CH = 400
for (let i = 0; i < rows.length; i += CH) {
  await rpc('import_stage_rows', { p_batch_id: batch.id, p_rows: rows.slice(i, i + CH) }, { idempotent: false })
  process.stdout.write(`  staged ${Math.min(i + CH, rows.length)}/${rows.length}\r`)
}
process.stdout.write('\n')
let remaining = rows.length
while (remaining > 0) {
  const r = await rpc('import_process_step', { p_batch_id: batch.id, p_limit: 200 })
  process.stdout.write(`  processed, ${r.remaining} left\r`)
  if (r.remaining >= remaining) break
  remaining = r.remaining
}
process.stdout.write('\n')
const done = await rpc('import_process', { p_batch_id: batch.id })
console.log(`Batch ${batch.code} processed: ${JSON.stringify(done.counts ?? {})} · open Bug fixer items: ${done.open_bugs ?? 0}`)
await sb.auth.signOut()
