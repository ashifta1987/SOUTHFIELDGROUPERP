// Edge Function: gps-intake (Phase 8)
// Receives location points pushed by the GPS provider. Order of work: verify the HMAC signature on the raw body
// (header X-Signature = hex HMAC-SHA256 of `${X-Timestamp}.${body}`, 5-minute replay window — generic scheme until the
// provider is chosen, Q-P8-2), deduplicate the delivery in ops.webhook_events, answer 200, then store the points with
// api.gps_ingest, which keeps only points inside the device user's open duty session (DPDP: on duty only; purged after
// 90 days by app.purge_gps). URL: …/functions/v1/gps-intake?provider=<name>&forceFunctionRegion=ap-south-1
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GPS_WEBHOOK_SECRET.
import { background, json, rpcOf, serviceClient } from '../_shared/edge.ts'
import { sha256Hex, verifyGenericHmac } from '../_shared/hmac.ts'
import { parseGpsPayload } from '../_shared/adapters.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const provider = (new URL(req.url).searchParams.get('provider') ?? 'gps').toLowerCase().replace(/[^a-z0-9_]/g, '')
  const raw = await req.text()
  const ok = await verifyGenericHmac(raw, req.headers.get('x-signature'), Deno.env.get('GPS_WEBHOOK_SECRET') ?? '', { timestamp: req.headers.get('x-timestamp') })
  const rpc = rpcOf(serviceClient())
  const eventId = req.headers.get('x-event-id') ?? (await sha256Hex(raw))
  let body: unknown = {}
  try { body = ok ? JSON.parse(raw) : {} } catch { return json({ error: 'bad json' }, 400) }
  const ev = (await rpc('ingest_webhook', { p_provider: `gps_${provider}`, p_external_id: eventId, p_signature_ok: ok, p_topic: 'points', p_payload: {} })) as
    { event_id: number; accepted: boolean; duplicate: boolean }
  if (!ok) return json({ error: 'bad signature' }, 401)
  if (!ev.accepted) return json({ ok: true, duplicate: true })
  background((async () => {
    const { deviceRef, points } = parseGpsPayload(body)
    try {
      const res = await rpc('gps_ingest', { p_provider: provider, p_device_ref: deviceRef ?? '', p_points: points })
      await rpc('finish_webhook', { p_event_id: ev.event_id, p_status: 'processed', p_result: res, p_error: null })
    } catch (e) {
      await rpc('finish_webhook', { p_event_id: ev.event_id, p_status: 'failed', p_result: null, p_error: e instanceof Error ? e.message : String(e) })
    }
  })())
  return json({ ok: true })
})
