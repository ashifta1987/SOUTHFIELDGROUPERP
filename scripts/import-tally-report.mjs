#!/usr/bin/env node
// Loads a TallyPrime report file into the ERP without the browser, using the SAME parsers and the SAME RPCs as the Import screen.
//
//   npx tsx scripts/import-tally-report.mjs --company SFB --kind daybook --file <path.xlsx> --dry-run
//   npx tsx scripts/import-tally-report.mjs --company SFB --kind daybook --file <path.xlsx>
//   npx tsx scripts/import-tally-report.mjs --company SFB --kind trial_balance --file <path.xlsx> [--as-of 2026-03-31] [--apply]
//   npx tsx scripts/import-tally-report.mjs --company SFB --kind stock_summary --file <path.xlsx> [--as-of 2026-03-31] [--apply --place <place code>]
//   npx tsx scripts/import-tally-report.mjs --company SFB --kind balance_sheet --file <path.xlsx> [--as-of 2026-03-31]
//
// --kind: daybook | trial_balance | stock_summary | balance_sheet.   --dry-run: read the file and print the pre-load summary only.
// --force: load even when the company named in the file does not look like the chosen company.
// --apply: after staging a Trial Balance (Admin: sets opening balances) or a Stock Summary (needs --place), call the apply RPC.
// Signs in as the Admin login E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD from the environment or .env.test.local (never printed).
// Supabase URL and publishable key come from VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY (.env.local). File paths are given at
// run time; real files are never committed (imports/ is git-ignored). Only counts and totals are printed, never party or item names.
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { readSheet } from 'read-excel-file/node'
import { parseDayBook, parseReport, reportXmlToTable, sha256Hex, companyNameMatches } from '../src/features/import/tally/reports/index.ts'
import { runDayBook, stageReport } from '../src/features/import/tally/reports/flow.ts'
import { decodeTallyBytes, sanitizeTallyXml } from '../src/features/import/tally/parseTallyXml.ts'

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
const die = (msg) => {
  console.error(msg)
  process.exit(1)
}

const code = opt('company')
const kind = opt('kind')
const path = opt('file')
const dry = flag('dry-run')
const KINDS = ['daybook', 'trial_balance', 'stock_summary', 'balance_sheet']
if (!code || !KINDS.includes(kind ?? '') || !path) die(`Usage: --company <code> --kind ${KINDS.join('|')} --file <path.xlsx> [--as-of YYYY-MM-DD] [--dry-run] [--apply [--place <code>]] [--force]`)
if (!existsSync(path)) die('File not found.')

const money = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const dmy = (iso) => (iso ? iso.split('-').reverse().join('-') : '-')

// ── Read and parse (same modules as the browser) ──
const isXml = /\.xml$/i.test(path)
const bytes = readFileSync(path)
async function table() {
  if (isXml) {
    if (kind === 'daybook') die('A Day Book XML (with voucher lines) is loaded from the Import screen. Use the Excel Day Book here.')
    return reportXmlToTable(sanitizeTallyXml(decodeTallyBytes(new Uint8Array(bytes))), kind)
  }
  return readSheet(path)
}
const t = await table()

let summary = null
let parsed = null
if (kind === 'daybook') {
  summary = parseDayBook(t)
  console.log(`Day Book: ${summary.rows.length} lines`)
  console.log(`  company named in the file: ${summary.companyName ?? '-'}`)
  console.log(`  period in the title: ${dmy(summary.periodFrom)} to ${dmy(summary.periodTo)} · voucher dates ${dmy(summary.dateFrom)} to ${dmy(summary.dateTo)}`)
  console.log(`  total debit ${money(summary.totalDr)} · total credit ${money(summary.totalCr)}`)
  console.log('  by voucher type:')
  for (const r of summary.byType) console.log(`    ${r.type.padEnd(20)} ${String(r.count).padStart(7)}  Dr ${money(r.dr).padStart(18)}  Cr ${money(r.cr).padStart(18)}`)
  for (const w of summary.warnings) console.log(`  note: ${w.code} × ${w.count}`)
} else {
  parsed = parseReport(kind, t)
  const d = parsed.detail
  console.log(`${kind}: ${parsed.lines.length} lines · as of ${dmy(parsed.asOf)} · company named in the file: ${parsed.companyName ?? '-'}`)
  if (kind === 'trial_balance') {
    console.log(`  ${d.ledgerCount} ledgers, ${d.groupCount} group lines · grain: ${d.grain}`)
    console.log(`  ledgers add up to Dr ${money(d.ledgerDr)} / Cr ${money(d.ledgerCr)} · file grand total Dr ${money(d.tallyDr)} / Cr ${money(d.tallyCr)}`)
    if (d.grain === 'group') console.log('  This sheet lists groups only. Export the expanded, ledger-wise Trial Balance (Alt+F5) and load that file.')
  } else if (kind === 'stock_summary') {
    console.log(`  ${d.itemCount} items, ${d.groupCount} group lines · value ${money(d.itemValue)} · file grand total ${money(d.tallyValue)} · zero/negative lines ${d.negativeOrZero}`)
  } else {
    console.log(`  layout ${d.layout} · liabilities ${money(d.liabilitiesTotal)} · assets ${money(d.assetsTotal)}`)
  }
  for (const w of parsed.warnings) console.log(`  note: ${w.code}${w.detail ? ` (${w.detail})` : ''}`)
}
if (dry) {
  console.log('Dry run: nothing was sent.')
  process.exit(0)
}

