// Edge Function: admin-users (Phase 1)
// Creates or disables a sign-in account. Only an Admin may call it. The service-role key is read from the
// function's secrets and never leaves this function. The role is then assigned with api.assign_role using the
// caller's own token, so the audit trail records the Admin as the actor.
//
// Deploy (owner, once):  supabase login && supabase functions deploy admin-users --project-ref <ref>
// Region: invoke with the x-region: ap-south-1 header (data stays in India).
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface CreateBody {
  action: 'create'
  display_name: string
  phone?: string // 10-digit Indian mobile, stored as +91…
  email?: string
  password: string
  role: string
  company_id?: string | null
  valid_to?: string | null
  reason: string
}
interface DisableBody {
  action: 'disable'
  user_id: string
  reason: string
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const auth = req.headers.get('Authorization') ?? ''

  // The caller, with their own rights.
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: auth } }, db: { schema: 'api' } })
  const { data: me, error: meErr } = await asCaller.rpc('me')
  if (meErr || !me || me.view !== 'all') return json(403, { error: 'admin_only', rule: 'rights.missing' })

  const body = (await req.json()) as CreateBody | DisableBody
  if (!body.reason || body.reason.trim().length < 5) return json(400, { error: 'reason_required', rule: 'rights.reason_required' })

  const admin = createClient(url, service, { auth: { persistSession: false } })

  if (body.action === 'disable') {
    if (body.user_id === me.user_id) return json(400, { error: 'self_disable', rule: 'users.self_disable' })
    const { error } = await admin.auth.admin.updateUserById(body.user_id, { ban_duration: '876000h' })
    if (error) return json(400, { error: error.message })
    await asCaller.rpc('update_user_profile', { p_client_request_id: crypto.randomUUID(), p_user_id: body.user_id, p: { status: 'disabled' } })
    return json(200, { ok: true })
  }

  if (body.action !== 'create') return json(400, { error: 'bad_action' })
  const phone = body.phone ? body.phone.replace(/\D/g, '') : ''
  if (phone && !/^[6-9]\d{9}$/.test(phone)) return json(400, { error: 'bad_phone', rule: 'auth.errors.phone' })
  if (!phone && !body.email) return json(400, { error: 'phone_or_email_required' })
  if (!body.password || body.password.length < 10) return json(400, { error: 'weak_password' })

  const { data: created, error } = await admin.auth.admin.createUser({
    email: body.email || undefined,
    phone: phone ? `+91${phone}` : undefined,
    password: body.password,
    email_confirm: Boolean(body.email),
    phone_confirm: Boolean(phone),
    user_metadata: { full_name: body.display_name },
  })
  if (error || !created.user) return json(400, { error: error?.message ?? 'create_failed' })

  const { error: roleErr } = await asCaller.rpc('assign_role', {
    p_client_request_id: crypto.randomUUID(),
    p_user_id: created.user.id,
    p_role: body.role,
    p_company_id: body.company_id ?? null,
    p_valid_to: body.valid_to ?? null,
    p_reason: body.reason,
  })
  if (roleErr) return json(400, { error: roleErr.message, rule: roleErr.hint, user_id: created.user.id })
  return json(200, { user_id: created.user.id })
})

