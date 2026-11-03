// Edge Function: ewaybill (Phase 8)
// Sends queued e-way bill requests (generate, Part-B vehicle update, cancel) to the e-way bill API adapter now.
// Rules (invoice final with IRN, dispatch still planned, cancel window) are checked in the api.* RPCs that queue them;
// results come back through api.apply_eway_result, which puts the number on the dispatch. Same callers and secrets as
// the einvoice function (most GSPs serve both APIs; Q-P8-1).
import { cors, isWorkerCall, json, rpcOf, serviceClient, signedInUser } from '../_shared/edge.ts'
import { processDue } from '../_shared/worker.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!isWorkerCall(req) && !(await signedInUser(req))) return json({ error: 'sign in' }, 401)
  const res = await processDue(rpcOf(serviceClient()), ['eway_generate', 'eway_update_partb', 'eway_cancel'], { limit: 10 })
  return json(res)
})
