// RLS / grants audit for the app schemas (Phase 9 security review). Read-only: it only queries the catalogue.
// Usage: DB_PASSWORD=... node scripts/rls-audit.mjs [--json] [--tables]
//   --tables  also print the per-table list (RLS on/forced, policy count)
//   --json    print the whole report as JSON
// Exits 1 when there is at least one finding, so CI can gate on it.
import pg from 'pg'

const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
const args = new Set(process.argv.slice(2))

// Schemas that hold business data or app code. Supabase-managed schemas (auth, storage, realtime, vault, cron,
// extensions, graphql*) are out of scope here; storage.objects policies are listed separately below.
const APP_SCHEMAS = ['acct', 'api', 'app', 'audit', 'core', 'field', 'help', 'hr', 'inv', 'master', 'msg', 'ops', 'prod', 'purch', 'sales', 'public']
const TABLE_SCHEMAS = APP_SCHEMAS.filter((s) => !['api', 'app'].includes(s))
// RPCs a signed-out browser may call (documented in docs/SECURITY.md → "Phase 9 review").
const ANON_RPC_ALLOW = new Set(['log_sign_in_failure', 'sign_in_methods', 'phone_sign_in_allowed', 'investor_sign_in_allowed'])

const c = new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
const q = async (sql, params) => (await c.query(sql, params)).rows

const tables = await q(`
  select n.nspname as schema, c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
         (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname = any($1)
  order by 1, 2`, [TABLE_SCHEMAS])

const permissive = await q(`
  select schemaname as schema, tablename as table, policyname as policy, cmd, roles::text as roles, qual, with_check
  from pg_policies
  where schemaname = any($1)
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and (roles && array['authenticated', 'public', 'anon']::name[])
    and (coalesce(trim(qual), '') = 'true' or coalesce(trim(with_check), '') = 'true')
  order by 1, 2`, [TABLE_SCHEMAS])

const views = await q(`
  select n.nspname as schema, c.relname as view, coalesce(array_to_string(c.reloptions, ','), '') as options
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'v' and n.nspname = 'api'
    and not coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false)
  order by 2`)

const definerNoPath = await q(`
  select n.nspname as schema, p.proname as function, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and n.nspname = any($1)
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')
  order by 1, 2`, [APP_SCHEMAS])

const anonExec = (await q(`
  select n.nspname as schema, p.proname as function, pg_get_function_identity_arguments(p.oid) as args, p.provolatile as volatility
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = any($1) and has_function_privilege('anon', p.oid, 'execute')
  order by 1, 2`, [APP_SCHEMAS])).filter((r) => !(r.schema === 'api' && ANON_RPC_ALLOW.has(r.function)))

// Any function (definer or not) in api/app without a pinned search_path (Supabase linter: function_search_path_mutable).
const mutablePath = await q(`
  select n.nspname as schema, p.proname as function, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('api', 'app') and p.prokind = 'f' and not p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')
  order by 1, 2`)

// The documented sign-in RPCs that must stay callable before a session exists.
const missingAnon = await q(`
  select p.proname as function from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api' and p.proname = 'log_sign_in_failure' and not has_function_privilege('anon', p.oid, 'execute')`)

const anonTables = await q(`
  select n.nspname as schema, c.relname as relation, c.relkind as kind,
         array_remove(array[
           case when has_table_privilege('anon', c.oid, 'select') then 'select' end,
           case when has_table_privilege('anon', c.oid, 'insert') then 'insert' end,
           case when has_table_privilege('anon', c.oid, 'update') then 'update' end,
           case when has_table_privilege('anon', c.oid, 'delete') then 'delete' end], null)::text as privileges
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm') and n.nspname = any($1)
    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
      or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))
  order by 1, 2`, [APP_SCHEMAS])

// Writes go only through api RPCs: authenticated should hold no insert/update/delete on base tables or api views.
const authWrites = await q(`
  select n.nspname as schema, c.relname as relation,
         array_remove(array[
           case when has_table_privilege('authenticated', c.oid, 'insert') then 'insert' end,
           case when has_table_privilege('authenticated', c.oid, 'update') then 'update' end,
           case when has_table_privilege('authenticated', c.oid, 'delete') then 'delete' end,
           case when has_table_privilege('authenticated', c.oid, 'truncate') then 'truncate' end], null)::text as privileges
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v') and n.nspname = any($1)
    and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
      or has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('authenticated', c.oid, 'truncate'))
  order by 1, 2`, [APP_SCHEMAS])

const exposed = await q(`select coalesce((select split_part(cfg, '=', 2) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) cfg
                          where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%' limit 1), '(default)') as schemas`)

const storagePolicies = await q(`select policyname as policy, cmd, roles::text as roles from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1`)
const buckets = await q(`select id, public from storage.buckets order by 1`).catch(() => [])
const publicBuckets = buckets.filter((b) => b.public)

await c.end()

const findings = {
  rls_off: tables.filter((t) => !t.rls),
  no_policies: tables.filter((t) => t.rls && t.policies === 0),
  permissive_write_policies: permissive,
  api_views_without_security_invoker: views,
  security_definer_without_search_path: definerNoPath,
  invoker_functions_with_mutable_search_path: mutablePath,
  anon_executable_functions: anonExec,
  sign_in_rpcs_missing_anon_grant: missingAnon,
  anon_table_grants: anonTables,
  authenticated_write_grants: authWrites,
  public_storage_buckets: publicBuckets,
}
const total = Object.values(findings).reduce((n, a) => n + a.length, 0)

if (args.has('--json')) {
  console.log(JSON.stringify({ exposed_schemas: exposed[0]?.schemas, tables, storage_policies: storagePolicies, buckets, findings, total }, null, 2))
} else {
  console.log(`Exposed Data API schemas: ${exposed[0]?.schemas}`)
  console.log(`Tables audited: ${tables.length} in ${TABLE_SCHEMAS.join(', ')}`)
  console.log(`  RLS enabled: ${tables.filter((t) => t.rls).length}, forced: ${tables.filter((t) => t.forced).length}, with ≥1 policy: ${tables.filter((t) => t.policies > 0).length}`)
  console.log(`Storage: ${buckets.length} buckets (${publicBuckets.length} public), ${storagePolicies.length} storage.objects policies`)
  if (args.has('--tables')) console.table(tables)
  for (const [k, rows] of Object.entries(findings)) {
    console.log(`\n${rows.length ? '✗' : '✓'} ${k}: ${rows.length}`)
    if (rows.length) console.table(rows)
  }
  console.log(`\n${total} finding(s)`)
}
process.exit(total ? 1 : 0)
