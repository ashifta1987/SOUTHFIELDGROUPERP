// Edge Function: whatsapp-sender (Phase 3 — written, not yet deployed)
// Woken by pg_cron every minute. Takes queued msg.outbox rows whose send_after has passed and re-checks every rule
// before sending (§WA-4): consent and no opt-out, document still valid, allowed hours (IST), template approved and
// active, idempotency (unique key), environment allow-list in DEV/preview. A failed check skips with a reason.
// Secrets: WHATSAPP_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_PROVIDER (meta|mock), APP_ENV (dev|preview|prod).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { MetaCloudProvider, MockProvider, type MessagingProvider } from '../_shared/messaging.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const env = Deno.env.get('APP_ENV') ?? 'dev'

function istHour(d = new Date()) { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(d)) }

Deno.serve(async () => {
  const { data: rows } = await db.schema('msg').from('outbox').select('*').eq('status', 'queued').lte('send_after', new Date().toISOString()).limit(50)
  const { data: allow } = await db.schema('msg').from('allow_list').select('number')
  const allowSet = new Set((allow ?? []).map((a: { number: string }) => a.number))
  let sent = 0, skipped = 0
  for (const m of rows ?? []) {
    const skip = async (reason: string) => { skipped++; await db.schema('msg').from('outbox').update({ status: 'skipped', skip_reason: reason, updated_at: new Date().toISOString() }).eq('id', m.id) }
    const hour = istHour()
    const [from, to] = m.window_kind === 'reminders' ? [10, 18] : [8, 21]
    if (hour < from || hour >= to) continue                       // waits for the next window
    if (!m.to_number) { await skip('no verified number'); continue }
    if (env !== 'prod' && !allowSet.has(m.to_number)) { await skip('not on the test allow-list (dev/preview)'); continue }
    const { data: tpl } = await db.schema('msg').from('templates').select('approval_status, active, params').eq('name', m.template_name).eq('language', m.language).order('version', { ascending: false }).limit(1).maybeSingle()
    if (!tpl || tpl.approval_status !== 'approved' || !tpl.active) continue      // waits; Admin is alerted on the WhatsApp screen
    if (m.doc_type === 'sales.documents') {
      const { data: doc } = await db.schema('sales').from('documents').select('status').eq('id', m.doc_id).maybeSingle()
      if (doc?.status !== 'posted') { await skip('document cancelled'); continue }
    }
    const { data: ch } = await db.schema('msg').from('channels').select('phone_number_id, status, provider').eq('company_id', m.company_id).eq('status', 'active').limit(1).maybeSingle()
    if (!ch) continue
    const provider: MessagingProvider = (Deno.env.get('WHATSAPP_PROVIDER') ?? ch.provider) === 'mock'
      ? new MockProvider()
      : new MetaCloudProvider(ch.phone_number_id, Deno.env.get('WHATSAPP_TOKEN')!, Deno.env.get('WHATSAPP_APP_SECRET')!)
    const params = (tpl.params as string[]).map((k) => String(m.params?.[k] ?? ''))
    await db.schema('msg').from('outbox').update({ status: 'sending', attempts: m.attempts + 1 }).eq('id', m.id)
    const r = await provider.sendTemplate(m.to_number, m.template_name, m.language, params)
    await db.schema('msg').from('outbox').update(r.ok
      ? { status: 'sent', wa_message_id: r.messageId, updated_at: new Date().toISOString() }
      : { status: m.attempts + 1 >= 5 ? 'failed' : 'queued', last_error: r.error, send_after: new Date(Date.now() + 2 ** (m.attempts + 1) * 60000).toISOString() }).eq('id', m.id)
    if (r.ok) sent++
  }
  return new Response(JSON.stringify({ sent, skipped }), { headers: { 'Content-Type': 'application/json' } })
})

