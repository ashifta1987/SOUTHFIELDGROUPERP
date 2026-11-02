// Run SQL against the DEV database. Usage: DB_PASSWORD=... node scripts/sql.mjs "<sql>" | -f file.sql
import pg from 'pg'
import { readFileSync } from 'node:fs'
const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
const args = process.argv.slice(2)
const sql = args[0] === '-f' ? readFileSync(args[1], 'utf8') : args.join(' ')
const c = new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
try {
  const res = await c.query(sql)
  for (const r of [].concat(res)) if (r.rows?.length) console.table(r.rows)
} catch (e) { console.error('ERROR:', e.message, e.detail ?? '', e.where ?? ''); process.exitCode = 1 } finally { await c.end() }
