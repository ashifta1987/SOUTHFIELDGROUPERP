#!/usr/bin/env node
// Calls one api.* RPC as the Admin login (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD from the environment or .env.test.local, never printed).
//   node scripts/admin-rpc.mjs <function> '<json args without p_client_request_id>' [--fixed-id <uuid> | --no-id]
// A fresh client request id is added unless --fixed-id is given (--no-id for read-only RPCs without one) (use the same id to retry safely). Prints the JSON result.
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function loadEnv(file) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}
loadEnv('.env.test.local')
loadEnv('.env.local')
const [fn, json = '{}', ...rest] = process.argv.slice(2)
if (!fn) { console.error('Usage: node scripts/admin-rpc.mjs <function> \'<json>\' [--fixed-id <uuid>]'); process.exit(2) }
const fixed = rest[0] === '--fixed-id' ? rest[1] : undefined
const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const s = await sb.auth.signInWithPassword({ email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD })
if (s.error) { console.error('Sign-in failed:', s.error.message); process.exit(1) }
const { data, error } = await sb.schema('api').rpc(fn, rest.includes('--no-id') ? JSON.parse(json) : { p_client_request_id: fixed ?? randomUUID(), ...JSON.parse(json) })
await sb.auth.signOut()
if (error) { console.error(`${fn}: ${error.message}${error.hint ? ` [${error.hint}]` : ''}`); process.exit(1) }
console.log(JSON.stringify(data, null, 1))
