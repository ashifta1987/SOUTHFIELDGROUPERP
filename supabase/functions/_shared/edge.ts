// Deno-only helpers shared by the Phase 8 Edge Functions (not imported by Vitest).
// Secrets come only from Edge Function secrets (`supabase secrets set …`); nothing here is ever sent to the browser.
// Functions run in ap-south-1: callers use regional invocation (header `x-region: ap-south-1`, or the query parameter
// `forceFunctionRegion=ap-south-1` for provider webhooks that cannot set headers).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { timingSafeEqual } from './hmac.ts'
import type { Rpc } from './worker.ts'

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

export function env(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing secret ${name}`)
  return v
}

/** Service-role client: only for the service-only RPCs (webhooks, worker). */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
}

/** A client acting with the caller's own JWT (RLS and rights apply) — the help assistant uses only this. */
export function userClient(req: Request): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
}

export function rpcOf(db: SupabaseClient): Rpc {
  return async (fn, args) => {
    const { data, error } = await db.schema('api').rpc(fn, args)
    if (error) throw new Error(`${fn}: ${error.message}${error.hint ? ` [${error.hint}]` : ''}`)
    return data
  }
}

/** Scheduler / cron calls carry `Authorization: Bearer <INTEGRATION_WORKER_SECRET>`. */
export function isWorkerCall(req: Request): boolean {
  const secret = Deno.env.get('INTEGRATION_WORKER_SECRET')
  const auth = req.headers.get('Authorization') ?? ''
  return Boolean(secret) && timingSafeEqual(auth, `Bearer ${secret}`)
}

/** A signed-in ERP user (any role): the JWT is checked by Supabase Auth. */
export async function signedInUser(req: Request): Promise<string | null> {
  const { data } = await userClient(req).auth.getUser()
  return data.user?.id ?? null
}

/** Run work after the 200 has been sent (providers expect a fast answer). */
export function background(p: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
  const safe = p.catch((e) => console.error('background task failed', e instanceof Error ? e.message : e))
  if (rt) rt.waitUntil(safe)
}
