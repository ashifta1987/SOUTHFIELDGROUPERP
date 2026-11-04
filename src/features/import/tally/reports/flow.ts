import { chunkArray } from './common'
import type { ParsedReport } from './index'

/**
 * The staging flow shared by the Import screen and scripts/import-tally-report.mjs. It only calls RPCs (through the
 * `Rpc` function the caller supplies); the database decides everything.
 */
export type Rpc = <T = unknown>(fn: string, args: Record<string, unknown>, opts?: { idempotent?: boolean }) => Promise<T>

export type FlowStep = 'batch' | 'stage' | 'process' | 'finish' | 'report'
export type Progress = (step: FlowStep, done?: number, total?: number) => void

export interface DayBookResult {
  id: string
  code: string
  counts?: Record<string, Record<string, number>>
  open_bugs?: number
}

export const STAGE_CHUNK = 1500
export const STEP_ROWS = 1000

export async function runDayBook(
  rpc: Rpc,
  a: { companyId: string; fileName: string; storagePath: string | null; rows: unknown[]; totals: Record<string, unknown>; onProgress?: Progress },
): Promise<DayBookResult> {
  const { rows, onProgress } = a
  onProgress?.('batch')
  const batch = await rpc<{ id: string; code: string }>('import_create_batch', {
    p: {
      company_id: a.companyId,
      source: 'excel',
      kind: 'vouchers',
      file_name: a.fileName,
      storage_path: a.storagePath,
      as_of: null,
      totals: a.totals,
    },
  })
  const parts = chunkArray<unknown>(rows, STAGE_CHUNK)
  let sent = 0
  for (const part of parts) {
    await rpc('import_stage_rows', { p_batch_id: batch.id, p_rows: part }, { idempotent: false })
    sent += part.length
    onProgress?.('stage', sent, rows.length)
  }
  let remaining = rows.length
  let done = 0
  while (remaining > 0) {
    const r = await rpc<{ remaining: number }>('import_process_step', { p_batch_id: batch.id, p_limit: STEP_ROWS })
    done += remaining - r.remaining
    if (r.remaining >= remaining) break // nothing moved: leave the rest to the final call
    remaining = r.remaining
    onProgress?.('process', done, rows.length)
  }
  onProgress?.('finish')
  const result = await rpc<DayBookResult>('import_process', { p_batch_id: batch.id })
  return { ...batch, ...result }
}

export interface StageResult {
  id: string
  duplicate: boolean
  status: string
  totals?: Record<string, unknown>
  grain?: string
}

export async function stageReport(
  rpc: Rpc,
  a: { companyId: string; parsed: ParsedReport; asOf: string; fileName: string; sha256: string; onProgress?: Progress },
): Promise<StageResult> {
  a.onProgress?.('report')
  return rpc<StageResult>('stage_tally_report', {
    p: {
      company_id: a.companyId,
      kind: a.parsed.kind,
      as_of: a.asOf,
      period_from: a.parsed.periodFrom,
      period_to: a.asOf,
      file_name: a.fileName,
      file_sha256: a.sha256,
      company_name: a.parsed.companyName,
      grain: a.parsed.grain,
      lines: a.parsed.lines,
      totals: a.parsed.totals,
    },
  })
}
