/**
 * The Tally fields the import reads, as tables (spec: docs/spec/tally/Tally_Gold_Backend_Tables - Southfield ERP mapping.xlsx, sheet "Fields",
 * 175 fields; the tag names are kept in specTags.json and a test fails if a tag is missing here).
 *
 * Everything is read as text first and converted by kind. The original text is kept where the ERP column is a normalised value
 * (quantities, rates, amounts, dates, periods), so nothing Tally wrote is lost.
 */

export type FieldKind = 'text' | 'yes' | 'date' | 'amount' | 'qty' | 'rate' | 'int' | 'address' | 'name'

export interface FieldDef {
  /** XML tag as in the spec's "XML Tag" column */
  tag: string
  /** key in the staged payload */
  key: string
  kind: FieldKind
  /** other tags where TallyPrime versions put the same value */
  alt?: string[]
  /** search descendants (GST registration lists and the like) instead of direct children only */
  deep?: boolean
  /** staged for reference or checks only, never used to post (spec: "check only" / "kept") */
  ref?: boolean
}

const f = (tag: string, key: string, kind: FieldKind = 'text', more: Partial<FieldDef> = {}): FieldDef => ({ tag, key, kind, ...more })

export const COLLECTIONS: Record<string, FieldDef[]> = {
  Company: [
    f('NAME', 'name', 'name'), f('BASICCOMPANYFORMALNAME', 'formal_name'), f('ADDRESS', 'address', 'address'), f('STATENAME', 'state'), f('COUNTRYNAME', 'country'),
    f('PINCODE', 'pincode'), f('PHONENUMBER', 'phone'), f('EMAIL', 'email'), f('STARTINGFROM', 'starting_from', 'date'), f('BOOKSFROM', 'books_from', 'date'),
    f('INCOMETAXNUMBER', 'pan', 'text', { alt: ['PANNUMBER'] }), f('CURRENCYSYMBOL', 'currency_symbol'), f('GUID', 'guid'),
  ],
  Group: [
    f('NAME', 'name', 'name'), f('PARENT', 'parent'), f('ISREVENUE', 'is_revenue', 'yes'), f('ISDEEMEDPOSITIVE', 'is_deemed_positive', 'yes'),
    f('AFFECTSGROSSPROFIT', 'affects_gross_profit', 'yes'), f('ISSUBLEDGER', 'is_subledger', 'yes'), f('ISADDABLE', 'is_addable', 'yes', { ref: true }),
    f('GUID', 'guid'), f('MASTERID', 'master_id'), f('ALTERID', 'alter_id', 'int'),
  ],
  Ledger: [
    f('NAME', 'name', 'name'), f('PARENT', 'parent'), f('MAILINGNAME', 'mailing_name'), f('ADDRESS', 'address', 'address'), f('LEDSTATENAME', 'state', 'text', { alt: ['STATENAME'] }),
    f('COUNTRYNAME', 'country'), f('PINCODE', 'pincode_text'), f('LEDGERPHONE', 'ledger_phone'), f('LEDGERMOBILE', 'ledger_mobile'), f('EMAIL', 'email'), f('LEDGERCONTACT', 'contact'),
    f('INCOMETAXNUMBER', 'pan_text', 'text', { alt: ['PANNUMBER'] }), f('PARTYGSTIN', 'party_gstin', 'text', { alt: ['GSTIN'], deep: true }),
    f('GSTREGISTRATIONTYPE', 'gst_registration_type', 'text', { deep: true }), f('CURRENCYNAME', 'currency'), f('OPENINGBALANCE', 'opening_balance', 'amount'),
    f('CLOSINGBALANCE', 'closing_balance', 'amount', { ref: true }), f('ISBILLWISEON', 'is_bill_wise_on', 'yes'), f('BILLCREDITPERIOD', 'bill_credit_period'),
    f('CREDITLIMIT', 'credit_limit', 'amount'), f('ISCOSTCENTRESON', 'is_cost_centres_on', 'yes'), f('AFFECTSSTOCK', 'affects_stock', 'yes'),
    f('GUID', 'guid'), f('MASTERID', 'master_id'), f('ALTERID', 'alter_id', 'int'),
  ],
  VoucherType: [
    f('NAME', 'name', 'name'), f('PARENT', 'parent'), f('NUMBERINGMETHOD', 'numbering'), f('ISACTIVE', 'active', 'yes'), f('PREVENTDUPLICATES', 'prevent_duplicates', 'yes'),
    f('AFFECTSSTOCK', 'affects_stock', 'yes'), f('ISOPTIONAL', 'optional', 'yes'), f('GUID', 'guid'), f('MASTERID', 'master_id'),
  ],
  CostCategory: [f('NAME', 'name', 'name'), f('ALLOCATEREVENUE', 'revenue', 'yes'), f('ALLOCATENONREVENUE', 'non_revenue', 'yes'), f('GUID', 'guid')],
  CostCentre: [f('NAME', 'name', 'name'), f('PARENT', 'parent'), f('CATEGORY', 'category'), f('GUID', 'guid')],
  Currency: [f('NAME', 'name', 'name'), f('MAILINGNAME', 'mailing_name'), f('ORIGINALSYMBOL', 'original_symbol'), f('EXPANDEDSYMBOL', 'expanded_symbol'), f('DECIMALPLACES', 'decimals', 'int')],
  StockGroup: [f('NAME', 'name', 'name'), f('PARENT', 'parent'), f('BASEUNITS', 'base_units'), f('ISADDABLE', 'addable', 'yes'), f('GUID', 'guid')],
  StockCategory: [f('NAME', 'name', 'name'), f('PARENT', 'parent'), f('GUID', 'guid')],
  StockItem: [
    f('NAME', 'name', 'name'), f('PARENT', 'parent'), f('CATEGORY', 'category'), f('DESCRIPTION', 'description'), f('BASEUNITS', 'base_units'), f('ADDITIONALUNITS', 'alt_unit'),
    f('GSTAPPLICABLE', 'gst_applicable', 'text', { deep: true }), f('HSNCODE', 'hsn_code', 'text', { alt: ['HSN'], deep: true }), f('ISBATCHWISEON', 'batch_wise', 'yes'),
    f('ISPERISHABLEON', 'perishable', 'yes'), f('COSTINGMETHOD', 'costing_method', 'text', { ref: true }), f('VALUATIONMETHOD', 'valuation_method', 'text', { ref: true }),
    f('OPENINGBALANCE', 'opening_balance', 'qty'), f('OPENINGRATE', 'opening_rate', 'rate'), f('OPENINGVALUE', 'opening_value', 'amount'),
    f('CLOSINGBALANCE', 'closing_balance', 'qty', { ref: true }), f('CLOSINGRATE', 'closing_rate', 'rate', { ref: true }), f('CLOSINGVALUE', 'closing_value', 'amount', { ref: true }),
    f('GUID', 'guid'), f('MASTERID', 'master_id'), f('ALTERID', 'alter_id', 'int'),
  ],
  Unit: [
    f('NAME', 'name', 'name'), f('ORIGINALNAME', 'original_name'), f('ISSIMPLEUNIT', 'simple', 'yes'), f('BASEUNITS', 'base_units'), f('ADDITIONALUNITS', 'additional_units'),
    f('CONVERSION', 'conversion'), f('DECIMALPLACES', 'decimals', 'int'), f('GSTREPUOM', 'gst_uqc'),
  ],
  Godown: [
    f('NAME', 'name', 'name'), f('PARENT', 'parent'), f('ADDRESS', 'address', 'address'), f('HASNOSPACE', 'has_no_space', 'yes'), f('ISEXTERNAL', 'is_external', 'yes'),
    f('ISINTERNAL', 'is_internal', 'yes'), f('GUID', 'guid'),
  ],
  Voucher: [
    f('DATE', 'date', 'date'), f('VOUCHERTYPENAME', 'type'), f('VOUCHERNUMBER', 'number'), f('PARTYLEDGERNAME', 'party', 'text', { alt: ['PARTYNAME'] }), f('REFERENCE', 'reference'),
    f('REFERENCEDATE', 'reference_date', 'date'), f('EFFECTIVEDATE', 'effective_date', 'date'), f('NARRATION', 'narration'), f('PERSISTEDVIEW', 'persisted_view'),
    f('ISINVOICE', 'is_invoice', 'yes'), f('ISCANCELLED', 'cancelled', 'yes'), f('ISOPTIONAL', 'optional', 'yes'), f('ISPOSTDATED', 'is_post_dated', 'yes'),
    f('PLACEOFSUPPLY', 'place_of_supply'), f('PARTYGSTIN', 'party_gstin'), f('BASICBUYERNAME', 'buyer_name'), f('AMOUNT', 'amount_tally', 'amount', { ref: true }),
    f('GUID', 'guid'), f('MASTERID', 'master_id'), f('ALTERID', 'alter_id', 'int'), f('VOUCHERKEY', 'voucher_key'),
  ],
  AllLedgerEntries: [
    f('LEDGERNAME', 'ledger'), f('AMOUNT', 'amount', 'amount'), f('ISDEEMEDPOSITIVE', 'deemed_positive', 'yes'), f('ISPARTYLEDGER', 'party', 'yes'), f('GSTCLASS', 'gst_class'),
  ],
  AllInventoryEntries: [
    f('STOCKITEMNAME', 'item'), f('ACTUALQTY', 'actual', 'qty'), f('BILLEDQTY', 'billed', 'qty'), f('RATE', 'rate', 'rate'), f('DISCOUNT', 'discount'),
    f('AMOUNT', 'amount', 'amount'), f('ISDEEMEDPOSITIVE', 'deemed_positive', 'yes'), f('GSTHSNNAME', 'hsn'),
  ],
  BatchAllocations: [
    f('GODOWNNAME', 'godown'), f('BATCHNAME', 'batch'), f('ACTUALQTY', 'actual', 'qty'), f('BILLEDQTY', 'billed', 'qty'), f('AMOUNT', 'amount', 'amount'),
    f('MFDON', 'mfd', 'date'), f('EXPIRYPERIOD', 'expiry', 'date'), f('ORDERNO', 'order_no'), f('TRACKINGNUMBER', 'tracking_no'),
  ],
  AccountingAllocations: [f('LEDGERNAME', 'ledger'), f('AMOUNT', 'amount', 'amount'), f('ISDEEMEDPOSITIVE', 'deemed_positive', 'yes')],
  BillAllocations: [f('NAME', 'name'), f('BILLTYPE', 'bill_type'), f('AMOUNT', 'amount', 'amount'), f('BILLCREDITPERIOD', 'credit_period')],
  CategoryAllocations: [f('CATEGORY', 'category'), f('ISDEEMEDPOSITIVE', 'deemed_positive', 'yes')],
  CostCentreAllocations: [f('NAME', 'centre'), f('AMOUNT', 'amount', 'amount')],
  BankAllocations: [
    f('DATE', 'date', 'date'), f('INSTRUMENTDATE', 'instrument_date', 'date'), f('INSTRUMENTNUMBER', 'instrument_number'), f('TRANSACTIONTYPE', 'transaction_type'),
    f('PAYMENTFAVOURING', 'favouring'), f('BANKERSDATE', 'bankers_date', 'date'), f('AMOUNT', 'amount', 'amount'),
  ],
}

