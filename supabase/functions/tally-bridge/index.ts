// Edge Function: tally-bridge (Phase 2 — written, not yet deployed)
// The Tally bridge on the "import computer" (a Windows PC in India with TallyPrime) talks ONLY to this function,
// with its own device key (never the Supabase secret key). It:
//   GET  ?action=next            → the next batch waiting for a bridge (status awaiting_bridge) + a signed URL for the TBK file
//   POST ?action=rows&batch=<id> → staged rows (JSON array, same shape as the browser import) read from the restored
//                                  company through TallyPrime's XML/HTTP interface (port 9000)
//   POST ?action=done&batch=<id> → marks the batch staged and runs api.import_process as the batch's creator
// The bridge restores the TBK into its own Tally data folder, never over the live Tally data.
//
// Deploy (owner, once):  supabase functions deploy tally-bridge --no-verify-jwt --project-ref <ref>
// Device keys: insert a row in ops.bridge_devices with key_hash = sha256(hex) of the key you give the bridge.
import { createClient } from 'npm:@supabase/supabase-js@2'

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const key = req.headers.get('x-bridge-key') ?? ''
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const { data: device } = await admin.schema('ops').from('bridge_devices').select('id, status').eq('key_hash', await sha256(key)).maybeSingle()
  if (!device || device.status !== 'active') return json(401, { error: 'unknown_device' })
  await admin.schema('ops').from('bridge_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id)

  const action = url.searchParams.get('action')
  if (action === 'next') {
    const { data: batch } = await admin.schema('ops').from('import_batches').select('id, code, company_id, storage_path, file_name')
      .eq('status', 'awaiting_bridge').order('created_at').limit(1).maybeSingle()
    if (!batch) return json(200, { batch: null })
    const { data: signed } = await admin.storage.from('imports').createSignedUrl(batch.storage_path, 600)
    return json(200, { batch, download_url: signed?.signedUrl })
  }
  const batchId = url.searchParams.get('batch')
  if (!batchId) return json(400, { error: 'batch_required' })
  if (action === 'rows') {
    const rows = await req.json()
    const { data: start } = await admin.schema('ops').from('import_rows').select('seq').eq('batch_id', batchId).order('seq', { ascending: false }).limit(1).maybeSingle()
    const base = start?.seq ?? 0
    const insert = (rows as Array<Record<string, unknown>>).map((r, i) => ({ batch_id: batchId, seq: base + i + 1, object_type: r.object_type, name: r.name,
      guid: r.guid, master_id: r.master_id, alter_id: r.alter_id, payload: r.payload ?? {} }))
    const { error } = await admin.schema('ops').from('import_rows').insert(insert)
    if (error) return json(400, { error: error.message })
    return json(200, { staged: insert.length })
  }
  if (action === 'done') {
    await admin.schema('ops').from('import_batches').update({ status: 'staged' }).eq('id', batchId)
    // Processing is triggered by the Admin from the Import screen (it runs with the Admin's own rights).
    return json(200, { ok: true, next: 'Admin presses "Check and load" on the Import screen' })
  }
  return json(400, { error: 'bad_action' })
})

