// The integration worker loop (pure: the caller passes an `rpc` function bound to a service-role client).
// Claims due requests (api.integration_claim_due, skip-locked), calls the provider adapter with a timeout, and reports
// back through the service-only RPCs. Failures are reported, never swallowed, so Postgres applies back-off and the
// dead letter (app.integration_fail). Used by the integration-worker, einvoice, ewaybill and bank-feed Edge Functions.

import { ewayFor, gspFor, type EinvoicePayload } from './einvoice.ts'
import { bankFeedFor, cleanBankLines } from './adapters.ts'

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>

export interface ClaimedRequest {
  id: string
  company_id: string | null
  provider: string
  kind: string
  ref_table: string | null
  ref_id: string | null
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms) })
  try { return await Promise.race([p, timeout]) } finally { if (t) clearTimeout(t) }
}

async function handle(rpc: Rpc, r: ClaimedRequest, timeoutMs: number): Promise<string> {
  const fail = (error: string, retryable = true) =>
    r.kind.startsWith('einvoice_') ? rpc('apply_einvoice_result', { p_request_id: r.id, p: { ok: false, error, retryable } })
      : r.kind.startsWith('eway_') ? rpc('apply_eway_result', { p_request_id: r.id, p: { ok: false, error, retryable } })
        : rpc('integration_report', { p_request_id: r.id, p_ok: false, p_response: null, p_error: error, p_retryable: retryable })
  try {
    switch (r.kind) {
      case 'einvoice_generate': {
        const res = await withTimeout(gspFor(r.provider).generateIrn(r.payload as unknown as EinvoicePayload), timeoutMs)
        await rpc('apply_einvoice_result', { p_request_id: r.id, p: res })
        return res.ok ? 'done' : 'failed'
      }
      case 'einvoice_cancel': {
        const p = r.payload as { Irn: string; CnlRsn: '1' | '2' | '3' | '4'; CnlRem: string }
        const res = await withTimeout(gspFor(r.provider).cancelIrn(p.Irn, p.CnlRsn, p.CnlRem), timeoutMs)
        await rpc('apply_einvoice_result', { p_request_id: r.id, p: res })
        return res.ok ? 'done' : 'failed'
      }
      case 'eway_generate':
      case 'eway_update_partb':
      case 'eway_cancel': {
        const a = ewayFor(r.provider)
        const p = r.payload as Record<string, string>
        const res = r.kind === 'eway_generate' ? await withTimeout(a.generate(r.payload), timeoutMs)
          : r.kind === 'eway_update_partb' ? await withTimeout(a.updatePartB(p['ewbNo'] ?? '', p['vehicleNo'] ?? '', p['reason'] ?? ''), timeoutMs)
            : await withTimeout(a.cancel(p['ewbNo'] ?? '', p['cancelRmrk'] ?? ''), timeoutMs)
        await rpc('apply_eway_result', { p_request_id: r.id, p: res })
        return res.ok ? 'done' : 'failed'
      }
      case 'bank_feed_sync': {
        const p = r.payload as { feed_id: string; external_ref: string | null; cursor: string | null }
        const res = await withTimeout(bankFeedFor(r.provider).fetch(p.external_ref, p.cursor), timeoutMs)
        if (!res.ok) { await fail(res.error, res.retryable); return 'failed' }
        await rpc('bank_feed_import', { p_request_id: r.id, p_feed_id: p.feed_id, p_lines: cleanBankLines(res.lines), p_cursor: res.cursor })
        return 'done'
      }
      default: {
        if (r.provider === 'mock') { await rpc('integration_report', { p_request_id: r.id, p_ok: true, p_response: { mock: true }, p_error: null }); return 'done' }
        await fail(`no adapter for ${r.kind} with provider "${r.provider}" yet`, false)
        return 'failed'
      }
    }
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e), true)
    return 'failed'
  }
}

/** Process one batch. Returns counts; never throws for a single failed request. */
export async function processDue(rpc: Rpc, kinds: string[] | null, opts: { limit?: number; timeoutMs?: number } = {}) {
  const claimed = (await rpc('integration_claim_due', { p_limit: opts.limit ?? 20, p_kinds: kinds })) as ClaimedRequest[]
  const out = { claimed: claimed.length, done: 0, failed: 0 }
  for (const r of claimed) {
    const s = await handle(rpc, r, opts.timeoutMs ?? 20000)
    if (s === 'done') out.done++
    else out.failed++
  }
  return out
}
