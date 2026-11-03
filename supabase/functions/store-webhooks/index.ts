// Edge Function: store-webhooks (Phase 8)
// Online store webhooks: …/functions/v1/store-webhooks?provider=shopify|amazon|flipkart|jiomart|meesho&channel=<online channel id>
//   &forceFunctionRegion=ap-south-1
// 1. verify the signature on the raw body with the provider adapter (Shopify: base64 HMAC-SHA256, documented; the others:
//    generic timestamped HMAC on our relay until their scheme is confirmed — Q-P8-4);
// 2. record the event once in ops.webhook_events (dedupe on the provider's event id); 3. answer 200 at once;
// 4. in the background: normalise the order and stage it in sales.channel_sync_log. A person with sales rights brings
//    staged orders in (api.ingest_staged_channel_orders → Phase 6 api.ingest_online_order: prices, GST, stock) — Q-P8-6.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STORE_WEBHOOK_SECRET_SHOPIFY, …_AMAZON, …_FLIPKART, …_JIOMART, …_MEESHO.
import { background, json, rpcOf, serviceClient } from '../_shared/edge.ts'
import { STORE_ADAPTERS } from '../_shared/stores.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const url = new URL(req.url)
  const adapter = STORE_ADAPTERS[url.searchParams.get('provider') ?? '']
  const channelId = url.searchParams.get('channel') ?? ''
  if (!adapter || !/^[0-9a-f-]{36}$/i.test(channelId)) return json({ error: 'unknown provider or channel' }, 404)
  const raw = await req.text()
  const secret = Deno.env.get(`STORE_WEBHOOK_SECRET_${adapter.provider.toUpperCase()}`) ?? ''
  const ok = await adapter.verify(raw, req.headers, secret)
  let body: unknown = {}
  if (ok) { try { body = JSON.parse(raw) } catch { return json({ error: 'bad json' }, 400) } }
  const eventId = adapter.eventId(req.headers, body)
  if (!eventId) return json({ error: 'no event id' }, 400)
  const topic = adapter.topic(req.headers, body)
  const rpc = rpcOf(serviceClient())
  const ev = (await rpc('ingest_webhook', { p_provider: adapter.provider, p_external_id: eventId, p_signature_ok: ok, p_topic: topic, p_payload: ok ? body : {} })) as
    { event_id: number; accepted: boolean; duplicate: boolean }
  if (!ok) return json({ error: 'bad signature' }, 401)
  if (!ev.accepted) return json({ ok: true, duplicate: true })
  background((async () => {
    const kind = adapter.kind(topic)
    if (!kind) { await rpc('finish_webhook', { p_event_id: ev.event_id, p_status: 'ignored', p_result: { topic }, p_error: null }); return }
    const order = adapter.normaliseOrder(body)
    if (!order) { await rpc('finish_webhook', { p_event_id: ev.event_id, p_status: 'failed', p_result: null, p_error: 'order could not be read (sku, state or lines missing)' }); return }
    try {
      const res = await rpc('stage_channel_event', { p_event_id: ev.event_id, p_channel_id: channelId, p_kind: kind, p_external_id: order.external_order_id, p_detail: order })
      await rpc('finish_webhook', { p_event_id: ev.event_id, p_status: 'processed', p_result: res, p_error: null })
    } catch (e) {
      await rpc('finish_webhook', { p_event_id: ev.event_id, p_status: 'failed', p_result: null, p_error: e instanceof Error ? e.message : String(e) })
    }
  })())
  return json({ ok: true })
})
