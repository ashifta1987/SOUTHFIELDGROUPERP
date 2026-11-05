#!/usr/bin/env node
// Reads a TallyPrime Day Book XML (voucher-level, with ledger lines) as a stream and either summarises it (--dry-run) or stages it through the
// SAME RPCs as the Import data screen (import_create_batch → import_stage_rows → import_process_step → import_process).
//
//   npx tsx scripts/import-tally-daybook-xml.mjs --company SFP --file <DayBook.xml> --dry-run [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   npx tsx scripts/import-tally-daybook-xml.mjs --company SFP --file <DayBook.xml> [--from ..] [--to ..] [--force]
//
// The file is never held in memory as one string (UTF-16LE is decoded incrementally and split on </TALLYMESSAGE>).
// --from / --to keep only vouchers dated inside the window (e.g. the financial years wanted as reference).
// Prints counts, totals, dates and balance checks only: never a party, ledger or narration text.
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
const from = opt('from')
const to = opt('to')
const dry = flag('dry-run')
if (!code || !path) die('Usage: --company <code> --file <DayBook.xml> [--dry-run] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--force]')
if (!existsSync(path)) die('File not found.')

const money = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dmy = (iso) => (iso ? iso.split('-').reverse().join('-') : '-')
const total = statSync(path).size

// ── Optional database side (only when loading) ──
let sb = null
let api = null
let rpc = null
let company = null
let batch = null
const CH = 400
if (!dry) {
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const email = process.env.E2E_ADMIN_EMAIL
  const password = process.env.E2E_ADMIN_PASSWORD
  if (!url || !key || !email || !password) die('Supabase URL/key (.env.local) and E2E_ADMIN_EMAIL/PASSWORD (.env.test.local) are needed.')
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const signIn = await sb.auth.signInWithPassword({ email, password })
  if (signIn.error) die(`Sign-in failed: ${signIn.error.message}`)
  api = sb.schema('api')
  rpc = async (fn, args, opts = {}) => {
    const body = opts.idempotent === false ? args : { p_client_request_id: randomUUID(), ...args }
    for (let attempt = 1; ; attempt++) {
      const { data, error } = await api.rpc(fn, body)
      if (!error) return data
      if (attempt < 3 && /timeout|fetch failed|ECONN/i.test(error.message) && opts.idempotent !== false) continue
      throw new Error(`${fn}: ${error.message}${error.hint ? ` [${error.hint}]` : ''}`)
    }
  }
  const { data: companies } = await api.from('companies').select('id, code, name, short_name').ilike('code', code)
  company = (companies ?? [])[0]
  if (!company) die(`No company with code ${code}.`)
  console.log(`Company: ${company.code} · ${company.name}`)
}

// ── Stream ──
const stats = { vouchers: 0, kept: 0, lines: 0, noLines: 0, noDate: 0, cancelled: 0, optional: 0, unbalanced: 0, unbalancedAbs: 0, dr: 0, cr: 0, payloadBytes: 0, maxLines: 0, outsideWindow: 0, dupGuid: 0 }
const byType = new Map()
const byYear = new Map()
let dateFrom = null
let dateTo = null
const seenGuids = new Set()
let staged = 0
let pending = []
let companyInFile = null
const t0 = Date.now()
const lastLine = { s: '' }

async function flushPending(force) {
  if (dry || pending.length === 0 || (!force && pending.length < CH)) return
  if (!batch) {
    if (!companyNameMatches(companyInFile, [company.name, company.short_name]) && !flag('force')) {
      die(`The file names the company "${companyInFile}", which does not look like ${company.name}. Check the company, or add --force.`)
    }
    batch = await rpc('import_create_batch', {
      p: { company_id: company.id, source: 'tally_xml', kind: 'vouchers', file_name: path.split('/').pop(), storage_path: null, as_of: null, totals: { window_from: from ?? null, window_to: to ?? null } },
    })
    console.log(`Batch ${batch.code}`)
  }
  while (pending.length >= (force ? 1 : CH)) {
    const part = pending.splice(0, CH)
    await rpc('import_stage_rows', { p_batch_id: batch.id, p_rows: part }, { idempotent: false })
    staged += part.length
  }
}