/** Tags the owner's table lists that are staged only as reference (never used to post). */
export const REFERENCE_ONLY: Record<string, string[]> = Object.fromEntries(
  Object.entries(COLLECTIONS).map(([k, defs]) => [k, defs.filter((d) => d.ref).map((d) => d.tag)]),
)

// ───────────────────────── conversions (spec §8) ─────────────────────────

export interface QtyParts {
  qty: number | null
  unit: string | null
  text: string | null
}

const NUM = '(-?\\d[\\d,]*(?:\\.\\d+)?)'

/** "10 Nos", "2.500 kg", " 12 Nos", "1 Box = 12 Nos" (the converted base quantity wins), "-3 Kgs". Unparsable text gives qty null and keeps the text. */
export function parseQty(v: string | null | undefined): QtyParts {
  const text = v == null || v.trim() === '' ? null : v.trim()
  if (text === null) return { qty: null, unit: null, text: null }
  const tail = text.includes('=') ? (text.split('=').pop() ?? text) : text
  const m = tail.replace(/\u00a0/g, ' ').trim().match(new RegExp(`^${NUM}\\s*(.*)$`))
  if (!m || !m[1]) return { qty: null, unit: null, text }
  const qty = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(qty)) return { qty: null, unit: null, text }
  const unit = (m[2] ?? '').trim()
  return { qty, unit: unit === '' ? null : unit, text }
}

