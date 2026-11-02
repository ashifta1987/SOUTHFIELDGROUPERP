import { supabase } from '@/shared/supabase'
import { callApi } from '@/data/rpc'
import { chunk, decodeTallyBytes, parseTallyXml, type ParsedTally, type StageRow } from './tally/parseTallyXml'

/**
 * Import pipeline used by the Import data screen:
 *   1. keep the original file in the private `imports` bucket (Mumbai)
 *   2. create a batch (api.import_create_batch)
 *   3. send the converted rows in chunks (api.import_stage_rows)
 *   4. let Postgres decide everything (api.import_process) and return its counts.
 * TBK backups are only stored: the Tally bridge restores them in TallyPrime on the import computer (batch waits).
 */
export type ImportSource = 'tally_xml' | 'excel' | 'tbk'

export interface BatchResult {
  id: string
  code: string
  counts?: Record<string, Record<string, number>>
  open_bugs?: number
}

export async function uploadOriginal(companyId: string, file: File): Promise<string> {
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)
  const path = `${companyId}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safe}`
  const { error } = await supabase.storage.from('imports').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' })
  if (error) throw new Error(`upload_failed: ${error.message}`)
  return path
}

export async function readTallyXml(file: File): Promise<ParsedTally> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return parseTallyXml(decodeTallyBytes(bytes))
}

export interface RunImportArgs {
  companyId: string
  file: File
  source: ImportSource
  kind?: string
  asOf?: string | null
  rows?: StageRow[]
  totals?: Record<string, unknown>
  onProgress?: (step: 'upload' | 'batch' | 'stage' | 'process' | 'done', done?: number, total?: number) => void
}

export async function runImport({ companyId, file, source, kind = 'mixed', asOf, rows = [], totals = {}, onProgress }: RunImportArgs): Promise<BatchResult> {
  onProgress?.('upload')
  const storagePath = await uploadOriginal(companyId, file)
  onProgress?.('batch')
  const batch = await callApi<{ id: string; code: string }>('import_create_batch', {
    p: { company_id: companyId, source, kind, file_name: file.name, storage_path: storagePath, as_of: asOf ?? null, totals },
  })
  if (source === 'tbk') {
    onProgress?.('done')
    return batch
  }
  const parts = chunk(rows, 400)
  let sent = 0
  for (const part of parts) {
    await callApi('import_stage_rows', { p_batch_id: batch.id, p_rows: part }, { idempotent: false })
    sent += part.length
    onProgress?.('stage', sent, rows.length)
  }
  onProgress?.('process')
  const result = await callApi<BatchResult>('import_process', { p_batch_id: batch.id })
  onProgress?.('done')
  return { ...batch, ...result }
}

/* ── Excel / CSV lists (products, parties, employees): header synonyms → staged rows ── */
const SYNONYMS: Record<string, string[]> = {
  name: ['name', 'party name', 'ledger name', 'item name', 'employee name', 'customer', 'supplier', 'particulars'],
  code: ['code', 'item code', 'employee code', 'emp code', 'employee number'],
  gstin: ['gstin', 'gst no', 'gst number', 'gstin/uin'],
  pan: ['pan', 'pan no', 'income tax number'],
  phone: ['phone', 'mobile', 'whatsapp', 'contact number', 'mobile number'],
  parent: ['group', 'under', 'parent', 'stock group', 'category'],
  hsn: ['hsn', 'hsn code', 'hsn/sac'],
  unit: ['unit', 'uom', 'units'],
  opening: ['opening', 'opening balance', 'balance'],
  mrp: ['mrp'],
  address: ['address'],
  dob: ['dob', 'date of birth'],
  aadhaar_last4: ['aadhaar', 'aadhar', 'aadhaar number'],
}

export type ListKind = 'parties' | 'products' | 'employees'

export function mapHeaders(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {}
  headers.forEach((h, i) => {
    const k = h.trim().toLowerCase()
    for (const [field, names] of Object.entries(SYNONYMS)) if (names.includes(k) && map[field] === undefined) map[field] = i
  })
  return map
}

export function sheetToRows(kind: ListKind, table: unknown[][], partyGroup = 'Sundry Debtors'): StageRow[] {
  const [head, ...body] = table
  if (!head) return []
  const m = mapHeaders(head.map((h) => String(h ?? '')))
  const get = (row: unknown[], f: string) => {
    const i = m[f]
    if (i === undefined) return null
    const v = row[i]
    if (v === null || v === undefined || String(v).trim() === '') return null
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim()
  }
  return body
    .filter((r) => get(r, 'name'))
    .map((r) => {
      if (kind === 'products') {
        return { object_type: 'stock_item' as const, name: get(r, 'name'), guid: null, master_id: null, alter_id: null,
          payload: { parent: get(r, 'parent'), unit: get(r, 'unit'), hsn: get(r, 'hsn'), mrp: get(r, 'mrp') ? Number(get(r, 'mrp')) : null, code: get(r, 'code') } }
      }
      if (kind === 'employees') {
        return { object_type: 'employee' as const, name: get(r, 'name'), guid: null, master_id: null, alter_id: null,
          payload: { code: get(r, 'code'), pan: get(r, 'pan'), phone: get(r, 'phone'), dob: get(r, 'dob'), aadhaar_last4: (get(r, 'aadhaar_last4') ?? '').replace(/\D/g, '').slice(-4) || null } }
      }
      return { object_type: 'ledger' as const, name: get(r, 'name'), guid: null, master_id: null, alter_id: null,
        payload: { parent: get(r, 'parent') ?? partyGroup, gstin: get(r, 'gstin'), pan: get(r, 'pan'), phone: get(r, 'phone'), address: get(r, 'address'),
                   opening: get(r, 'opening') ? Number(String(get(r, 'opening')).replace(/,/g, '')) : 0, bills: [] } }
    })
}

