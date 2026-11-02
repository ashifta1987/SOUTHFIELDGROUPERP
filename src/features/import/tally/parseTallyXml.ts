/**
 * Tally XML → staged import rows (§25A). This only converts the file format; every matching, duplicate and
 * creation decision is made by api.import_process in Postgres.
 *
 * Reads the TALLYMESSAGE elements of a TallyPrime XML export (masters and/or day book): GROUP, LEDGER, STOCKGROUP,
 * STOCKITEM, UNIT, GODOWN, COSTCENTRE (payroll employees) and VOUCHER, keeping Tally's GUID, MASTERID and ALTERID.
 * Tally amounts keep Tally's sign (negative = debit).
 */

export type ObjectType = 'group' | 'ledger' | 'stock_group' | 'stock_item' | 'unit' | 'godown' | 'cost_centre' | 'employee' | 'voucher'

export interface StageRow {
  object_type: ObjectType
  name: string | null
  guid: string | null
  master_id: string | null
  alter_id: number | null
  payload: Record<string, unknown>
}

export interface ParsedTally {
  rows: StageRow[]
  counts: Record<string, number>
  /** Earliest and latest voucher dates in the file (YYYY-MM-DD), used for "deleted in Tally" checks */
  periodFrom: string | null
  periodTo: string | null
  companyName: string | null
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

/** "-1,500.00" or "1500 Dr" → signed number (negative = debit), or null. */
export function tallyAmount(v: string | null): number | null {
  if (v === null) return null
  let s = v.replace(/,/g, '').trim()
  let sign = 1
  if (/\bDr\b/i.test(s)) {
    sign = -1
    s = s.replace(/\bDr\b/i, '')
  } else if (/\bCr\b/i.test(s)) s = s.replace(/\bCr\b/i, '')
  const m = s.match(/-?\d+(\.\d+)?/)
  if (!m) return null
  return Number(m[0]) * sign
}

/** "100 Nos" → { qty: 100, unit: "Nos" } */
export function tallyQty(v: string | null): { qty: number | null; unit: string | null } {
  if (!v) return { qty: null, unit: null }
  const m = v.replace(/,/g, '').trim().match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/)
  if (!m || !m[1]) return { qty: null, unit: null }
  return { qty: Number(m[1]), unit: m[2]?.trim() || null }
}

/** YYYYMMDD → YYYY-MM-DD */
export function tallyDate(v: string | null): string | null {
  if (!v) return null
  const m = v.trim().match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const iso = v.trim().match(/^\d{4}-\d{2}-\d{2}$/)
  return iso ? v.trim() : null
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
      pincode: text(el, 'PINCODE'),
      address: address || null,
      opening: tallyAmount(text(el, 'OPENINGBALANCE')) ?? 0,
      bills,
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
    },
  }
}

function parseVoucher(el: Element): StageRow {
  const lineEls = [...children(el, 'ALLLEDGERENTRIES.LIST'), ...children(el, 'LEDGERENTRIES.LIST')]
  const lines = lineEls
    .map((l) => ({ ledger: text(l, 'LEDGERNAME'), amount: tallyAmount(text(l, 'AMOUNT')) ?? 0 }))
    .filter((l) => l.ledger)
  const party = text(el, 'PARTYLEDGERNAME') ?? text(el, 'PARTYNAME')
  const partyLine = lines.find((l) => party && l.ledger === party)
  const positive = lines.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0)
  const amount = partyLine ? Math.abs(partyLine.amount) : Math.round(positive * 100) / 100
  const yes = (v: string | null) => (v ?? '').toLowerCase() === 'yes'
  return {
    object_type: 'voucher',
    name: [el.getAttribute('VCHTYPE') ?? text(el, 'VOUCHERTYPENAME'), text(el, 'VOUCHERNUMBER')].filter(Boolean).join(' '),
    ...identity(el),
    payload: {
      type: el.getAttribute('VCHTYPE') ?? text(el, 'VOUCHERTYPENAME'),
      number: text(el, 'VOUCHERNUMBER'),
      date: tallyDate(text(el, 'DATE')),
      party,
      amount,
      cancelled: yes(text(el, 'ISCANCELLED')),
      optional: yes(text(el, 'ISOPTIONAL')),
      narration: text(el, 'NARRATION'),
      lines,
    },
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
  return { object_type: 'cost_centre', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT'), category: text(el, 'CATEGORY') } }
}

export function parseTallyXml(xml: string): ParsedTally {
  const doc = new DOMParser().parseFromString(sanitizeTallyXml(xml), 'application/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new Error('not_tally_xml')
  const rows: StageRow[] = []
  const warnings: string[] = []
  const messages = Array.from(doc.getElementsByTagName('TALLYMESSAGE'))
  const containers = messages.length > 0 ? messages : [doc.documentElement]
  for (const msg of containers) {
    for (const el of Array.from(msg.children)) {
      const tag = el.tagName.toUpperCase()
      switch (tag) {
        case 'GROUP':
          rows.push({ object_type: 'group', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT') } })
          break
        case 'LEDGER':
          rows.push(parseLedger(el))
          break
        case 'STOCKGROUP':
          rows.push({ object_type: 'stock_group', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT') } })
          break
        case 'STOCKITEM':
          rows.push(parseStockItem(el))
          break
        case 'UNIT':
          rows.push({ object_type: 'unit', name: nameOf(el), ...identity(el), payload: { simple: text(el, 'ISSIMPLEUNIT') } })
          break
        case 'GODOWN':
          rows.push({ object_type: 'godown', name: nameOf(el), ...identity(el), payload: { parent: text(el, 'PARENT') } })
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
  return { rows, counts, periodFrom: dates[0] ?? null, periodTo: dates[dates.length - 1] ?? null, companyName, warnings }
}

/** Split rows into chunks for api.import_stage_rows. */
export function chunk<T>(items: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
