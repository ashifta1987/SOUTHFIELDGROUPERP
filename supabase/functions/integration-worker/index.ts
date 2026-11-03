// Edge Function: integration-worker (Phase 8)
// Processes every due ops.integration_requests row (all kinds) with back-off and dead letter handled in Postgres.
// Called by the scheduler every minute: Supabase Cron → pg_net POST with `Authorization: Bearer <INTEGRATION_WORKER_SECRET>`
// and header `x-region: ap-south-1`. Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INTEGRATION_WORKER_SECRET,
// provider credentials per adapter (none yet — owner decisions Q-P8-1..5).
import { isWorkerCall, json, rpcOf, serviceClient } from '../_shared/edge.ts'
import { processDue } from '../_shared/worker.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!isWorkerCall(req)) return json({ error: 'forbidden' }, 403)
  const res = await processDue(rpcOf(serviceClient()), null, { limit: 50 })
  return json(res)
})
