// Edge Function: einvoice (Phase 8)
// Sends queued e-invoice requests (IRN generate / cancel) to the GSP now, instead of waiting for the next worker run.
// The business checks (switch per GSTIN, eligibility, 24-hour cancel window) already ran in api.request_einvoice /
// api.cancel_einvoice; this function only talks to the GSP adapter and reports through api.apply_einvoice_result.
// Callers: a signed-in ERP user right after queuing (supabase.functions.invoke('einvoice', { region: 'ap-south-1' })) or the
// scheduler (INTEGRATION_WORKER_SECRET). Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// INTEGRATION_WORKER_SECRET, and the GSP's credentials once chosen (GSP_BASE_URL, GSP_CLIENT_ID, GSP_CLIENT_SECRET, …).
import { cors, isWorkerCall, json, rpcOf, serviceClient, signedInUser } from '../_shared/edge.ts'
import { processDue } from '../_shared/worker.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!isWorkerCall(req) && !(await signedInUser(req))) return json({ error: 'sign in' }, 401)
  const res = await processDue(rpcOf(serviceClient()), ['einvoice_generate', 'einvoice_cancel'], { limit: 10 })
  return json(res)
})
