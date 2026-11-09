/**
 * Tally XML → staged import rows (§25A). This only converts the file format; every matching, duplicate and
 * creation decision is made by api.import_process in Postgres.
 *
 * Reads the TALLYMESSAGE elements of a TallyPrime XML export (masters and/or day book): GROUP, LEDGER, STOCKGROUP,
 * STOCKITEM, UNIT, GODOWN, COSTCENTRE (payroll employees) and VOUCHER, keeping Tally's GUID, MASTERID and ALTERID.
 * Tally amounts keep Tally's sign (negative = debit).
 */

import { COLLECTIONS, readFields, tallyAmount, tallyDate, type FieldDef } from './fields'
import { fingerprint, parseVoucherChildren, type VoucherChildren } from './voucherChildren'
export { tallyAmount, tallyDate }

export type ObjectType =
  | 'group' | 'ledger' | 'stock_group' | 'stock_item' | 'unit' | 'godown' | 'cost_centre' | 'employee' | 'voucher'
  | 'voucher_type' | 'cost_category' | 'currency' | 'stock_category' | 'payhead' | 'employee_group' | 'attendance_type'

export interface StageRow {
  object_type: ObjectType
  name: string | null
  guid: string | null
  master_id: string | null
  alter_id: number | null
  payload: Record<string, unknown>
  /** vouchers only: the parsed child lists (sent with api.import_stage_voucher_children, never inside the payload) */
  children?: VoucherChildren
}

export interface ParsedTally {
  rows: StageRow[]
  counts: Record<string, number>
  /** Earliest and latest voucher dates in the file (YYYY-MM-DD), used for "deleted in Tally" checks */
  periodFrom: string | null
  periodTo: string | null
  companyName: string | null
  /** the COMPANY object of the file when it carries one (compared with the ERP company, never staged) */
  company: Record<string, unknown> | null
  warnings: string[]
}

/** Decode the file bytes: Tally often writes UTF-16 LE with a BOM. */
export function decodeTallyBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  // UTF-16 without BOM: every other byte is 0 for ASCII text.
  if (bytes.length > 4 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes)
  return new TextDecoder('utf-8').decode(bytes)
}

/** Tally exports can contain control-character references (e.g. &#4;) that XML parsers reject. */
export function sanitizeTallyXml(xml: string): string {
  return xml
    .replace(/&#(?:x0*([0-8bcef]|1[0-9a-f])|0*([0-8]|1[1-2]|1[4-9]|2[0-9]|3[01]));/gi, '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point here
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function text(el: Element | null | undefined, tag: string): string | null {
  if (!el) return null
  for (const child of Array.from(el.children)) {
    if (child.tagName.toUpperCase() === tag) {
      const v = child.textContent?.trim() ?? ''
      return v === '' ? null : v
    }
  }
  return null
}

function children(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName.toUpperCase() === tag)
}

function deep(el: Element, tag: string): Element[] {
  return Array.from(el.getElementsByTagName(tag))
}

/** "100 Nos" → { qty: 100, unit: "Nos" } */
export function tallyQty(v: string | null): { qty: number | null; unit: string | null } {
  if (!v) return { qty: null, unit: null }
  const m = v.replace(/,/g, '').trim().match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/)
  if (!m || !m[1]) return { qty: null, unit: null }
  return { qty: Number(m[1]), unit: m[2]?.trim() || null }
}

function identity(el: Element) {
  const alter = text(el, 'ALTERID')
  return {
    guid: text(el, 'GUID'),
    master_id: text(el, 'MASTERID'),
    alter_id: alter && /^\d+$/.test(alter) ? Number(alter) : null,
  }
}

function nameOf(el: Element): string | null {
  const attr = el.getAttribute('NAME')?.trim()
  if (attr) return attr
  const nameList = children(el, 'NAME.LIST')[0] ?? children(el, 'LANGUAGENAME.LIST')[0]
  const n = nameList ? (children(nameList, 'NAME')[0]?.textContent?.trim() ?? null) : null
  return n || text(el, 'NAME')
}

function ledgerGstin(el: Element): string | null {
  const direct = text(el, 'PARTYGSTIN') ?? text(el, 'GSTIN')
  if (direct) return direct.toUpperCase()
  for (const list of [...deep(el, 'LEDGSTREGDETAILS.LIST'), ...deep(el, 'GSTREGISTRATIONDETAILS.LIST')]) {
    const g = text(list, 'GSTIN')
    if (g) return g.toUpperCase()
  }
  return null
}