/** "100.00/Nos", "₹ 1,250.50/Kgs", "$ 2/Nos = ₹ 168/Nos" (the last part wins). */
export function parseRate(v: string | null | undefined): { rate: number | null; unit: string | null; text: string | null } {
  const text = v == null || v.trim() === '' ? null : v.trim()
  if (text === null) return { rate: null, unit: null, text: null }
  const tail = (text.includes('=') ? (text.split('=').pop() ?? text) : text).trim()
  const m = tail.match(new RegExp(`${NUM}\\s*(?:/\\s*(.+?))?\\s*$`))
  if (!m || !m[1]) return { rate: null, unit: null, text }
  const rate = Number(m[1].replace(/,/g, ''))
  return { rate: Number.isFinite(rate) ? rate : null, unit: m[2]?.trim() || null, text }
}

/** A discount is "10%" or a number: returns the percentage when it is one. */
export function parseDiscount(v: string | null | undefined): { pct: number | null; text: string | null } {
  const text = v == null || v.trim() === '' ? null : v.trim()
  if (text === null) return { pct: null, text: null }
  const m = text.match(/^(-?\d+(?:\.\d+)?)\s*%?$/)
  return { pct: m && m[1] ? Number(m[1]) : null, text }
}

/** "30 Days", "45 Days" or a date → days. */
export function parseCreditDays(v: string | null | undefined): number | null {
  if (!v) return null
  const m = v.trim().match(/^(\d+)\s*(day|days|d)?\b/i)
  return m && m[1] ? Number(m[1]) : null
}

