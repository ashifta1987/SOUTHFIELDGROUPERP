// Phase 9: server-time measurement of the main list queries, as the browser sends them through PostgREST
// (role authenticated, JWT claims set, RLS on). Runs in one transaction with two synthetic users (an Admin and an
// accountant of the E2E Perf company) and rolls everything back. Read-only otherwise.
// Usage: DB_PASSWORD=... node scripts/perf-measure.mjs [--plans] [--runs=3]
import pg from 'pg'

const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const args = process.argv.slice(2)
const RUNS = Number(args.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 3)
const c = new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
const q = async (sql, p) => (await c.query(sql, p)).rows

const [co] = await q(`select id from core.companies where code = 'E2EPERF'`)
if (!co) { console.error('Run scripts/perf-seed.mjs first'); process.exit(2) }
const [{ debtors }] = await q(`select id as debtors from acct.accounts where company_id = $1 and kind = 'party' limit 1`, [co.id])
const [{ party }] = await q(`select party_id as party from master.party_companies where company_id = $1 limit 1`, [co.id])
const [{ docs }] = await q(`select count(*)::int as docs from sales.documents where company_id = $1`, [co.id])

const lit = (s) => `'${s}'`
const C = lit(co.id)
const QUERIES = [
  ['Sales register (month, 1000)', `select * from api.sales_documents where company_id = ${C} and status = 'posted' and doc_type <> 'delivery_challan' and doc_date between '2026-10-01' and '2026-10-31' order by doc_date desc, doc_no desc limit 1000`],
  ['Sales register (month, page 200)', `select * from api.sales_documents where company_id = ${C} and status = 'posted' and doc_type <> 'delivery_challan' and doc_date between '2026-10-01' and '2026-10-31' order by doc_date desc, doc_no desc limit 200`],
  ['Sales register totals (month)', `select * from api.sales_register_totals(${C}, '2026-10-01', '2026-10-31')`, true],
  ['Invoices (latest 25)', `select * from api.sales_documents where company_id = ${C} order by created_at desc limit 25`],
  ['Receivables (all sales docs, 5000)', `select * from api.receivables where company_id = ${C} and kind = 'sales_document' limit 5000`],
  ['Receivables (most overdue, 500)', `select * from api.receivables where company_id = ${C} order by days_overdue desc limit 500`],
  ['Receivables (one party)', `select * from api.receivables where company_id = ${C} and party_id = ${lit(party)} order by bill_date limit 500`],
  ['Stock movements (latest 300)', `select * from api.stock_movements where company_id = ${C} order by id desc limit 300`],
  ['Stock movements (date range, 300)', `select * from api.stock_movements where company_id = ${C} and move_date between '2026-09-01' and '2026-09-30' order by id desc limit 300`],
  ['Transaction log (latest 500)', `select * from api.transaction_log order by at desc limit 500`],
  ['Transaction log (one table, 500)', `select * from api.transaction_log where table_name = 'sales.documents' order by at desc limit 500`],
  ['GL lines (debtors ledger, 500)', `select * from api.gl_lines where company_id = ${C} and account_id = ${lit(debtors)} order by entry_date desc, id desc limit 500`],
  ['GL lines (day book, 200)', `select * from api.gl_lines where company_id = ${C} order by entry_date desc, id desc limit 200`],
  ['Vouchers (cash book, 500)', `select * from api.vouchers where company_id = ${C} order by posted_at desc limit 500`],
  ['Vouchers (receipts, 100)', `select * from api.vouchers where company_id = ${C} and voucher_type = 'receipt' order by posted_at desc limit 100`],
  ['Customers (all, by name)', `select * from api.customers where company_id = ${C} order by name`],
  ['Outbox (sent, 200)', `select * from api.msg_outbox where status = 'sent' order by created_at desc limit 200`],
  ['Outbox (reminders of company, 200)', `select * from api.msg_outbox where event = 'sales.invoice' and company_id = ${C} order by created_at desc limit 200`],
]

const results = []
await q('begin')
try {
  const mk = async (email, role) => (await q(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '', now(), $2::jsonb, '{"full_name":"E2E Perf user"}'::jsonb, now(), now()) returning id`,
      [email, JSON.stringify(role ? { role } : {})]))[0].id
  const admin = await mk('e2e.perf.admin@example.test', 'admin')
  const acct = await mk('e2e.perf.accountant@example.test', null)
  await q(`insert into core.user_roles (user_id, role_key, company_id) values ($1, 'admin', null) on conflict do nothing`, [admin]).catch(() => {})
  await q(`insert into core.user_roles (user_id, role_key, company_id) values ($1, 'accountant', $2)`, [acct, co.id])
  for (const [who, uid] of [['admin', admin], ['accountant', acct]]) {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', aal: 'aal2' }), uid])
    await q('set local role authenticated')
    await q(`set local statement_timeout = '60s'`)
    for (const [name, sql, optional] of QUERIES) {
      let best = Infinity, rows = 0, plan = null
      try {
        for (let r = 0; r < RUNS; r++) {
          await q('savepoint m')
          const [{ 'QUERY PLAN': p }] = await q(`explain (analyze, buffers, format json) ${sql}`)
          await q('release savepoint m')
          const t = p[0]['Execution Time'] + p[0]['Planning Time']
          if (t < best) { best = t; rows = p[0].Plan['Actual Rows']; plan = p[0].Plan }
        }
        results.push({ who, query: name, ms: Number(best.toFixed(1)), rows })
        if (args.includes('--progress')) console.error(`${who} · ${name}: ${best.toFixed(1)} ms (${rows} rows)`)
      } catch (e) {
        await q('rollback to savepoint m')
        results.push({ who, query: name, ms: null, rows: optional ? 'n/a (not built yet)' : `ERROR ${e.message.slice(0, 60)}` })
      }
      if (args.includes('--plans') && plan) console.log(`\n## ${who} · ${name}\n` + JSON.stringify(plan, (k, v) => (['Output', 'Shared Hit Blocks', 'Shared Read Blocks', 'Shared Dirtied Blocks', 'Shared Written Blocks', 'Local Hit Blocks', 'Local Read Blocks', 'Local Dirtied Blocks', 'Local Written Blocks', 'Temp Read Blocks', 'Temp Written Blocks', 'Parallel Aware', 'Async Capable', 'Startup Cost', 'Plan Width'].includes(k) ? undefined : v)).slice(0, 4000))
    }
    await q('reset role')
  }
} finally {
  await q('rollback')
  await c.end()
}
console.log(`E2E Perf company: ${docs} sales documents. Best of ${RUNS} runs, planning + execution, server side.`)
console.table(results)