function ledgerRegType(el: Element): string | null {
  const direct = text(el, 'GSTREGISTRATIONTYPE')
  if (direct) return direct
  for (const list of deep(el, 'LEDGSTREGDETAILS.LIST')) {
    const t = text(list, 'GSTREGISTRATIONTYPE')
    if (t) return t
  }
  return null
}

/** An Indian PIN code is 6 digits and does not start with 0. Tally holds free text here ("0", "682 030", 7 or 10 digits): a PIN that is not exactly that is left out rather than loaded wrong. */
export function cleanPincode(v: string | null): string | null {
  const d = (v ?? '').replace(/\s+/g, '')
  return /^[1-9][0-9]{5}$/.test(d) ? d : null
}


/** Fields of a collection as a payload (the identity keys live on the row itself). */
function fieldsOf(el: Element, collection: string, drop: string[] = ['name', 'guid', 'master_id', 'alter_id']): Record<string, unknown> {
  const defs: FieldDef[] = COLLECTIONS[collection] ?? []
  const v = readFields(el, defs)
  for (const k of drop) delete v[k]
  return v
}

function parseLedger(el: Element): StageRow {
  const bills = children(el, 'BILLALLOCATIONS.LIST')
    .map((b) => ({
      ref: text(b, 'NAME'),
      date: tallyDate(text(b, 'BILLDATE')),
      amount: tallyAmount(text(b, 'OPENINGBALANCE')),
      due: tallyDate(text(b, 'BILLCREDITPERIOD')),
    }))
    .filter((b) => b.ref || b.amount)
  const address = children(el, 'ADDRESS.LIST')
    .flatMap((a) => children(a, 'ADDRESS').map((x) => x.textContent?.trim() ?? ''))
    .filter(Boolean)
    .join(', ')
  return {
    object_type: 'ledger',
    name: nameOf(el),
    ...identity(el),
    payload: {
      parent: text(el, 'PARENT'),
      gstin: ledgerGstin(el),
      gst_reg_type: ledgerRegType(el),
      pan: text(el, 'INCOMETAXNUMBER') ?? text(el, 'PANNUMBER'),
      phone: text(el, 'LEDGERMOBILE') ?? text(el, 'LEDGERPHONE'),
      state: text(el, 'LEDSTATENAME') ?? text(el, 'STATENAME'),
      pincode: cleanPincode(text(el, 'PINCODE')),
      address: address || null,
      opening: tallyAmount(text(el, 'OPENINGBALANCE')) ?? 0,
      bills,
      ...fieldsOf(el, 'Ledger'),
    },
  }
}

function parseStockItem(el: Element): StageRow {
  let hsn = text(el, 'HSNCODE')
  if (!hsn) {
    for (const g of [...deep(el, 'GSTDETAILS.LIST'), ...deep(el, 'HSNDETAILS.LIST')]) {
      hsn = text(g, 'HSNCODE') ?? text(g, 'HSN')
      if (hsn) break
    }
  }
  let mrp: number | null = null
  for (const m of deep(el, 'MRPRATEDETAILS.LIST')) {
    mrp = tallyAmount(text(m, 'MRPRATE'))
    if (mrp) break
  }
  const opening = tallyQty(text(el, 'OPENINGBALANCE'))
  return {
    object_type: 'stock_item',
    name: nameOf(el),
    ...identity(el),
    payload: {
      parent: text(el, 'PARENT'),
      unit: text(el, 'BASEUNITS') ?? opening.unit,
      hsn,
      mrp: mrp === null ? null : Math.abs(mrp),
      opening_qty: opening.qty,
      opening_value: tallyAmount(text(el, 'OPENINGVALUE')),
      ...fieldsOf(el, 'StockItem'),
      alt_conversion: text(el, 'CONVERSION'),
      // opening stock by godown and batch: staged for the opening-balance step, not posted by the master load
      opening_allocations: children(el, 'BATCHALLOCATIONS.LIST').map((b) => {
        const q = tallyQty(text(b, 'OPENINGBALANCE'))
        return {
          godown: text(b, 'GODOWNNAME'),
          batch: text(b, 'BATCHNAME'),
          qty: q.qty,
          unit: q.unit,
          rate: text(b, 'OPENINGRATE'),
          value: tallyAmount(text(b, 'OPENINGVALUE')),
          mfd: tallyDate(text(b, 'MFDON')),
          expiry_text: text(b, 'EXPIRYPERIOD'),
        }
      }),
    },
  }
}

