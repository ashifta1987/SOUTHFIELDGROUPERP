/**
 * The voucher child lists of a Tally voucher (spec §9: AllLedgerEntries, AllInventoryEntries, BatchAllocations, AccountingAllocations,
 * BillAllocations, CategoryAllocations, CostCentreAllocations, BankAllocations) as parsed rows for the staging tables
 * ops.tally_voucher_lines / _inventory / _batches / _bills / _costcentres / _banks.
 *
 * Both list variants are read (ALLLEDGERENTRIES / LEDGERENTRIES, ALLINVENTORYENTRIES / INVENTORYENTRIES) and, for stock and manufacturing
 * journals, the inward and outward lists (INVENTORYENTRIESIN / INVENTORYENTRIESOUT). Sign rule (spec §8): in Tally XML a negative amount is a
 * debit; IsDeemedPositive = Yes marks a debit (ledger lines) or inward stock. Where the two signals disagree the row carries the flag
 * 'sign_mismatch'. Rate × Qty − Discount is compared with the Amount (₹1 per line): 'amount_mismatch'. A quantity whose number or unit cannot be
 * read gets 'qty_unparsed'; a rate unit that differs from the quantity unit gets 'unit_mismatch'. The original text stays in *_text columns.
 */
import { COLLECTIONS, childEls, childText, parseCreditDays, parseDiscount, readFields } from './fields'

export type RowFlag = 'sign_mismatch' | 'amount_mismatch' | 'qty_unparsed' | 'unit_mismatch' | 'missing_name'

export interface LineRow {
  no: number
  list: 'ALLLEDGERENTRIES' | 'LEDGERENTRIES' | 'ACCOUNTINGALLOCATIONS'
  inv_no: number | null
  ledger: string
  amount: number
  amount_text: string | null
  deemed_positive: boolean | null
  party: boolean | null
  gst_class: string | null
  flags: RowFlag[]
}

export interface InventoryRow {
  no: number
  list_kind: 'entries' | 'in' | 'out'
  item: string
  actual_qty: number | null
  actual_unit: string | null
  actual_qty_text: string | null
  billed_qty: number | null
  billed_unit: string | null
  rate: number | null
  rate_unit: string | null
  discount_pct: number | null
  discount_text: string | null
  amount: number | null
  deemed_positive: boolean | null
  hsn: string | null
  flags: RowFlag[]
}

export interface BatchRow {
  no: number
  inv_no: number | null
  godown: string | null
  batch: string | null
  actual_qty: number | null
  actual_unit: string | null
  billed_qty: number | null
  billed_unit: string | null
  amount: number | null
  mfd_text: string | null
  mfd_on: string | null
  expiry_text: string | null
  expiry_on: string | null
  order_no: string | null
  tracking_no: string | null
}

export interface BillRow {
  no: number
  line_no: number | null
  name: string | null
  bill_type: string | null
  amount: number | null
  credit_period_text: string | null
  credit_days: number | null
}

export interface CostCentreRow {
  no: number
  line_no: number | null
  category: string | null
  centre: string | null
  amount: number | null
  deemed_positive: boolean | null
}

export interface BankRow {
  no: number
  line_no: number | null
  date: string | null
  instrument_date: string | null
  instrument_number: string | null
  transaction_type: string | null
  favouring: string | null
  bankers_date: string | null
  amount: number | null
}

export interface VoucherChildren {
  lines: LineRow[]
  inventory: InventoryRow[]
  batches: BatchRow[]
  bills: BillRow[]
  costcentres: CostCentreRow[]
  banks: BankRow[]
}

const LEDGER_LISTS = ['ALLLEDGERENTRIES', 'LEDGERENTRIES'] as const
const INVENTORY_LISTS: { tag: string; kind: 'entries' | 'in' | 'out' }[] = [
  { tag: 'ALLINVENTORYENTRIES.LIST', kind: 'entries' },
  { tag: 'INVENTORYENTRIES.LIST', kind: 'entries' },
  { tag: 'INVENTORYENTRIESIN.LIST', kind: 'in' },
  { tag: 'INVENTORYENTRIESOUT.LIST', kind: 'out' },
]

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

