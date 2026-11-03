// Concurrency check for the stock rule (Phase 4): two real connections each BEGIN and issue the LAST unit of the same
// item at the same place. Exactly one may commit; the other must be refused with stock.insufficient, and the balance
// must end at 0 (never negative). Runs on a synthetic E2E company it creates and switches off afterwards (stock
// ledger rows are append-only, so the company is switched off rather than deleted; the synthetic user is banned).
// Usage: DB_PASSWORD=... node scripts/concurrency-check.mjs
import pg from 'pg'
import { randomUUID } from 'node:crypto'

const pw = process.env.DB_PASSWORD
if (!pw) { console.error('Set DB_PASSWORD'); process.exit(2) }
const ref = process.env.SUPABASE_REF ?? 'fxwoabbwzcifxzqsmrie'
const client = () => new pg.Client({ host: process.env.DB_HOST ?? 'aws-0-ap-south-1.pooler.supabase.com', port: 5432, user: `postgres.${ref}`, password: pw, database: 'postgres', ssl: { rejectUnauthorized: false } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const admin = client()
const a = client()
const b = client()
await Promise.all([admin.connect(), a.connect(), b.connect()])

const tag = Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z]/g, 'X')
const pan = `ZZZZZ${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}Z`
// Financial year (April–March, IST) that contains today.
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
const [y, m] = today.split('-').map(Number)
const fyStart = m >= 4 ? y : y - 1
let ids = {}
let failures = 0
const check = (cond, msg) => { console.log(`${cond ? 'ok' : 'NOT OK'} - ${msg}`); if (!cond) failures++ }

