#!/usr/bin/env node
// Compares a staged Tally Trial Balance / Balance Sheet with the ERP's closing balances (api.compare_trial_balance / api.compare_balance_sheet)
// and prints the result by LEDGER GROUP (never a ledger name). Read-only.
//
//   npx tsx scripts/compare-tally-reports.mjs --company SFB [--kind trial_balance|balance_sheet] [--report <id>]
//
// Without --report the latest staged report of that kind for the company is used. Signs in as E2E_ADMIN_* (.env.test.local).
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

for (const f of ['.env.test.local', '.env.local']) {
  if (!existsSync(f)) continue
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}
const argv = process.argv.slice(2)
const opt = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const code = opt('company')
const kind = opt('kind') ?? 'trial_balance'
if (!code) {
  console.error('Usage: --company <code> [--kind trial_balance|balance_sheet] [--report <id>]')
  process.exit(1)
}
const money = (n) => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const si = await sb.auth.signInWithPassword({ email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD })
if (si.error) {
  console.error(`Sign-in failed: ${si.error.message}`)
  process.exit(1)
}
const api = sb.schema('api')
const { data: companies } = await api.from('companies').select('id, code').ilike('code', code)
const company = (companies ?? [])[0]
if (!company) {
  console.error('No such company.')
  process.exit(1)
}
let id = opt('report')
if (!id) {
  const { data } = await api.from('tally_reports').select('id, as_of, kind, uploaded_at').eq('company_id', company.id).eq('kind', kind).order('uploaded_at', { ascending: false }).limit(1)
  id = data?.[0]?.id
}
if (!id) {
  console.error('No staged report of that kind.')
  process.exit(1)
}
const rows = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await api.rpc(kind === 'trial_balance' ? 'compare_trial_balance' : 'compare_balance_sheet', { p_report_id: id }).range(from, from + 999)
  if (error) {
    console.error(error.message)
    process.exit(1)
  }
  rows.push(...data)
  if (data.length < 1000) break
}
console.log(`${kind} ${id} · ${rows.length} lines`)
if (kind === 'trial_balance') {
  const by = new Map()
  const tot = { match: 0, differs: 0, only_in_tally: 0, only_in_erp: 0, zero_in_erp: 0 }
  for (const r of rows) {
    tot[r.status] = (tot[r.status] ?? 0) + 1
    const g = r.erp_group ?? r.tally_group ?? '(no group)'
    const x = by.get(g) ?? { n: 0, match: 0, differs: 0, only_in_tally: 0, only_in_erp: 0, tally: 0, erp: 0, diff: 0 }
    x.n++
    x[r.status] = (x[r.status] ?? 0) + 1
    x.tally += Number(r.tally_net ?? 0)
    x.erp += Number(r.erp_net ?? 0)
    x.diff += Number(r.diff ?? 0)
    by.set(g, x)
  }
  console.log(`  status: ${JSON.stringify(tot)}`)
  const sum = (k) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0)
  console.log(`  Tally net (Dr+) ${money(sum('tally_net'))} · ERP net ${money(sum('erp_net'))} · ERP minus Tally ${money(sum('diff'))}`)
  console.log('  by ledger group (largest difference first), net Dr positive:')
  for (const [g, x] of [...by].sort((a, b) => Math.abs(b[1].diff) - Math.abs(a[1].diff))) {
    console.log(`    ${g.padEnd(28)} lines ${String(x.n).padStart(4)} · match ${x.match} differs ${x.differs} only-Tally ${x.only_in_tally} only-ERP ${x.only_in_erp} · Tally ${money(x.tally).padStart(16)} ERP ${money(x.erp).padStart(16)} diff ${money(x.diff).padStart(16)}`)
  }
} else {
  for (const r of rows.filter((x) => !x.is_total && x.depth === 0)) {
    console.log(`    ${r.side} ${String(r.line).padEnd(28)} Tally ${money(r.tally_amount).padStart(16)} ERP ${money(r.erp_amount).padStart(16)} diff ${money(r.diff).padStart(16)} ${r.status}`)
  }
}
await sb.auth.signOut()
