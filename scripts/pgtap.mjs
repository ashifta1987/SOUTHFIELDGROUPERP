// pgTAP runner for the DEV database (no Docker needed). Each test file runs in its own transaction with
// supabase/tests/_setup.sql, and is always rolled back. Usage: DB_PASSWORD=... node scripts/pgtap.mjs
import pg from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
const dir = process.env.TEST_DIR ?? 'supabase/tests'
const setup = readFileSync(`${dir}/_setup.sql`, 'utf8')
const files = readdirSync(dir).filter((f) => /^\d.*\.sql$/.test(f)).sort()
let failed = 0, passed = 0
for (const f of files) {
  const c = new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
  await c.connect()
  console.log(`# ${f}`)
  try {
    await c.query('begin')
    await c.query('set local search_path = extensions, public')
    await c.query(setup)
    const res = await c.query(readFileSync(`${dir}/${f}`, 'utf8'))
    for (const r of [].concat(res)) for (const row of r.rows ?? []) {
      for (const v of Object.values(row)) {
        if (typeof v !== 'string') continue
        for (const line of v.split('\n')) {
          if (/^(not ok|ok|1\.\.|#)/.test(line)) console.log('  ' + line)
          if (/^not ok/.test(line)) failed++
          else if (/^ok/.test(line)) passed++
        }
      }
    }
  } catch (e) {
    failed++
    console.log(`  not ok - ${f} errored: ${e.message} ${e.where ?? ''}`)
  } finally {
    await c.query('rollback').catch(() => {})
    await c.end()
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
