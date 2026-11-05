#!/usr/bin/env node
// Auto-maps the HIGH-confidence Tally predefined groups to their Schedule III line (Companies Act 2013, Schedule III, Division I).
// The rule table is the same one documented in docs/CA_AUTOMAPPING.md. It never confirms for the CA (no confirm_schedule3_map call)
// and never overwrites a line somebody already set.
//   DB_PASSWORD=... node scripts/ca-automap-schedule3.mjs --company SFB [--dry-run]
// Custom child groups are not mapped one by one: api.schedule3_statements already uses the nearest mapped ancestor.
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
const code = argv[argv.indexOf('--company') + 1]
const dry = argv.includes('--dry-run')
const die = (m) => { console.error(m); process.exit(1) }
if (!code || code.startsWith('--')) die('Usage: --company <code> [--dry-run]')
if (!process.env.DB_PASSWORD) die('Set DB_PASSWORD')

// Tally predefined group → Schedule III line. Only rows whose line follows from the group's own definition.
export const RULES = [
  ['Sundry Debtors', 'trade_receivables'],
  ['Sundry Creditors', 'trade_payables'],
  ['Bank Accounts', 'cash_equivalents'],
  ['Cash-in-Hand', 'cash_equivalents'],
  ['Bank OD A/c', 'short_term_borrowings'],
  ['Fixed Assets', 'ppe'],
  ['Stock-in-Hand', 'inventories'],
  ['Reserves & Surplus', 'reserves_surplus'],
  ['Sales Accounts', 'revenue_operations'],
  ['Indirect Incomes', 'other_income'],
]
const SIDE = { asset: ['assets'], liability: ['equity_liabilities'], equity: ['equity_liabilities'], income: [null], expense: [null] }

const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
const db = new pg.Client({ host: 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: process.env.DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await db.connect()
const q = async (sql, args) => (await db.query(sql, args)).rows
const [co] = await q('select id from core.companies where code = $1', [code])
if (!co) die('Unknown company')
const lines = new Map((await q('select code, statement, side from acct.schedule3_lines')).map((l) => [l.code, l]))

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
if (!dry) {
  const { error } = await sb.auth.signInWithPassword({ email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD })
  if (error) die('Admin sign-in failed.')
}
let mapped = 0, skipped = 0
for (const [group, line] of RULES) {
  const [g] = await q(`select g.id, g.nature from acct.account_groups g join ops.tally_group_map m on m.account_group_id = g.id and m.tally_group = g.name
    where g.company_id = $1 and g.name = $2`, [co.id, group])
  const l = lines.get(line)
  if (!g || !l) { console.log('  not found:', group); skipped++; continue }
  const okSide = l.statement === 'pl' ? ['income', 'expense'].includes(g.nature) : (SIDE[g.nature] ?? []).includes(l.side)
  if (!okSide) { console.log('  nature/line mismatch, left for the CA:', group); skipped++; continue }
  const [ex] = await q('select line_code from acct.schedule3_map where account_group_id = $1', [g.id])
  if (ex) { console.log('  already mapped, kept:', group); skipped++; continue }
  if (!dry) {
    const { error } = await sb.schema('api').rpc('set_schedule3_map', { p_client_request_id: randomUUID(), p: { account_group_id: g.id, line_code: line } })
    if (error) die(`set_schedule3_map: ${error.message}`)
    await q(`select app.log_event('setting_changed', $1::jsonb)`, [JSON.stringify({ entity: 'schedule3_map', company: code, group, line_code: line, note: 'auto-mapped on 05-11-2026 by the assistant per Schedule III / Tally inheritance — CA to confirm' })])
  }
  mapped++
}
console.log(code, dry ? 'would map' : 'mapped', mapped, 'groups; left', skipped)
await db.end()