/** negative amount = debit = deemed positive; true when both signals are known and disagree. */
export function signDisagrees(amount: number | null, deemedPositive: boolean | null): boolean {
  if (amount === null || deemedPositive === null || amount === 0) return false
  return amount < 0 !== deemedPositive
}

/** Rate × Qty − Discount against Amount, within ₹1 per line. null when it cannot be checked. */
export function amountAgrees(rate: number | null, qty: number | null, discountPct: number | null, amount: number | null): boolean | null {
  if (rate === null || qty === null || amount === null) return null
  const gross = rate * qty
  const net = discountPct === null ? gross : gross - (gross * discountPct) / 100
  return Math.abs(Math.abs(net) - Math.abs(amount)) <= 1
}

interface Ctx {
  out: VoucherChildren
  line: number
  inv: number
  bat: number
  bill: number
  cc: number
  bank: number
}

/** Bill, bank and cost-centre allocations hang under a ledger entry or an accounting allocation. */
function readLedgerChildren(el: Element, lineNo: number, c: Ctx): void {
  for (const b of childEls(el, 'BILLALLOCATIONS.LIST')) {
    const v = readFields(b, COLLECTIONS.BillAllocations!)
    // TallyPrime writes an empty BILLALLOCATIONS.LIST on every ledger entry: no name, type or amount means no bill
    if (!str(v.name) && !str(v.bill_type) && num(v.amount) === null) continue
    c.out.bills.push({
      no: ++c.bill,
      line_no: lineNo,
      name: str(v.name),
      bill_type: str(v.bill_type),
      amount: num(v.amount),
      credit_period_text: str(v.credit_period),
      credit_days: parseCreditDays(str(v.credit_period)),
    })
  }
  for (const b of childEls(el, 'BANKALLOCATIONS.LIST')) {
    const v = readFields(b, COLLECTIONS.BankAllocations!)
    if (!str(v.instrument_number) && !str(v.transaction_type) && !str(v.favouring) && !str(v.instrument_date) && !str(v.bankers_date) && num(v.amount) === null) continue
    c.out.banks.push({
      no: ++c.bank,
      line_no: lineNo,
      date: str(v.date),
      instrument_date: str(v.instrument_date),
      instrument_number: str(v.instrument_number),
      transaction_type: str(v.transaction_type),
      favouring: str(v.favouring),
      bankers_date: str(v.bankers_date),
      amount: num(v.amount),
    })
  }
  const pushCentres = (holder: Element, category: string | null, dp: boolean | null) => {
    for (const cc of childEls(holder, 'COSTCENTREALLOCATIONS.LIST')) {
      const v = readFields(cc, COLLECTIONS.CostCentreAllocations!)
      if (!str(v.centre) && num(v.amount) === null) continue
      c.out.costcentres.push({ no: ++c.cc, line_no: lineNo, category, centre: str(v.centre), amount: num(v.amount), deemed_positive: dp })
    }
  }
  for (const cat of childEls(el, 'CATEGORYALLOCATIONS.LIST')) {
    const v = readFields(cat, COLLECTIONS.CategoryAllocations!)
    pushCentres(cat, str(v.category), bool(v.deemed_positive))
  }
  pushCentres(el, null, null) // older exports put the split directly under the entry
}

function ledgerRow(el: Element, list: LineRow['list'], invNo: number | null, c: Ctx): LineRow {
  const v = readFields(el, list === 'ACCOUNTINGALLOCATIONS' ? COLLECTIONS.AccountingAllocations! : COLLECTIONS.AllLedgerEntries!)
  const amount = num(v.amount) ?? 0
  const dp = bool(v.deemed_positive)
  const flags: RowFlag[] = []
  if (!str(v.ledger)) flags.push('missing_name')
  if (signDisagrees(amount, dp)) flags.push('sign_mismatch')
  const row: LineRow = {
    no: ++c.line,
    list,
    inv_no: invNo,
    ledger: str(v.ledger) ?? '',
    amount,
    amount_text: childText(el, 'AMOUNT'),
    deemed_positive: dp,
    party: list === 'ACCOUNTINGALLOCATIONS' ? null : bool(v.party),
    gst_class: list === 'ACCOUNTINGALLOCATIONS' ? null : str(v.gst_class),
    flags,
  }
  readLedgerChildren(el, row.no, c)
  return row
}

