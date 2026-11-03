// Edge Function: bank-feed (Phase 8)
// Fetches new statement lines for every bank feed with a queued sync request (api.request_bank_feed_sync) through the
// feed provider adapter and stores them with api.bank_feed_import (same dedupe hash as the manual import). Statement
// passwords are never stored; the feed holds only the provider's opaque link id. Called by the scheduler
// (INTEGRATION_WORKER_SECRET). Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INTEGRATION_WORKER_SECRET and the feed
// provider's credentials once chosen (BANK_FEED_CLIENT_ID, BANK_FEED_CLIENT_SECRET; Q-P8-3).
import { isWorkerCall, json, rpcOf, serviceClient } from '../_shared/edge.ts'
import { processDue } from '../_shared/worker.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!isWorkerCall(req)) return json({ error: 'forbidden' }, 403)
  const res = await processDue(rpcOf(serviceClient()), ['bank_feed_sync'], { limit: 20, timeoutMs: 30000 })
  return json(res)
})
