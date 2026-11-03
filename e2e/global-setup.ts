import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Before every run: end any time-limited roles left on the synthetic staff / third / investor logins by an interrupted spec
 * (specs give them company roles for an hour and remove them in `finally`; a crash can skip that). A leftover role
 * changes where the staff user lands after sign-in and breaks unrelated specs. Uses the synthetic admin login and
 * the normal `remove_role` RPC — no service key.
 */
function env(): Record<string, string> {
  const out: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const file of ['.env.local', '.env.test.local']) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && m[1] && out[m[1]] === undefined) out[m[1]] = m[2]!.trim()
    }
  }
  return out
}

export default async function globalSetup(): Promise<void> {
  const e = env()
  const url = e.VITE_SUPABASE_URL
  const key = e.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key || !e.E2E_ADMIN_EMAIL || !e.E2E_ADMIN_PASSWORD) return
  const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e.E2E_ADMIN_EMAIL, password: e.E2E_ADMIN_PASSWORD }),
  })
  if (!auth.ok) return
  const { access_token: token } = (await auth.json()) as { access_token: string }
  const headers = { apikey: key, Authorization: `Bearer ${token}`, 'Accept-Profile': 'api', 'Content-Profile': 'api', 'Content-Type': 'application/json' }
  const r = await fetch(`${url}/rest/v1/rpc/list_users`, { method: 'POST', headers, body: '{}' })
  if (!r.ok) return
  const users = (await r.json()) as { sign_in_email: string | null; roles: { id: string; role: string; valid_to: string | null }[] }[]
  const targets = new Set([e.E2E_STAFF_EMAIL, e.E2E_THIRD_EMAIL, e.E2E_INVESTOR_EMAIL].filter(Boolean))
  for (const u of users) {
    if (!u.sign_in_email || !targets.has(u.sign_in_email)) continue
    for (const role of u.roles ?? []) {
      if (!role.valid_to || new Date(role.valid_to) <= new Date()) continue
      await fetch(`${url}/rest/v1/rpc/remove_role`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_client_request_id: randomUUID(), p_user_role_id: role.id, p_reason: 'E2E: leftover test role from an interrupted run' }),
      })
    }
  }
}

