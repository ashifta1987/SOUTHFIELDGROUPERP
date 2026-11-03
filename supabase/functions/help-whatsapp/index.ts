// Edge Function: help-whatsapp (§HELP-8)
// The help assistant on the company WhatsApp help number, for VERIFIED STAFF NUMBERS ONLY (help.whatsapp_staff, verified
// by Admin against the staff record, with consent). Limited to how-to answers, filing a problem, handoff and ticket status:
// NO data tools (api.help_wa_tool refuses anything else). Business-specific and always offers a person (Meta's rules for
// AI on the WhatsApp Business Platform). Unverified numbers get no reply and nothing is kept beyond the deduped event id.
// Order of work: verify X-Hub-Signature-256 on the raw body → dedupe each message in ops.webhook_events → 200 at once →
// answer in the background. Voice notes are transcribed (adapter; mock until the owner picks a provider).
// GET answers Meta's verification challenge (HELP_WHATSAPP_VERIFY_TOKEN).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHATSAPP_APP_SECRET, WHATSAPP_TOKEN, HELP_WHATSAPP_PHONE_NUMBER_ID,
// HELP_WHATSAPP_VERIFY_TOKEN, HELP_AI_PROVIDER, HELP_AI_API_KEY, HELP_ALLOW_MOCK, WHATSAPP_PROVIDER (mock on DEV).
import { background, json, rpcOf, serviceClient } from '../_shared/edge.ts'
import { MetaCloudProvider, MockProvider, type MessagingProvider } from '../_shared/messaging.ts'
import { MockModel, UnconfiguredModel, WHATSAPP_TOOLS, runHelpTurn, type ModelAdapter } from '../_shared/llm.ts'
import { redactText, redactValue } from '../_shared/redact.ts'
import { MockTranscriber } from '../_shared/adapters.ts'
import { withTimeout } from '../_shared/worker.ts'

const OFFER_PERSON = '\n\nReply PERSON to talk to someone at the office.'

function modelFor(): ModelAdapter {
  const p = Deno.env.get('HELP_AI_PROVIDER') ?? 'mock'
  return p === 'mock' && Deno.env.get('HELP_ALLOW_MOCK') === 'true' ? new MockModel() : new UnconfiguredModel(p)
}

function provider(): MessagingProvider {
  return Deno.env.get('WHATSAPP_PROVIDER') === 'mock'
    ? new MockProvider()
    : new MetaCloudProvider(Deno.env.get('HELP_WHATSAPP_PHONE_NUMBER_ID') ?? '', Deno.env.get('WHATSAPP_TOKEN') ?? '', Deno.env.get('WHATSAPP_APP_SECRET') ?? '')
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === Deno.env.get('HELP_WHATSAPP_VERIFY_TOKEN')
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '') : new Response('forbidden', { status: 403 })
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const raw = await req.text()
  const wa = provider()
  if (!(await wa.verifyWebhook(raw, req.headers.get('x-hub-signature-256')))) return json({ error: 'bad signature' }, 401)
  const body = JSON.parse(raw)
  const { inbound } = wa.parseWebhook(body)
  const rpc = rpcOf(serviceClient())
  for (const m of inbound) {
    const ev = (await rpc('ingest_webhook', { p_provider: 'whatsapp_help', p_external_id: m.waMessageId, p_signature_ok: true, p_topic: m.kind, p_payload: {} })) as
      { event_id: number; accepted: boolean }
    if (!ev.accepted) continue
    background((async () => {
      let text = m.text ?? ''
      if (!text && m.kind === 'audio') text = (await new MockTranscriber().transcribe(new Uint8Array(), 'audio/ogg', 'en')).text
      const gate = (await rpc('help_whatsapp_inbound', { p_event_id: ev.event_id, p_from: m.from, p_kind: m.kind === 'audio' ? 'voice' : 'text', p_text: redactText(text) })) as
        { allowed: boolean }
      if (!gate.allowed) { await rpc('finish_webhook', { p_event_id: ev.event_id, p_status: 'ignored', p_result: { reason: 'unverified' }, p_error: null }); return }
      let reply: string
      if (/^\s*person\s*$/i.test(text)) {
        await rpc('help_wa_tool', { p_number: m.from, p_tool: 'handoff', p_args: { what_happened: 'Asked for a person on WhatsApp help' } })
        reply = 'Thank you. Someone from the office will contact you.'
      } else {
        try {
          const res = await withTimeout(runHelpTurn({ model: modelFor(), tools: WHATSAPP_TOOLS, history: [], userText: text, redact: redactValue,
            callTool: (tool, args) => rpc('help_wa_tool', { p_number: m.from, p_tool: tool, p_args: args }) }), 20000)
          reply = res.text + OFFER_PERSON
        } catch {
          const filed = (await rpc('help_wa_tool', { p_number: m.from, p_tool: 'create_problem_report', p_args: { what_happened: text || 'WhatsApp help question' } })
            .catch(() => null)) as { code?: string } | null
          reply = `I can't answer right now. I've saved your problem as ${filed?.code ?? 'a report'}.` + OFFER_PERSON
        }
      }
      const sent = await wa.sendText(m.from, reply.slice(0, 4000))
      await rpc('help_wa_log_reply', { p_number: m.from, p_text: reply })
      await rpc('finish_webhook', { p_event_id: ev.event_id, p_status: sent.ok ? 'processed' : 'failed', p_result: null, p_error: sent.ok ? null : sent.error ?? 'send failed' })
    })())
  }
  return json({ ok: true })
})
