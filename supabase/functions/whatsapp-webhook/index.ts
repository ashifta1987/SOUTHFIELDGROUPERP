// Edge Function: whatsapp-webhook (Phase 3 — written, not yet deployed)
// Verifies X-Hub-Signature-256, deduplicates, updates message statuses, stores inbound messages, handles STOP
// (opt-out at once, in English, Malayalam, Tamil or Hindi words) and "Statement" requests (queued as a service reply).
// GET handles Meta's verification challenge with WHATSAPP_VERIFY_TOKEN.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { MetaCloudProvider } from '../_shared/messaging.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const STOP_WORDS = ['stop', 'unsubscribe', 'നിർത്തുക', 'நிறுத்து', 'बंद']
const STATEMENT_WORDS = ['statement', 'സ്റ്റേറ്റ്മെന്റ്', 'அறிக்கை', 'स्टेटमेंट']

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (req.method === 'GET') {
    if (url.searchParams.get('hub.verify_token') === Deno.env.get('WHATSAPP_VERIFY_TOKEN')) return new Response(url.searchParams.get('hub.challenge') ?? '')
    return new Response('forbidden', { status: 403 })
  }
  const raw = await req.text()
  const provider = new MetaCloudProvider('', Deno.env.get('WHATSAPP_TOKEN')!, Deno.env.get('WHATSAPP_APP_SECRET')!)
  if (!(await provider.verifyWebhook(raw, req.headers.get('x-hub-signature-256')))) return new Response('bad signature', { status: 401 })
  const { inbound, statuses } = provider.parseWebhook(JSON.parse(raw))
  for (const s of statuses) {
    const { error } = await db.schema('msg').from('events').insert({ wa_message_id: s.waMessageId, status: s.status, payload: s })
    if (error) continue // duplicate event
    await db.schema('msg').from('outbox').update({ status: s.status, last_error: s.error ?? null, updated_at: new Date().toISOString() }).eq('wa_message_id', s.waMessageId)
  }
  for (const m of inbound) {
    const text = (m.text ?? '').trim().toLowerCase()
    const { data: contact } = await db.schema('master').from('party_contacts').select('id, party_id').eq('whatsapp', m.from).limit(1).maybeSingle()
    await db.schema('msg').from('inbound').upsert({ wa_message_id: m.waMessageId, from_number: m.from, kind: m.kind, body: m.text ?? null, party_id: contact?.party_id ?? null,
      window_expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }, { onConflict: 'wa_message_id', ignoreDuplicates: true })
    if (contact && STOP_WORDS.some((w) => text === w)) {
      await db.schema('master').from('party_contacts').update({ whatsapp_consent: false, consent_at: null }).eq('id', contact.id)
      await provider.sendText(m.from, 'You will not get WhatsApp messages from us any more. Reply START to opt in again.')
    }
    if (contact && STATEMENT_WORDS.some((w) => text.includes(w))) {
      // Statement on request: Admin's queue picks it up (statement PDF is built by the server for that customer).
      await db.schema('msg').from('outbox').insert({ company_id: null, event: 'sales.statement_request', template_name: 'statement_monthly', to_number: m.from,
        party_id: contact.party_id, idempotency_key: 'stmtreq|' + m.waMessageId, status: 'queued' }).then(() => undefined)
    }
  }
  return new Response('ok')
})

