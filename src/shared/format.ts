/**
 * Display-only formatting. Values are computed and stored by Postgres; the browser only formats them
 * (§3: numeric(18,2) money arrives as a string so no precision is lost; Indian grouping only at display).
 */

const IST = 'Asia/Kolkata'

/** Format a decimal string or number with Indian digit grouping, e.g. "1234567.5" → "12,34,567.50". */
export function formatIndian(value: string | number, fractionDigits = 2): string {
  const raw = typeof value === 'number' ? value.toFixed(fractionDigits) : value.trim()
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return raw
  const negative = raw.startsWith('-')
  const [intPartRaw = '0', fracRaw = ''] = raw.replace('-', '').split('.')
  const intPart = intPartRaw.replace(/^0+(?=\d)/, '')
  let grouped: string
  if (intPart.length <= 3) {
    grouped = intPart
  } else {
    const last3 = intPart.slice(-3)
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')
    grouped = `${rest},${last3}`
  }
  const frac = fractionDigits > 0 ? '.' + fracRaw.padEnd(fractionDigits, '0').slice(0, fractionDigits) : ''
  const isZero = /^0*$/.test(intPart + fracRaw)
  return (negative && !isZero ? '−' : '') + grouped + frac
}

export function isNegative(value: string | number): boolean {
  const s = String(value).trim()
  return s.startsWith('-') && !/^-0*(\.0*)?$/.test(s)
}

function istParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { day: get('day'), month: get('month'), year: get('year'), weekday: get('weekday') }
}

/** DD-MM-YYYY in IST. Accepts a Date or an ISO date / timestamp string. */
export function formatDate(input: Date | string): string {
  const d = typeof input === 'string' ? parseDateInput(input) : input
  const p = istParts(d)
  return `${p.day}-${p.month}-${p.year}`
}

/** e.g. "Tuesday, 03-11-2026" */
export function formatLongDate(input: Date): string {
  return `${istParts(input).weekday}, ${formatDate(input)}`
}

function parseDateInput(s: string): Date {
  // A bare business date (YYYY-MM-DD) is an IST calendar date; anchor it at IST noon.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T12:00:00+05:30`)
  return new Date(s)
}

/** 24-hour IST time, e.g. "14:05". */
export function formatTime(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
}

/** Indian financial year (April–March, IST) containing the date, as "2026-27". */
export function financialYear(input: Date = new Date()): string {
  const p = istParts(input)
  const y = Number(p.year)
  const m = Number(p.month)
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** Initials for an avatar, e.g. "Test Admin" → "TA". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : (words[0]?.[1] ?? '')
  return (first + last).toUpperCase()
}

/** Mask a phone/account number to its last 4 digits, e.g. "••7777". */
export function maskTail(value: string, keep = 4): string {
  const digits = value.replace(/\D/g, '')
  return '••' + digits.slice(-keep)
}