export function parseVoucherChildren(el: Element): VoucherChildren {
  const c: Ctx = { out: { lines: [], inventory: [], batches: [], bills: [], costcentres: [], banks: [] }, line: 0, inv: 0, bat: 0, bill: 0, cc: 0, bank: 0 }

  // document order, so line numbers follow the file
  for (const child of Array.from(el.children)) {
    const name = child.tagName.toUpperCase()
    const ledgerList = LEDGER_LISTS.find((t) => `${t}.LIST` === name)
    if (ledgerList) {
      c.out.lines.push(ledgerRow(child, ledgerList, null, c))
      continue
    }
    const invList = INVENTORY_LISTS.find((l) => l.tag === name)
    if (!invList) continue
    const kind = invList.kind
    for (const inv of [child]) {
      const v = readFields(inv, COLLECTIONS.AllInventoryEntries!)
      const no = ++c.inv
      const amount = num(v.amount)
      const dp = bool(v.deemed_positive)
      const disc = parseDiscount(str(v.discount))
      const actualQty = num(v.actual)
      const billedQty = num(v.billed)
      const flags: RowFlag[] = []
      if (!str(v.item)) flags.push('missing_name')
      if ((str(v.actual_text) !== null && actualQty === null) || (str(v.billed_text) !== null && billedQty === null) || (actualQty !== null && str(v.actual_unit) === null)) flags.push('qty_unparsed')
      if (signDisagrees(amount, dp)) flags.push('sign_mismatch')
      if (amountAgrees(num(v.rate), billedQty ?? actualQty, disc.pct, amount) === false) flags.push('amount_mismatch')
      const qtyUnit = str(v.billed_unit) ?? str(v.actual_unit)
      const rateUnit = str(v.rate_unit)
      if (rateUnit !== null && qtyUnit !== null && rateUnit.toLowerCase() !== qtyUnit.toLowerCase()) flags.push('unit_mismatch')
      c.out.inventory.push({
        no,
        list_kind: kind,
        item: str(v.item) ?? '',
        actual_qty: actualQty,
        actual_unit: str(v.actual_unit),
        actual_qty_text: str(v.actual_text),
        billed_qty: billedQty,
        billed_unit: str(v.billed_unit),
        rate: num(v.rate),
        rate_unit: str(v.rate_unit),
        discount_pct: disc.pct,
        discount_text: disc.text,
        amount,
        deemed_positive: dp,
        hsn: str(v.hsn),
        flags,
      })
      for (const b of childEls(inv, 'BATCHALLOCATIONS.LIST')) {
        const bv = readFields(b, COLLECTIONS.BatchAllocations!)
        if (!str(bv.godown) && !str(bv.batch) && num(bv.actual) === null && num(bv.amount) === null) continue
        c.out.batches.push({
          no: ++c.bat,
          inv_no: no,
          godown: str(bv.godown),
          batch: str(bv.batch),
          actual_qty: num(bv.actual),
          actual_unit: str(bv.actual_unit),
          billed_qty: num(bv.billed),
          billed_unit: str(bv.billed_unit),
          amount: num(bv.amount),
          mfd_text: str(bv.mfd_text),
          mfd_on: str(bv.mfd),
          expiry_text: str(bv.expiry_text),
          expiry_on: str(bv.expiry),
          order_no: str(bv.order_no),
          tracking_no: str(bv.tracking_no),
        })
      }
      for (const a of childEls(inv, 'ACCOUNTINGALLOCATIONS.LIST')) c.out.lines.push(ledgerRow(a, 'ACCOUNTINGALLOCATIONS', no, c))
    }
  }
  return c.out
}

/** A cheap, stable fingerprint (FNV-1a, 53 bits) of a voucher's XML text: tells a changed voucher from an unchanged one without storing the raw text. */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${(h2 & 0x1fffff).toString(16).padStart(6, '0')}`
}