// ── Sign in as the Admin login ──
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

const fileCompany = kind === 'daybook' ? summary.companyName : parsed.companyName
if (!companyNameMatches(fileCompany, [company.name, company.short_name]) && !flag('force')) {
  die(`The file names the company "${fileCompany}", which does not look like ${company.name}. Check the company, or add --force.`)
}

let lastLine = ''
const onProgress = (step, done, total) => {
  const line = total ? `  ${step} ${done}/${total}` : `  ${step}`
  if (line !== lastLine) process.stdout.write(`${line}\r`)
  lastLine = line
  if (!total) process.stdout.write('\n')
}

try {
  if (kind === 'daybook') {
    const r = await runDayBook(rpc, {
      companyId: company.id,
      fileName: path.split('/').pop(),
      storagePath: null,
      rows: summary.rows,
      totals: { voucher_count: summary.rows.length, report_from: summary.dateFrom, report_to: summary.dateTo, dr_total: summary.totalDr, cr_total: summary.totalCr },
      onProgress,
    })
    console.log(`\nBatch ${r.code}: ${JSON.stringify(r.counts?.voucher ?? {})} · open Bug fixer items: ${r.open_bugs ?? 0}`)
  } else {
    const asOf = opt('as-of') ?? parsed.asOf
    if (!asOf) die('The report date could not be read from the file. Add --as-of YYYY-MM-DD.')
    const sha = await sha256Hex(new Uint8Array(bytes))
    const r = await stageReport(rpc, { companyId: company.id, parsed, asOf, fileName: path.split('/').pop(), sha256: sha, onProgress })
    console.log(r.duplicate ? `This exact file is already stored (report ${r.id}, status ${r.status}). Nothing new was added.` : `Stored report ${r.id} as of ${dmy(asOf)}.`)
    if (flag('apply')) {
      if (kind === 'trial_balance') {
        const a = await rpc('apply_trial_balance_as_opening', { p_report_id: r.id })
        console.log(`Apply: ${a.applied ? 'done' : 'refused'}. ${a.message ?? ''}`)
        if (a.groups) console.log(`  Tally groups to map: ${a.groups.join(', ')}`)
      } else if (kind === 'stock_summary') {
        const placeCode = opt('place')
        if (!placeCode) die('--apply for a Stock Summary needs --place <store code>.')
        const { data: places } = await api.from('places').select('id, code').eq('company_id', company.id).ilike('code', placeCode)
        if (!places?.[0]) die(`No store with code ${placeCode} in ${company.code}.`)
        const a = await rpc('apply_stock_summary_as_opening_stock', { p_report_id: r.id, p_place_id: places[0].id })
        console.log(`Apply: ${a.applied ? 'done' : 'refused'}. ${a.message ?? ''}`)
        if (a.unmatched) console.log(`  ${a.unmatched.length} items are not in the product list yet (map or create them on the Import screen).`)
      } else console.log('A Balance Sheet is for reconciliation only; there is nothing to apply.')
    } else if (kind !== 'balance_sheet') console.log('Open the Import screen → Reports from Tally to check, compare and apply it.')
  }
} catch (e) {
  die(`\nFailed: ${e instanceof Error ? e.message : String(e)}`)
}
await sb.auth.signOut()