async function setup() {
  const q = (sql, p) => admin.query(sql, p).then((r) => r.rows[0])
  await admin.query('begin')
  ids.company = (await q(`insert into core.companies (code, legal_name, short_name, pan) values ($1, 'E2E Concurrency Test Pvt Ltd', 'E2E Concurrency', $2) returning id`, [`E2E${tag}`, pan])).id
  ids.branch = (await q(`insert into core.branches (company_id, code, name, kind) values ($1, 'E2EB', 'E2E Branch', 'factory') returning id`, [ids.company])).id
  ids.place = (await q(`insert into core.places (company_id, branch_id, code, name, kind) values ($1, $2, 'E2EP', 'E2E Stores', 'stores') returning id`, [ids.company, ids.branch])).id
  ids.fy = (await q(`insert into core.financial_years (company_id, label, starts_on, ends_on) values ($1, $2, $3, $4) returning id`,
    [ids.company, `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`, `${fyStart}-04-01`, `${fyStart + 1}-03-31`])).id
  await admin.query(`insert into core.periods (company_id, fy_id, month_start) select $1, $2, ($3::date + (n || ' month')::interval)::date from generate_series(0, 11) n`, [ids.company, ids.fy, `${fyStart}-04-01`])
  ids.product = (await q(`insert into master.products (code, name, uom, status, kind) values ($1, 'E2E Concurrency Item', 'NOS', 'active', 'raw_material') returning id`, [`E2ECC${tag}`])).id
  ids.user = randomUUID()
  await admin.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), '{}', '{"full_name":"E2E Concurrency"}', now(), now())`,
    [ids.user, `e2e.concurrency.${tag.toLowerCase()}@example.test`])
  // Stores (issue) and factory manager (opening stock) rights, for the E2E company only.
  await admin.query(`insert into core.user_roles (user_id, role_key, company_id) values ($1, 'production_manager', $2), ($1, 'factory_manager', $2)`, [ids.user, ids.company])
  await admin.query('commit')
}

// Act as the synthetic user inside the current transaction (role authenticated, JWT sub), like the pgTAP helpers.
async function actAs(c) {
  await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [JSON.stringify({ sub: ids.user, role: 'authenticated' }), ids.user])
  await c.query('set local role authenticated')
}

async function openingUnit() {
  await admin.query('begin')
  await actAs(admin)
  await admin.query(`select api.post_opening_stock($1, jsonb_build_object('company_id', $2::uuid, 'place_id', $3::uuid, 'date', $4::date,
    'lines', jsonb_build_array(jsonb_build_object('product_id', $5::uuid, 'qty', 1, 'unit_cost', 10))))`, [randomUUID(), ids.company, ids.place, today, ids.product])
  await admin.query('commit')
}

const balance = async () => Number((await admin.query(`select coalesce(sum(qty), 0) as q from inv.stock_balances where product_id = $1 and place_id = $2 and bucket = 'available'`, [ids.product, ids.place])).rows[0].q)
const issues = async () => Number((await admin.query(`select count(*) as n from inv.stock_ledger where product_id = $1 and move_type = 'issue'`, [ids.product])).rows[0].n)

function issue(c, name) {
  return (async () => {
    await c.query('begin')
    await actAs(c)
    const t0 = Date.now()
    try {
      const r = await c.query(`select api.issue_stock($1, $2, null, $3, 1, jsonb_build_object('kind', 'production', 'ref', 'E2E concurrency', 'date', $4::text)) as r`,
        [randomUUID(), ids.product, ids.place, today])
      return { name, c, ok: true, doc: r.rows[0].r.doc_no, ms: Date.now() - t0 }
    } catch (e) {
      return { name, c, ok: false, hint: e.hint, message: e.message, ms: Date.now() - t0 }
    }
  })()
}

// Both start together; whichever finishes first commits, then the other is awaited (it waits on the lock until then).
async function round(label, staggerMs) {
  console.log(`\n# ${label}`)
  await openingUnit()
  check((await balance()) === 1, 'one unit on hand before the race')
  const before = await issues()
  const pA = issue(a, 'A')
  if (staggerMs) await sleep(staggerMs)
  const pB = issue(b, 'B')
  const first = await Promise.race([pA, pB])
  const otherP = first.name === 'A' ? pB : pA
  // Prove the other connection is really blocked behind the first one's locks while its transaction is open.
  const stillWaiting = await Promise.race([otherP.then(() => false), sleep(1500).then(() => true)])
  console.log(`  ${first.name}: ${first.ok ? `issued ${first.doc}` : `refused (${first.hint}) ${first.message}`} after ${first.ms} ms; other connection still waiting on the lock: ${stillWaiting}`)
  await first.c.query(first.ok ? 'commit' : 'rollback')
  const second = await otherP
  console.log(`  ${second.name}: ${second.ok ? `issued ${second.doc}` : `refused (${second.hint}) ${second.message}`} after ${second.ms} ms`)
  await second.c.query(second.ok ? 'commit' : 'rollback').catch(() => {})
  const oks = [first, second].filter((x) => x.ok).length
  check(oks === 1, 'exactly one of the two issues committed')
  const loser = first.ok ? second : first
  check(!loser.ok && loser.hint === 'stock.insufficient', `the other was refused with the stock rule (hint ${loser.hint})`)
  check(stillWaiting, 'the second transaction waited for the first (row/advisory lock held until commit)')
  check((await balance()) === 0, `the balance ends at 0 (is ${await balance()})`)
  check((await issues()) - before === 1, 'exactly one issue row was added to the ledger')
}

async function switchOff() {
  if (!ids.company) return
  await admin.query('reset role').catch(() => {})
  await admin.query(`update core.companies set status = 'inactive' where id = $1`, [ids.company])
  await admin.query(`update core.user_roles set valid_to = now() where user_id = $1 and (valid_to is null or valid_to > now())`, [ids.user]).catch((e) => console.error('roles:', e.message))
  await admin.query(`update auth.users set banned_until = 'infinity' where id = $1`, [ids.user]).catch((e) => console.error('ban:', e.message))
  console.log(`\nE2E company E2E${tag} switched off; synthetic user banned.`)
}

try {
  await setup()
  console.log(`E2E company E2E${tag}, item ${ids.product}, place ${ids.place}, date ${today}`)
  await round('Round 1: both connections start at the same moment', 0)
  await round('Round 2: B starts 200 ms after A (A holds its transaction open)', 200)
} catch (e) {
  failures++
  console.error('ERROR:', e.message, e.hint ?? '', e.where ?? '')
  for (const c of [admin, a, b]) await c.query('rollback').catch(() => {})
} finally {
  await switchOff().catch((e) => console.error('switch off failed:', e.message))
  await Promise.all([admin.end(), a.end(), b.end()])
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll concurrency checks passed')
process.exit(failures ? 1 : 0)
