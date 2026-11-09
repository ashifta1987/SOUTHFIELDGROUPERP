import { describe, expect, it } from 'vitest'
import spec from './specTags.json'
import { COLLECTIONS, REFERENCE_ONLY, readFields, type FieldDef } from './fields'
import { parseTallyXml } from './parseTallyXml'

// The tag list comes from the owner's table (sheet "Fields", 175 fields; tag names only, no business data).
const specTags = spec.collections as Record<string, string[]>
const total = Object.values(specTags).reduce((n, t) => n + t.length, 0)

const SAMPLE: Record<string, string> = {
  text: 'Sample Text',
  yes: 'Yes',
  date: '20260401',
  amount: '-100.00',
  qty: '5 Nos',
  rate: '20.00/Nos',
  int: '7',
}

/** a minimal element carrying every field of a table */
function elementFor(defs: FieldDef[]): Element {
  const xml = defs
    .map((d) => {
      if (d.kind === 'name') return ''
      if (d.kind === 'address') return '<ADDRESS.LIST><ADDRESS>Line One</ADDRESS><ADDRESS>Line Two</ADDRESS></ADDRESS.LIST>'
      return `<${d.tag}>${SAMPLE[d.kind] ?? 'x'}</${d.tag}>`
    })
    .join('')
  return new DOMParser().parseFromString(`<X NAME="Sample Name">${xml}</X>`, 'application/xml').documentElement
}

describe('spec field coverage (175 fields of the owner table)', () => {
  it('the spec list has all 175 fields in 21 collections', () => {
    expect(total).toBe(175)
    expect(Object.keys(specTags)).toHaveLength(21)
  })

  it('every spec tag of every collection is handled by the parser tables', () => {
    const missing: string[] = []
    for (const [collection, tags] of Object.entries(specTags)) {
      const handled = new Set((COLLECTIONS[collection] ?? []).map((d) => d.tag))
      for (const t of tags) if (!handled.has(t)) missing.push(`${collection}.${t}`)
    }
    expect(missing).toEqual([])
  })

  it('the parser tables have no collection outside the spec', () => {
    expect(Object.keys(COLLECTIONS).sort()).toEqual(Object.keys(specTags).sort())
  })

  it('every tag is actually read: a value written in the XML comes out of the parser', () => {
    const empty: string[] = []
    for (const [collection, defs] of Object.entries(COLLECTIONS)) {
      const v = readFields(elementFor(defs), defs)
      for (const d of defs) if (v[d.key] === null || v[d.key] === undefined) empty.push(`${collection}.${d.tag}`)
    }
    expect(empty).toEqual([])
  })

  it('only these tags exist in staging as reference (explicit allow-list)', () => {
    expect(REFERENCE_ONLY).toEqual({
      Company: [], Group: ['ISADDABLE'], Ledger: ['CLOSINGBALANCE'], VoucherType: [], CostCategory: [], CostCentre: [], Currency: [], StockGroup: [], StockCategory: [],
      StockItem: ['COSTINGMETHOD', 'VALUATIONMETHOD', 'CLOSINGBALANCE', 'CLOSINGRATE', 'CLOSINGVALUE'], Unit: [], Godown: [], Voucher: ['AMOUNT'],
      AllLedgerEntries: [], AllInventoryEntries: [], BatchAllocations: [], AccountingAllocations: [], BillAllocations: [], CategoryAllocations: [],
      CostCentreAllocations: [], BankAllocations: [],
    })
  })

  it('every master collection becomes a staged row', () => {
    const xml = `<ENVELOPE>${[
      'GROUP', 'VOUCHERTYPE', 'COSTCATEGORY', 'COSTCENTRE', 'CURRENCY', 'STOCKGROUP', 'STOCKCATEGORY', 'STOCKITEM', 'UNIT', 'GODOWN', 'LEDGER',
    ].map((t) => `<TALLYMESSAGE><${t} NAME="Test ${t}"><GUID>g-${t}</GUID></${t}></TALLYMESSAGE>`).join('')}</ENVELOPE>`
    const r = parseTallyXml(xml)
    expect(Object.keys(r.counts).sort()).toEqual(
      ['cost_category', 'cost_centre', 'currency', 'godown', 'group', 'ledger', 'stock_category', 'stock_group', 'stock_item', 'unit', 'voucher_type'],
    )
  })
})