/** Round to the unit's decimals (quantities are numeric(18,3) at most). */
export function roundQty(q: number | null, decimals = 3): number | null {
  if (q === null) return null
  const k = 10 ** Math.min(Math.max(decimals, 0), 3)
  return Math.round(q * k) / k
}

// ───────────────────────── reading an element by its field table ─────────────────────────

/** "-1,500.00" or "1500 Dr" → signed number (negative = debit), or null. Forex text "10 USD = -840.00" reads the home-currency part. */
export function tallyAmount(v: string | null): number | null {
  if (v === null) return null
  let s = (v.includes('=') ? (v.split('=').pop() ?? v) : v).replace(/,/g, '').trim()
  let sign = 1
  if (/\bDr\b/i.test(s)) {
    sign = -1
    s = s.replace(/\bDr\b/i, '')
  } else if (/\bCr\b/i.test(s)) s = s.replace(/\bCr\b/i, '')
  const m = s.match(/-?\d+(\.\d+)?/)
  if (!m) return null
  return Number(m[0]) * sign
}

/** YYYYMMDD → YYYY-MM-DD (a real calendar date only) */
export function tallyDate(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  const m = t.match(/^(\d{4})(\d{2})(\d{2})$/) ?? t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

export function tallyYes(v: string | null): boolean | null {
  if (v === null) return null
  const t = v.trim().toLowerCase()
  return t === 'yes' ? true : t === 'no' ? false : null
}

/** Direct child text (trimmed, empty = null) */
export function childText(el: Element | null | undefined, tag: string): string | null {
  if (!el) return null
  for (const child of Array.from(el.children)) {
    if (child.tagName.toUpperCase() === tag) {
      const v = child.textContent?.trim() ?? ''
      return v === '' ? null : v
    }
  }
  return null
}

export function childEls(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName.toUpperCase() === tag)
}

function rawText(el: Element, d: FieldDef): string | null {
  for (const tag of [d.tag, ...(d.alt ?? [])]) {
    const direct = childText(el, tag)
    if (direct !== null) return direct
    if (d.deep) {
      for (const hit of Array.from(el.getElementsByTagName(tag))) {
        const v = hit.textContent?.trim() ?? ''
        if (v !== '') return v
      }
    }
  }
  return null
}

/** Tally object name: NAME attribute, NAME.LIST/NAME, or a NAME child. */
export function tallyName(el: Element): string | null {
  const attr = el.getAttribute('NAME')?.trim()
  if (attr) return attr
  const nameList = childEls(el, 'NAME.LIST')[0] ?? childEls(el, 'LANGUAGENAME.LIST')[0]
  const n = nameList ? (childEls(nameList, 'NAME')[0]?.textContent?.trim() ?? null) : null
  return n || childText(el, 'NAME')
}

/** Reads every field of a table from one element. Quantities, rates, dates and periods also keep their original text under `<key>_text`. */
export function readFields(el: Element, defs: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const d of defs) {
    if (d.kind === 'name') {
      out[d.key] = tallyName(el)
      continue
    }
    if (d.kind === 'address') {
      const lists = childEls(el, 'ADDRESS.LIST').flatMap((a) => childEls(a, 'ADDRESS').map((x) => x.textContent?.trim() ?? '')).filter(Boolean)
      out[d.key] = (lists.length > 0 ? lists.join(', ') : childText(el, 'ADDRESS')) ?? null
      continue
    }
    const t = rawText(el, d)
    switch (d.kind) {
      case 'text':
        out[d.key] = t
        break
      case 'yes':
        out[d.key] = tallyYes(t)
        break
      case 'int':
        out[d.key] = t && /^-?\d+$/.test(t) ? Number(t) : null
        break
      case 'amount':
        out[d.key] = tallyAmount(t)
        break
      case 'date':
        out[d.key] = tallyDate(t)
        out[`${d.key}_text`] = t
        break
      case 'qty': {
        const q = parseQty(t)
        out[d.key] = q.qty
        out[`${d.key}_unit`] = q.unit
        out[`${d.key}_text`] = q.text
        break
      }
      case 'rate': {
        const r = parseRate(t)
        out[d.key] = r.rate
        out[`${d.key}_unit`] = r.unit
        out[`${d.key}_text`] = r.text
        break
      }
      default:
        break
    }
  }
  return out
}
