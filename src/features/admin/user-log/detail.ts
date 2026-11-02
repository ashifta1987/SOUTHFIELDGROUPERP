import type { Json } from '@/shared/database.types'
import { formatDate, formatTime } from '@/shared/format'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** Timestamps as DD-MM-YYYY HH:mm IST; internal ids shortened (the full id stays in the database). */
function readableText(s: string): string {
  if (UUID.test(s)) return `${s.slice(0, 8)}…`
  if (STAMP.test(s)) return `${formatDate(s)} ${formatTime(s)}`
  return s
}

/** One value from a log detail, made readable: text as is, lists joined, objects as key: value. */
export function readable(v: Json | undefined): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return readableText(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map((x) => readable(x)).join(', ')
  return Object.entries(v)
    .map(([k, x]) => `${humanKey(k)}: ${readable(x)}`)
    .join(' · ')
}

export function humanKey(k: string): string {
  return k.replace(/_/g, ' ')
}
