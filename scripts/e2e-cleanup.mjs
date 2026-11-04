// Removes synthetic E2E rows from the DEV database: companies with codes starting E2E and everything under
// them, plus parties/products named "E2E …". Rows that append-only rules protect (versioned settings, loaded
// Tally vouchers, MRP history, audit history) stay; their company is then switched off instead.
import pg from 'pg'
const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const c = new pg.Client({ host: 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
const q = (sql, p) => c.query(sql, p)

await q("delete from core.form_fields where label like 'E2E Test%'")
const companies = (await q("select id from core.companies where code like 'E2E%' and code not in ('SFB', 'SFP')")).rows
let removed = 0, switchedOff = 0
for (const { id } of companies) {
  await q('begin')
  try {
    for (const sql of [
      'delete from ops.bug_items where company_id = $1',
      'delete from ops.import_rows where batch_id in (select id from ops.import_batches where company_id = $1)',
      'delete from ops.source_keys where company_id = $1',
      'delete from ops.tally_group_map where company_id = $1',
      'delete from acct.open_bills where company_id = $1',
      'delete from acct.posting_rules where company_id = $1',
      'delete from acct.accounts where company_id = $1',
      'delete from acct.account_groups where company_id = $1',
      'delete from master.price_list_items where price_list_id in (select id from master.price_lists where company_id = $1)',
      'delete from master.price_lists where company_id = $1',
      'delete from master.party_companies where company_id = $1',
      'delete from master.product_companies where company_id = $1',
      'delete from master.person_companies where company_id = $1',
      'delete from master.credit_terms where company_id = $1',
      'delete from core.form_fields where company_id = $1',
      'delete from core.doc_series where company_id = $1',
      'delete from core.periods where company_id = $1',
      'delete from core.financial_years where company_id = $1',
      'delete from core.places where company_id = $1',
      'delete from core.branches where company_id = $1',
      'delete from core.gstins where company_id = $1',
      'delete from core.departments where company_id = $1',
      'delete from core.user_scopes where company_id = $1',
      'delete from core.user_roles where company_id = $1',
      'delete from core.approval_limits where company_id = $1',
      'delete from master.product_groups where company_id = $1',
      'delete from ops.import_batches where company_id = $1',
      'delete from core.companies where id = $1',
    ]) await q(sql, [id])
    await q('commit')
    removed++
  } catch {
    await q('rollback')
    await q("update core.companies set status = 'inactive' where id = $1", [id])
    switchedOff++
  }
}
const safe = async (sql) => q(sql).catch((e) => console.error(e.message.slice(0, 120)))
await safe("delete from master.party_contacts where party_id in (select p.id from master.parties p where p.legal_name like 'E2E%' and not exists (select 1 from master.party_companies pc where pc.party_id = p.id))")
await safe("delete from master.party_addresses where party_id in (select p.id from master.parties p where p.legal_name like 'E2E%' and not exists (select 1 from master.party_companies pc where pc.party_id = p.id))")
await safe("delete from master.party_aliases where party_id in (select p.id from master.parties p where p.legal_name like 'E2E%' and not exists (select 1 from master.party_companies pc where pc.party_id = p.id))")
await safe("delete from master.parties p where p.legal_name like 'E2E%' and not exists (select 1 from master.party_companies pc where pc.party_id = p.id) and not exists (select 1 from master.party_bank_accounts b where b.party_id = p.id) and not exists (select 1 from master.bank_change_requests r where r.party_id = p.id) and not exists (select 1 from master.party_documents d where d.party_id = p.id) and not exists (select 1 from ops.tally_vouchers v where v.party_id = p.id) and not exists (select 1 from acct.accounts a where a.party_id = p.id)")
await safe("delete from master.products p where (p.name like 'E2E%' or p.code like 'E2E%') and not exists (select 1 from master.product_companies pc where pc.product_id = p.id) and not exists (select 1 from master.product_mrp_history m where m.product_id = p.id) and not exists (select 1 from master.price_list_items i where i.product_id = p.id)")
await safe("update master.products set status = 'inactive' where name like 'E2E%' or code like 'E2E%'")
await safe("update master.parties set status = 'inactive' where legal_name like 'E2E%' and status <> 'merged'")
console.log(`E2E companies: removed ${removed}, switched off ${switchedOff}`)
await c.end()

