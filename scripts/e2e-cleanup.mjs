// Removes synthetic E2E rows from the DEV database (company codes starting E2E and everything under them).
// History rows stay: the audit trail is append-only by design.
import pg from 'pg'
const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const c = new pg.Client({ host: 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
await c.query("delete from core.form_fields where label like 'E2E Test%'")
// Companies with append-only settings rows can't be deleted; they are switched off instead.
await c.query("update core.companies set status = 'inactive' where code like 'E2E%' and id in (select company_id from core.settings where company_id is not null)")
const ids = (await c.query("select id from core.companies where code like 'E2E%' and id not in (select company_id from core.settings where company_id is not null)")).rows.map((r) => r.id)
if (ids.length) {
  for (const t of ['core.form_fields', 'core.doc_series', 'core.periods', 'core.financial_years', 'core.places', 'core.branches', 'core.gstins', 'core.departments', 'core.user_scopes', 'core.user_roles', 'core.approval_limits', 'core.settings']) {
    if (t === 'core.settings') continue // settings are append-only
    await c.query(`delete from ${t} where company_id = any($1)`, [ids])
  }
  await c.query('delete from core.companies where id = any($1)', [ids])
}
console.log(`removed ${ids.length} E2E companies`)
await c.end()
