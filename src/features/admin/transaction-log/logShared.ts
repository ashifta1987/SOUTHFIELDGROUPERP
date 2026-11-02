import type { ComponentProps } from 'react'
import type { Chip } from '@/ui'
import type { ViewRow } from '@/data/queries'
import type { Json } from '@/shared/database.types'

type Tone = ComponentProps<typeof Chip>['tone']
type Obj = { [key: string]: Json | undefined }

/** Chip for each row_history operation (word + icon, never colour alone). */
export const OP_CHIP: Record<string, { tone: Tone; icon: string }> = {
  INSERT: { tone: 'success', icon: 'plus' },
  UPDATE: { tone: 'signal', icon: 'pencil' },
  DELETE: { tone: 'danger', icon: 'cross' },
}

export const OPS = ['INSERT', 'UPDATE', 'DELETE'] as const

export function asObj(v: Json | null | undefined): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
}

const NAME_KEYS = ['code', 'doc_no', 'name', 'legal_name', 'display_name', 'label', 'gstin', 'field_key', 'key'] as const

/** A short, human name for the record a log line is about, taken from its stored row; falls back to the key. */
export function recordName(r: Pick<ViewRow<'transaction_log'>, 'after' | 'before' | 'row_pk'>): string {
  const row = { ...asObj(r.before), ...asObj(r.after) }
  for (const k of NAME_KEYS) {
    const v = row[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return r.row_pk.length > 13 ? `${r.row_pk.slice(0, 8)}…` : r.row_pk
}

/** A stored value as text for the diff (no rounding or recalculation: what the database kept). */
export function show(v: Json | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Field-by-field comparison of one version against what it replaced. */
export function diffFields(before: Json | null, after: Json | null): { changed: string[]; unchanged: string[] } {
  const b = asObj(before)
  const a = asObj(after)
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort()
  const changed: string[] = []
  const unchanged: string[] = []
  for (const k of keys) (JSON.stringify(b[k] ?? null) === JSON.stringify(a[k] ?? null) ? unchanged : changed).push(k)
  return { changed, unchanged }
}
