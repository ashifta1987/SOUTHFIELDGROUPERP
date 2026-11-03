// Phase 9 performance data: one synthetic company "E2E Perf Synthetic Pvt Ltd" (code E2EPERF) with 50,000 posted sales
// invoices (100,000 lines), their sales vouchers and GL rows, 100,000 stock rows, 20,000 receipts with bill
// allocations, and 10,000 outbox rows. DEV only. Synthetic names and amounts only — never real data.
//
// Rows go in with direct inserts inside this one synthetic company, in the same shape the posting RPCs write them
// (draft → lines → voucher + GL + stock → posted). Nothing important is bypassed: audit triggers, the append-only and
// closed-period guards all run; the stock guard is passed with the same app.stock_posting flag the stock RPCs set.
// The company code starts with E2E, so scripts/e2e-cleanup.mjs switches it off (posted rows are never deleted).
//
// Usage: DB_PASSWORD=... node scripts/perf-seed.mjs [docs=50000]
import pg from 'pg'

const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
if ((process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie') !== 'fxwoabbwzcifxzqsmrie' && !process.env.PERF_SEED_ALLOW) {
  console.error('Refusing: perf data goes only into the DEV project'); process.exit(2)
}
const N = Number(process.argv[2] ?? 50000)
const CHUNK = 5000
const c = new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
const q = async (sql, p) => (await c.query(sql, p)).rows

let [co] = await q(`select id from core.companies where code = 'E2EPERF'`)
if (!co) {
  await q('begin')
  ;[co] = await q(`insert into core.companies (code, legal_name, short_name, pan) values ('E2EPERF', 'E2E Perf Synthetic Pvt Ltd', 'E2E Perf', 'PERFE9999P') returning id`)
  const id = co.id
  const [g] = await q(`insert into core.gstins (company_id, gstin, is_principal) values ($1, '32PERFE9999P1ZQ', true) returning id`, [id])
  const [b] = await q(`insert into core.branches (company_id, gstin_id, code, name, kind) values ($1, $2, 'P1', 'E2E Perf Factory', 'factory') returning id`, [id, g.id])
  await q(`insert into core.places (company_id, branch_id, code, name, kind) values ($1, $2, 'PST', 'E2E Perf Stores', 'stores')`, [id, b.id])
  const [fy] = await q(`insert into core.financial_years (company_id, label, starts_on, ends_on) values ($1, '2026-27', '2026-04-01', '2027-03-31') returning id`, [id])
  await q(`insert into core.periods (company_id, fy_id, month_start) select $1, $2, (date '2026-04-01' + (n || ' month')::interval)::date from generate_series(0, 11) n on conflict do nothing`, [id, fy.id])
  const grp = async (name, nature) => (await q(`insert into acct.account_groups (company_id, name, nature) values ($1, $2, $3) returning id`, [id, name, nature]))[0].id
  const gi = await grp('E2E Perf Income', 'income'), gt = await grp('E2E Perf Duties and taxes', 'liability'), ga = await grp('E2E Perf Current assets', 'asset')
  const acc = async (gid, name, kind) => (await q(`insert into acct.accounts (company_id, group_id, name, status, kind) values ($1, $2, $3, 'active', $4) returning id`, [id, gid, name, kind]))[0].id
  await acc(gi, 'E2E Perf Sales', 'income'); await acc(gt, 'E2E Perf Output CGST', 'tax'); await acc(gt, 'E2E Perf Output SGST', 'tax')
  await acc(ga, 'E2E Perf Sundry debtors', 'party'); await acc(ga, 'E2E Perf Bank', 'bank')
  await q(`insert into master.products (code, name, uom, status) select 'E2EPERF' || lpad(n::text, 3, '0'), 'E2E Perf Product ' || lpad(n::text, 3, '0'), 'NOS', 'active' from generate_series(1, 50) n`)
  await q(`insert into master.product_companies (product_id, company_id) select id, $1 from master.products where code like 'E2EPERF%'`, [id])
  await q(`insert into master.parties (legal_name, gst_status, state_code, is_customer, customer_type, kyc_status)
           select 'E2E Perf Shop ' || lpad(n::text, 4, '0'), 'unregistered', '32', true, 'retail_shop', 'verified' from generate_series(1, 500) n`)
  await q(`insert into master.party_companies (party_id, company_id, is_customer) select id, $1, true from master.parties where legal_name like 'E2E Perf Shop %'`, [id])
  await q('commit')
  console.log('created E2E Perf company', id)
}
const coId = co.id
const [{ have }] = await q(`select count(*)::int as have from sales.documents where company_id = $1`, [coId])
console.log(`existing documents: ${have}; target ${N}`)

const t0 = Date.now()
for (let from = have + 1; from <= N; from += CHUNK) {
  const to = Math.min(N, from + CHUNK - 1)
  await q('begin')
  try {
    await q(`select set_config('app.stock_posting', 'on', true)`)
    await q(`create temp table _d on commit drop as
      with ctx as (
        select (select id from core.gstins where company_id = $1::uuid) g, (select id from core.financial_years where company_id = $1::uuid) fy,
               (select id from core.places where company_id = $1::uuid) pl,
               array(select pc.party_id from master.party_companies pc join master.parties p on p.id = pc.party_id where pc.company_id = $1::uuid order by p.legal_name) pa,
               array(select pc.product_id from master.product_companies pc join master.products p on p.id = pc.product_id where pc.company_id = $1::uuid order by p.code) pr)
      select i, gen_random_uuid() id, gen_random_uuid() vid, gen_random_uuid() rid, ctx.g, ctx.fy, ctx.pl,
             'PRF/26-27/' || lpad(i::text, 6, '0') doc_no, 'PRC/26-27/' || lpad(i::text, 6, '0') rcpt_no,
             (date '2026-04-01' + (i % 214))::date dt, ctx.pa[1 + i % array_length(ctx.pa, 1)] party,
             ctx.pr[1 + (2 * i) % array_length(ctx.pr, 1)] p1, ctx.pr[1 + (2 * i + 1) % array_length(ctx.pr, 1)] p2,
             round((1000 + (i % 97) * 37.5)::numeric, 2) taxable
      from generate_series($2::int, $3::int) i, ctx`, [coId, from, to])
    await q(`alter table _d add column l1 numeric(18,2), add column cgst numeric(18,2), add column total numeric(18,2)`)
    await q(`update _d set l1 = round(taxable * 0.6, 2), cgst = round(taxable * 0.09, 2), total = taxable + 2 * round(taxable * 0.09, 2)`)
    await q(`insert into sales.documents (id, company_id, gstin_id, doc_type, doc_no, doc_date, party_id, place_of_supply, tax_class, terms_days, due_date,
                                          taxable, cgst, sgst, igst, cess, round_off, total, status, created_at, notes)
             select id, $1::uuid, g, 'sales_invoice', doc_no, dt, party, '32', 'taxable', 30, dt + 30, taxable, cgst, cgst, 0, 0, 0, total, 'draft', dt::timestamptz, 'E2E Perf synthetic' from _d`, [coId])
    await q(`insert into sales.document_lines (document_id, line_no, product_id, description, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, cess, total)
             select id, 1, p1, 'E2E Perf item', 'NOS', 6, round(l1 / 6, 2), 0, l1, 18, round(l1 * 0.09, 2), round(l1 * 0.09, 2), 0, 0, l1 + 2 * round(l1 * 0.09, 2) from _d
             union all
             select id, 2, p2, 'E2E Perf item', 'NOS', 4, round((taxable - l1) / 4, 2), 0, taxable - l1, 18, round((taxable - l1) * 0.09, 2), round((taxable - l1) * 0.09, 2), 0, 0,
                    taxable - l1 + 2 * round((taxable - l1) * 0.09, 2) from _d`)
    await q(`insert into acct.vouchers (id, company_id, fy_id, voucher_type, doc_no, voucher_date, party_id, narration, tax_class, amount, status, source_table, source_id, client_request_id, posted_at)
             select vid, $1::uuid, fy, 'sales', doc_no, dt, party, 'E2E Perf sale', 'taxable', total, 'posted', 'sales.documents', id, gen_random_uuid(), dt::timestamptz + interval '10 hours' from _d`, [coId])
    await q(`insert into acct.gl_entries (voucher_id, company_id, account_id, party_id, entry_date, dr, cr, tax_class)
             select d.vid, $1::uuid, a.id, case when a.kind = 'party' then d.party end, d.dt,
                    case when a.kind = 'party' then d.total else 0 end,
                    case when a.kind = 'income' then d.taxable when a.kind = 'tax' then d.cgst else 0 end, 'taxable'
             from _d d cross join acct.accounts a where a.company_id = $1::uuid and a.kind in ('party', 'income', 'tax')`, [coId])
    await q(`insert into inv.stock_ledger (company_id, product_id, place_id, bucket, qty, unit_cost, value, move_type, source_table, source_id, doc_no, move_date, created_at)
             select $1::uuid, p1, pl, 'available', -6, 50, -300, 'sale', 'sales.documents', id, doc_no, dt, dt::timestamptz from _d
             union all
             select $1::uuid, p2, pl, 'available', -4, 50, -200, 'sale', 'sales.documents', id, doc_no, dt, dt::timestamptz from _d`, [coId])
    await q(`update sales.documents s set status = 'posted', voucher_id = d.vid, posted_at = d.dt::timestamptz + interval '10 hours' from _d d where s.id = d.id`)
    // Receipts for 40% of the invoices: full for i%5=0, half for i%5=1.
    await q(`insert into acct.vouchers (id, company_id, fy_id, voucher_type, doc_no, voucher_date, party_id, narration, tax_class, amount, status, mode, client_request_id, posted_at)
             select rid, $1::uuid, fy, 'receipt', rcpt_no, least(dt + 20, date '2026-11-02'), party, 'E2E Perf receipt', 'taxable',
                    case when i % 5 = 0 then total else round(total / 2, 2) end, 'posted', 'bank', gen_random_uuid(), least(dt + 20, date '2026-11-02')::timestamptz + interval '12 hours'
             from _d where i % 5 in (0, 1)`, [coId])
    await q(`insert into acct.gl_entries (voucher_id, company_id, account_id, party_id, entry_date, dr, cr, tax_class)
             select d.rid, $1::uuid, a.id, case when a.kind = 'party' then d.party end, least(d.dt + 20, date '2026-11-02'),
                    case when a.kind = 'bank' then v.amount else 0 end, case when a.kind = 'party' then v.amount else 0 end, 'taxable'
             from _d d join acct.vouchers v on v.id = d.rid cross join acct.accounts a where a.company_id = $1::uuid and a.kind in ('party', 'bank')`, [coId])
    await q(`insert into acct.bill_allocations (company_id, voucher_id, party_id, against_kind, against_id, amount, created_at)
             select $1::uuid, d.rid, d.party, 'sales_document', d.id, v.amount, v.posted_at from _d d join acct.vouchers v on v.id = d.rid`, [coId])
    await q(`insert into msg.outbox (company_id, event, template_name, party_id, doc_type, doc_id, idempotency_key, status, category, created_at, updated_at)
             select $1::uuid, 'sales.invoice', 'invoice_document', party, 'sales_document', id, 'e2eperf:' || i, 'sent', 'utility', dt::timestamptz, dt::timestamptz from _d where i % 5 = 0`, [coId])
    await q('commit')
    console.log(`docs ${from}–${to} in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  } catch (e) {
    await q('rollback')
    console.error(`chunk ${from}–${to} failed: ${e.message} ${e.detail ?? ''} ${e.where ?? ''}`)
    process.exitCode = 1
    break
  }
}
await q('analyze sales.documents; analyze sales.document_lines; analyze acct.vouchers; analyze acct.gl_entries; analyze inv.stock_ledger; analyze acct.bill_allocations; analyze msg.outbox')
const counts = await q(`select (select count(*) from sales.documents where company_id = $1) docs, (select count(*) from sales.document_lines l join sales.documents d on d.id = l.document_id where d.company_id = $1) lines,
  (select count(*) from acct.vouchers where company_id = $1) vouchers, (select count(*) from acct.gl_entries where company_id = $1) gl,
  (select count(*) from inv.stock_ledger where company_id = $1) stock, (select count(*) from acct.bill_allocations where company_id = $1) allocations,
  (select count(*) from msg.outbox where company_id = $1) outbox`, [coId])
console.table(counts)
await c.end()
