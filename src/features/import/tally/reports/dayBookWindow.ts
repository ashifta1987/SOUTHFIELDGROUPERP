/**
 * Pure helpers behind `scripts/import-tally-daybook-xml.mjs` (the same decisions the database makes, written down so they can be tested
 * with synthetic data and shown in a dry run).
 *
 * - `--from` / `--to`: keep only vouchers dated inside the window (inclusive, ISO dates compare as text).
 * - Upgrade in place: a full-entry XML voucher that matches one-leg Excel vouchers on type | number | date replaces them without
 *   double counting. The first Excel leg (ordered by its key) becomes the voucher; the other legs are marked reversed and linked.
 */
export interface Window {
  from?: string
  to?: string
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** Reads `--from` / `--to`; throws a plain message for a bad date or a window that ends before it starts. */
export function parseWindow(from: string | undefined, to: string | undefined): Window {
  for (const [n, v] of [['--from', from], ['--to', to]] as const) {
    if (v !== undefined && (!ISO.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw new Error(`${n} must be a date as YYYY-MM-DD`)
  }
  if (from && to && from > to) throw new Error('--from is after --to')
  return { from, to }
}

/** True when the voucher date lies inside the window. A voucher without a date is never inside a window. */
export function inWindow(date: string | null | undefined, w: Window): boolean {
  if (!date) return false
  if (w.from && date < w.from) return false
  if (w.to && date > w.to) return false
  return true
}

/** Indian financial year (April-March) of an ISO date, as its starting year. */
export const financialYear = (iso: string): number => Number(iso.slice(0, 4)) - (Number(iso.slice(5, 7)) < 4 ? 1 : 0)

export interface LegacyLeg {
  id: string
  type: string
  number: string
  date: string
  matchKey: string
  guid?: string | null
  lines: unknown[]
  state: 'loaded' | 'flagged' | 'reversed'
  upgradedInto?: string | null
}

export interface XmlVoucher {
  guid: string
  type: string
  number: string
  date: string
}

export interface UpgradePlan {
  /** the Excel leg that becomes the full voucher; null when the XML voucher matches nothing and is simply created */
  keep: string | null
  /** the other legs of the same voucher: marked reversed and linked to `keep` */
  reverse: string[]
}

/** The decision the loader takes for one XML voucher against the vouchers already loaded. */
export function planUpgrade(legs: LegacyLeg[], v: XmlVoucher): UpgradePlan {
  if (!v.guid || !v.number) return { keep: null, reverse: [] }
  if (legs.some((l) => l.guid === v.guid)) return { keep: null, reverse: [] } // already loaded from XML: skipped, never doubled
  const match = legs
    .filter((l) => l.type === v.type && l.number === v.number && l.date === v.date && !l.guid && !l.upgradedInto && l.state !== 'reversed' && l.lines.length === 0)
    .sort((a, b) => (a.matchKey < b.matchKey ? -1 : a.matchKey > b.matchKey ? 1 : 0))
  if (match.length === 0) return { keep: null, reverse: [] }
  return { keep: match[0]!.id, reverse: match.slice(1).map((l) => l.id) }
}