const { messages, companyName } = await streamTallyRows(
  path,
  async (rows, info) => {
    companyInFile = info.companyName
    for (const r of rows) {
      if (r.object_type !== 'voucher') continue
      stats.vouchers++
      const p = r.payload
      const d = p.date
      if (!d) {
        stats.noDate++
        continue
      }
      if ((from && d < from) || (to && d > to)) {
        stats.outsideWindow++
        continue
      }
      if (r.guid) {
        if (seenGuids.has(r.guid)) stats.dupGuid++
        seenGuids.add(r.guid)
      }
      stats.kept++
      dateFrom = dateFrom && dateFrom < d ? dateFrom : d
      dateTo = dateTo && dateTo > d ? dateTo : d
      const lines = p.lines ?? []
      stats.lines += lines.length
      stats.maxLines = Math.max(stats.maxLines, lines.length)
      if (lines.length === 0) stats.noLines++
      if (p.cancelled) stats.cancelled++
      if (p.optional) stats.optional++
      let sum = 0
      let dr = 0
      let cr = 0
      for (const l of lines) {
        sum += l.amount
        if (l.amount < 0) dr += -l.amount
        else cr += l.amount
      }
      sum = Math.round(sum * 100) / 100
      if (Math.abs(sum) > 0.01) {
        stats.unbalanced++
        stats.unbalancedAbs += Math.abs(sum)
      }
      stats.dr += dr
      stats.cr += cr
      const t = byType.get(p.type ?? '(none)') ?? { count: 0, lines: 0, dr: 0, cr: 0, unbalanced: 0, noLines: 0 }
      t.count++
      t.lines += lines.length
      t.dr += dr
      t.cr += cr
      if (Math.abs(sum) > 0.01) t.unbalanced++
      if (lines.length === 0) t.noLines++
      byType.set(p.type ?? '(none)', t)
      const fy = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0)
      const y = byYear.get(fy) ?? { count: 0, lines: 0 }
      y.count++
      y.lines += lines.length
      byYear.set(fy, y)
      stats.payloadBytes += JSON.stringify(r).length
      if (!dry) pending.push(r)
    }
    await flushPending(false)
    const line = `  ${stats.vouchers} vouchers read${dry ? '' : `, ${staged} staged`}`
    if (line !== lastLine.s) process.stdout.write(`${line}\r`)
    lastLine.s = line
  },
  { perBatch: 150, onBytes: () => {} },
)
await flushPending(true)
process.stdout.write('\n')

console.log(`Day Book XML: ${messages} messages · ${stats.vouchers} vouchers read in ${Math.round((Date.now() - t0) / 1000)} s (file ${Math.round(total / 1048576)} MB) · company named in the file: ${companyName ?? '-'}`)
if (from || to) console.log(`  window ${dmy(from)} to ${dmy(to)}: kept ${stats.kept}, outside the window ${stats.outsideWindow}`)
console.log(`  vouchers ${stats.kept} · ledger lines ${stats.lines} (max ${stats.maxLines} in one voucher) · dates ${dmy(dateFrom)} to ${dmy(dateTo)}`)
console.log(`  total debit ${money(stats.dr)} · total credit ${money(stats.cr)} · difference ${money(stats.dr - stats.cr)}`)
console.log(`  vouchers whose lines do not balance: ${stats.unbalanced} (sum of differences ${money(stats.unbalancedAbs)}) · with no ledger lines: ${stats.noLines} · without a date: ${stats.noDate} · duplicate GUIDs: ${stats.dupGuid} · cancelled ${stats.cancelled} · optional ${stats.optional}`)
console.log(`  staged payload size ${(stats.payloadBytes / 1048576).toFixed(1)} MB (average ${Math.round(stats.payloadBytes / Math.max(stats.kept, 1))} bytes per voucher)`)
console.log('  by voucher type:')
for (const [k, v] of [...byType].sort((a, b) => b[1].count - a[1].count)) console.log(`    ${k.padEnd(24)} ${String(v.count).padStart(7)}  lines ${String(v.lines).padStart(7)}  Dr ${money(v.dr).padStart(18)}  Cr ${money(v.cr).padStart(18)}  unbalanced ${v.unbalanced} · no lines ${v.noLines}`)
console.log('  by financial year (April-March):')
for (const [k, v] of [...byYear].sort((a, b) => a[0] - b[0])) console.log(`    FY ${k}-${String(k + 1).slice(2)}  vouchers ${String(v.count).padStart(7)}  lines ${String(v.lines).padStart(7)}`)
if (dry) {
  console.log('Dry run: nothing was sent.')
  process.exit(0)
}

// process
let remaining = staged
while (remaining > 0) {
  const r = await rpc('import_process_step', { p_batch_id: batch.id, p_limit: 500 })
  process.stdout.write(`  processed ${staged - r.remaining}/${staged}\r`)
  if (r.remaining >= remaining) break
  remaining = r.remaining
}
process.stdout.write('\n')
const done = await rpc('import_process', { p_batch_id: batch.id })
console.log(`Batch ${batch.code} processed: ${JSON.stringify(done.counts ?? {})} · open Bug fixer items: ${done.open_bugs ?? 0}`)
await sb.auth.signOut()