/** Voucher types that Tally keeps out of the books (orders, delivery/receipt notes, memos, stock journals): their entries are memorandum only. */
const NON_ACCOUNTING_TYPES = ['sales order', 'purchase order', 'delivery note', 'receipt note', 'rejections in', 'rejections out', 'stock journal', 'memorandum', 'reversing journal', 'physical stock', 'job work in order', 'job work out order']
const INVENTORY_LISTS = ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST', 'INVENTORYENTRIESIN.LIST', 'INVENTORYENTRIESOUT.LIST']

/** The voucher header fields the staging table keeps besides the ones every voucher row carries. */
function voucherHeader(el: Element): Record<string, unknown> {
  const v = fieldsOf(el, 'Voucher')
  const keep = ['reference', 'reference_date', 'effective_date', 'persisted_view', 'is_invoice', 'is_post_dated', 'place_of_supply', 'party_gstin', 'buyer_name', 'voucher_key']
  const out: Record<string, unknown> = {}
  for (const k of keep) if (v[k] !== null && v[k] !== undefined) out[k] = v[k]
  if (v.reference_date_text && !v.reference_date) out.reference_date_text = v.reference_date_text
  const irn = text(el, 'IRN') ?? deep(el, 'IRNNO')[0]?.textContent?.trim() ?? null
  const ack = text(el, 'IRNACKNO') ?? text(el, 'ACKNO') ?? null
  const ackDate = tallyDate(text(el, 'IRNACKDATE') ?? text(el, 'ACKDATE'))
  const eway = text(el, 'EWAYBILLNO') ?? deep(el, 'EWAYBILLNO')[0]?.textContent?.trim() ?? null
  if (irn) out.irn = irn
  if (ack) out.ack_no = ack
  if (ackDate) out.ack_date = ackDate
  if (eway) out.eway_bill_no = eway
  out.row_hash = fingerprint(el.outerHTML)
  return out
}

function parseVoucher(el: Element): StageRow {
  // In an item invoice (sales, purchase, notes) the sales/purchase ledger sits inside each inventory line's ACCOUNTING ALLOCATIONS, not among the
  // voucher's own ledger entries: both places are read so the voucher balances.
  const lineEls = [
    ...children(el, 'ALLLEDGERENTRIES.LIST'),
    ...children(el, 'LEDGERENTRIES.LIST'),
    ...INVENTORY_LISTS.flatMap((t) => children(el, t)).flatMap((inv) => children(inv, 'ACCOUNTINGALLOCATIONS.LIST')),
  ]
  const allLines = lineEls
    .map((l) => ({ ledger: text(l, 'LEDGERNAME'), amount: tallyAmount(text(l, 'AMOUNT')) ?? 0 }))
    .filter((l) => l.ledger)
  const vtype = el.getAttribute('VCHTYPE') ?? text(el, 'VOUCHERTYPENAME')
  const nonAccounting = NON_ACCOUNTING_TYPES.includes((vtype ?? '').trim().toLowerCase())
  // a non-accounting voucher keeps its entries as a memo; `lines` (what must balance) is empty
  const lines = nonAccounting ? [] : allLines
  const party = text(el, 'PARTYLEDGERNAME') ?? text(el, 'PARTYNAME')
  const partyLine = allLines.find((l) => party && l.ledger === party)
  const positive = allLines.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0)
  const amount = partyLine ? Math.abs(partyLine.amount) : Math.round(positive * 100) / 100
  const yes = (v: string | null) => (v ?? '').toLowerCase() === 'yes'
  return {
    object_type: 'voucher',
    name: [vtype, text(el, 'VOUCHERNUMBER')].filter(Boolean).join(' '),
    ...identity(el),
    payload: {
      type: vtype,
      number: text(el, 'VOUCHERNUMBER'),
      date: tallyDate(text(el, 'DATE')),
      party,
      amount,
      cancelled: yes(text(el, 'ISCANCELLED')),
      optional: yes(text(el, 'ISOPTIONAL')),
      narration: text(el, 'NARRATION'),
      lines,
      ...(nonAccounting ? { non_accounting: true, memo_lines: allLines } : {}),
      ...voucherHeader(el),
    },
    children: parseVoucherChildren(el),
  }
}

function parseCostCentre(el: Element): StageRow {
  const forPayroll = (text(el, 'FORPAYROLL') ?? '').toLowerCase() === 'yes'
  const isGroup = (text(el, 'ISEMPLOYEEGROUP') ?? '').toLowerCase() === 'yes'
  if (forPayroll && !isGroup) {
    return {
      object_type: 'employee',
      name: text(el, 'EMPDISPLAYNAME') ?? nameOf(el),
      ...identity(el),
      payload: {
        code: text(el, 'EMPLOYEENUMBER') ?? text(el, 'EMPLOYEEID'),
        pan: text(el, 'INCOMETAXNUMBER') ?? text(el, 'PANNUMBER'),
        phone: text(el, 'MOBILENUMBER') ?? text(el, 'CONTACTNUMBERS'),
        dob: tallyDate(text(el, 'DATEOFBIRTH')),
        // Aadhaar: only the last 4 digits ever leave the browser (DPDP).
        aadhaar_last4: (text(el, 'AADHARNUMBER') ?? text(el, 'AADHAARNUMBER') ?? '').replace(/\D/g, '').slice(-4) || null,
        parent: text(el, 'PARENT'),
      },
    }
  }
  return { object_type: 'cost_centre', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT'), category: text(el, 'CATEGORY'), ...fieldsOf(el, 'CostCentre') } }
}

export function parseTallyXml(xml: string): ParsedTally {
  const doc = new DOMParser().parseFromString(sanitizeTallyXml(xml), 'application/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new Error('not_tally_xml')
  const rows: StageRow[] = []
  const warnings: string[] = []
  let company: Record<string, unknown> | null = null
  const messages = Array.from(doc.getElementsByTagName('TALLYMESSAGE'))
  const containers = messages.length > 0 ? messages : [doc.documentElement]
  for (const msg of containers) {
    for (const el of Array.from(msg.children)) {
      const tag = el.tagName.toUpperCase()
      switch (tag) {
        case 'GROUP':
          rows.push({ object_type: 'group', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT'), reserved: el.getAttribute('RESERVEDNAME')?.trim() || null, ...fieldsOf(el, 'Group') } })
          break
        case 'VOUCHERTYPE':
          rows.push({ object_type: 'voucher_type', name: nameOf(el), ...identity(el), payload: { reserved: el.getAttribute('RESERVEDNAME')?.trim() || null, ...fieldsOf(el, 'VoucherType') } })
          break
        case 'COSTCATEGORY':
          rows.push({ object_type: 'cost_category', name: nameOf(el), ...identity(el), payload: fieldsOf(el, 'CostCategory') })
          break
        case 'CURRENCY':
          rows.push({ object_type: 'currency', name: nameOf(el), ...identity(el), payload: fieldsOf(el, 'Currency') })
          break
        case 'STOCKCATEGORY':
          rows.push({ object_type: 'stock_category', name: nameOf(el), ...identity(el), payload: fieldsOf(el, 'StockCategory') })
          break
        case 'PAYHEAD':
          rows.push({ object_type: 'payhead', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT'), pay_type: text(el, 'PAYTYPE') } })
          break
        case 'EMPLOYEEGROUP':
          rows.push({ object_type: 'employee_group', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT') } })
          break
        case 'ATTENDANCETYPE':
          rows.push({ object_type: 'attendance_type', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT'), unit: text(el, 'BASEUNITS') } })
          break
        case 'COMPANY':
          company = { ...fieldsOf(el, 'Company', ['name']), name: nameOf(el) }
          break
        case 'LEDGER':
          rows.push(parseLedger(el))
          break
        case 'STOCKGROUP':
          rows.push({ object_type: 'stock_group', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT'), ...fieldsOf(el, 'StockGroup') } })
          break
        case 'STOCKITEM':
          rows.push(parseStockItem(el))
          break
        case 'UNIT':
          rows.push({ object_type: 'unit', name: nameOf(el), ...identity(el), payload: { simple: text(el, 'ISSIMPLEUNIT'), ...fieldsOf(el, 'Unit') } })
          break
        case 'GODOWN':
          rows.push({ object_type: 'godown', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT'), ...fieldsOf(el, 'Godown') } })
          break
        case 'COSTCENTRE':
          rows.push(parseCostCentre(el))
          break
        case 'VOUCHER':
          rows.push(parseVoucher(el))
          break
        default:
          break
      }
    }
  }
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.object_type] = (counts[r.object_type] ?? 0) + 1
  const dates = rows
    .filter((r) => r.object_type === 'voucher')
    .map((r) => r.payload.date as string | null)
    .filter((d): d is string => Boolean(d))
    .sort()
  if (rows.length === 0) warnings.push('no_rows')
  const companyName = doc.getElementsByTagName('SVCURRENTCOMPANY')[0]?.textContent?.trim() ?? null
  return { rows, counts, periodFrom: dates[0] ?? null, periodTo: dates[dates.length - 1] ?? null, companyName, company, warnings }
}

/** Split rows into chunks for api.import_stage_rows. */
export function chunk<T>(items: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
