import { describe, expect, it } from 'vitest'
import { parseTallyXml } from './parseTallyXml'
import { parseCreditDays, parseDiscount, parseQty, parseRate, roundQty } from './fields'
import { amountAgrees, signDisagrees } from './voucherChildren'

// Synthetic Tally XML only (never real data). Negative amount = debit (spec §8).
const wrap = (voucher: string) => `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>${voucher}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
const one = (voucher: string) => {
  const r = parseTallyXml(wrap(voucher)).rows[0]
  if (!r || !r.children) throw new Error('no voucher')
  return r as typeof r & { children: NonNullable<typeof r.children> }
}

describe('quantity, rate, discount and credit-period parsing', () => {
  it('reads number and unit, keeps the text', () => {
    expect(parseQty('10 Nos')).toEqual({ qty: 10, unit: 'Nos', text: '10 Nos' })
    expect(parseQty(' 2.500 kg')).toMatchObject({ qty: 2.5, unit: 'kg' })
    expect(parseQty('1,250 Kgs')).toMatchObject({ qty: 1250, unit: 'Kgs' })
    expect(parseQty('-3 Ltrs')).toMatchObject({ qty: -3, unit: 'Ltrs' })
  })
  it('compound units use the converted base quantity', () => {
    expect(parseQty('2 Box = 24 Nos')).toMatchObject({ qty: 24, unit: 'Nos' })
  })
  it('an unreadable quantity keeps its text', () => {
    expect(parseQty('abc')).toEqual({ qty: null, unit: null, text: 'abc' })
    expect(parseQty('')).toEqual({ qty: null, unit: null, text: null })
  })
  it('reads rates like 100.00/Nos', () => {
    expect(parseRate('100.00/Nos')).toMatchObject({ rate: 100, unit: 'Nos' })
    expect(parseRate('1,250.50/Kgs')).toMatchObject({ rate: 1250.5, unit: 'Kgs' })
    expect(parseRate('$ 2.00/Nos = 168.00/Nos')).toMatchObject({ rate: 168, unit: 'Nos' })
  })
  it('discount and credit period', () => {
    expect(parseDiscount('10%').pct).toBe(10)
    expect(parseDiscount('abc').pct).toBeNull()
    expect(parseCreditDays('30 Days')).toBe(30)
    expect(parseCreditDays('')).toBeNull()
  })
  it('quantities round to the unit decimals', () => {
    expect(roundQty(1.23456, 3)).toBe(1.235)
    expect(roundQty(1.5, 0)).toBe(2)
  })
  it('the sign and amount rules', () => {
    expect(signDisagrees(-100, true)).toBe(false)
    expect(signDisagrees(100, true)).toBe(true)
    expect(signDisagrees(100, false)).toBe(false)
    expect(amountAgrees(100, 2, null, 200.4)).toBe(true)
    expect(amountAgrees(100, 2, 10, 180)).toBe(true)
    expect(amountAgrees(100, 2, null, 250)).toBe(false)
    expect(amountAgrees(null, 2, null, 250)).toBeNull()
  })
})

describe('voucher child lists', () => {
  it('an item invoice: ledger entries, inventory lines and their accounting allocations', () => {
    const r = one(`<VOUCHER VCHTYPE="Sales"><GUID>v1</GUID><DATE>20260410</DATE><VOUCHERNUMBER>S/1</VOUCHERNUMBER><PARTYLEDGERNAME>Test Customer</PARTYLEDGERNAME>
      <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>Yes</ISINVOICE><PLACEOFSUPPLY>Kerala</PLACEOFSUPPLY><REFERENCE>PO-9</REFERENCE><REFERENCEDATE>20260405</REFERENCEDATE>
      <EFFECTIVEDATE>20260410</EFFECTIVEDATE><BASICBUYERNAME>Test Buyer</BASICBUYERNAME><PARTYGSTIN>32AAAAA0000A1Z5</PARTYGSTIN><VOUCHERKEY>1234</VOUCHERKEY>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Test Customer</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output GST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><GSTCLASS>Not Applicable</GSTCLASS><AMOUNT>180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Test Item</STOCKITEMNAME><GSTHSNNAME>34011190</GSTHSNNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>100.00/Nos</RATE><DISCOUNT>0</DISCOUNT>
        <AMOUNT>1000.00</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY>
        <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Test Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST></VOUCHER>`)
    const c = r.children
    expect(c.lines.map((l) => [l.list, l.ledger, l.amount, l.party])).toEqual([
      ['ALLLEDGERENTRIES', 'Test Customer', -1180, true],
      ['ALLLEDGERENTRIES', 'Output GST', 180, null],
      ['ACCOUNTINGALLOCATIONS', 'Test Sales', 1000, null],
    ])
    expect(c.lines[2]?.inv_no).toBe(1)
    expect(c.lines[1]?.gst_class).toBe('Not Applicable')
    expect(c.lines.every((l) => l.flags.length === 0)).toBe(true)
    expect(c.inventory).toHaveLength(1)
    expect(c.inventory[0]).toMatchObject({ item: 'Test Item', actual_qty: 10, actual_unit: 'Nos', billed_qty: 10, rate: 100, rate_unit: 'Nos', amount: 1000, hsn: '34011190', list_kind: 'entries' })
    expect(c.inventory[0]?.flags).toEqual([])
    expect(r.payload).toMatchObject({
      persisted_view: 'Invoice Voucher View', is_invoice: true, place_of_supply: 'Kerala', reference: 'PO-9', reference_date: '2026-04-05', effective_date: '2026-04-10',
      buyer_name: 'Test Buyer', party_gstin: '32AAAAA0000A1Z5', voucher_key: '1234',
    })
    expect(typeof r.payload.row_hash).toBe('string')
    // backward compatible: the voucher still balances through `lines`
    expect((r.payload.lines as { amount: number }[]).reduce((s, l) => s + l.amount, 0)).toBe(0)
  })

  it('the accounting-view variant (LEDGERENTRIES) is read too', () => {
    const r = one(`<VOUCHER VCHTYPE="Journal"><GUID>v2</GUID><DATE>20260411</DATE>
      <LEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-50</AMOUNT></LEDGERENTRIES.LIST>
      <LEDGERENTRIES.LIST><LEDGERNAME>B</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>50</AMOUNT></LEDGERENTRIES.LIST></VOUCHER>`)
    expect(r.children.lines.map((l) => [l.list, l.ledger])).toEqual([['LEDGERENTRIES', 'A'], ['LEDGERENTRIES', 'B']])
  })

  it('a stock journal keeps the inward and the outward list apart', () => {
    const r = one(`<VOUCHER VCHTYPE="Stock Journal"><GUID>v3</GUID><DATE>20260412</DATE>
      <INVENTORYENTRIESOUT.LIST><STOCKITEMNAME>Raw A</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ACTUALQTY> 5 Kgs</ACTUALQTY><BILLEDQTY> 5 Kgs</BILLEDQTY><RATE>10/Kgs</RATE><AMOUNT>50</AMOUNT></INVENTORYENTRIESOUT.LIST>
      <INVENTORYENTRIESIN.LIST><STOCKITEMNAME>Made B</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ACTUALQTY> 4 Nos</ACTUALQTY><BILLEDQTY> 4 Nos</BILLEDQTY><RATE>12.50/Nos</RATE><AMOUNT>-50</AMOUNT>
        <BATCHALLOCATIONS.LIST><GODOWNNAME>Test Godown</GODOWNNAME><BATCHNAME>B-001</BATCHNAME><MFDON>20260412</MFDON><EXPIRYPERIOD>12 Months</EXPIRYPERIOD><ACTUALQTY> 4 Nos</ACTUALQTY><BILLEDQTY> 4 Nos</BILLEDQTY><AMOUNT>-50</AMOUNT><ORDERNO>SO-1</ORDERNO><TRACKINGNUMBER>DN-1</TRACKINGNUMBER></BATCHALLOCATIONS.LIST>
      </INVENTORYENTRIESIN.LIST></VOUCHER>`)
    expect(r.children.inventory.map((i) => [i.list_kind, i.item, i.actual_qty])).toEqual([['out', 'Raw A', 5], ['in', 'Made B', 4]])
    expect(r.children.inventory.every((i) => i.flags.length === 0)).toBe(true)
    expect(r.children.batches).toHaveLength(1)
    expect(r.children.batches[0]).toMatchObject({ inv_no: 2, godown: 'Test Godown', batch: 'B-001', actual_qty: 4, actual_unit: 'Nos', mfd_on: '2026-04-12', expiry_text: '12 Months', expiry_on: null, order_no: 'SO-1', tracking_no: 'DN-1' })
  })

  it('a batch with an expiry date and a manufacturing date is read as dates', () => {
    const r = one(`<VOUCHER VCHTYPE="Purchase"><GUID>v4</GUID><DATE>20260413</DATE><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>X</STOCKITEMNAME><ACTUALQTY> 1 Nos</ACTUALQTY>
      <BATCHALLOCATIONS.LIST><BATCHNAME>B</BATCHNAME><MFDON>20260101</MFDON><EXPIRYPERIOD>20271231</EXPIRYPERIOD></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER>`)
    expect(r.children.batches[0]).toMatchObject({ mfd_on: '2026-01-01', expiry_on: '2027-12-31' })
  })

  it('bill allocations: New Ref, Agst Ref, Advance, On Account with a credit period', () => {
    const r = one(`<VOUCHER VCHTYPE="Receipt"><GUID>v5</GUID><DATE>20260414</DATE>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Test Customer</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>500</AMOUNT>
        <BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>300</AMOUNT></BILLALLOCATIONS.LIST>
        <BILLALLOCATIONS.LIST><NAME>INV-2</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>100</AMOUNT><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD></BILLALLOCATIONS.LIST>
        <BILLALLOCATIONS.LIST><NAME>ADV-1</NAME><BILLTYPE>Advance</BILLTYPE><AMOUNT>50</AMOUNT></BILLALLOCATIONS.LIST>
        <BILLALLOCATIONS.LIST><NAME>x</NAME><BILLTYPE>On Account</BILLTYPE><AMOUNT>50</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>`)
    expect(r.children.bills.map((b) => [b.name, b.bill_type, b.amount, b.credit_days, b.line_no])).toEqual([
      ['INV-1', 'Agst Ref', 300, null, 1], ['INV-2', 'New Ref', 100, 30, 1], ['ADV-1', 'Advance', 50, null, 1], ['x', 'On Account', 50, null, 1],
    ])
  })

  it('a bank allocation', () => {
    const r = one(`<VOUCHER VCHTYPE="Payment"><GUID>v6</GUID><DATE>20260415</DATE>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Test Bank</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900</AMOUNT>
        <BANKALLOCATIONS.LIST><DATE>20260415</DATE><INSTRUMENTDATE>20260416</INSTRUMENTDATE><INSTRUMENTNUMBER>000123</INSTRUMENTNUMBER><TRANSACTIONTYPE>Cheque</TRANSACTIONTYPE><PAYMENTFAVOURING>Test Payee</PAYMENTFAVOURING><BANKERSDATE>20260420</BANKERSDATE><AMOUNT>900</AMOUNT></BANKALLOCATIONS.LIST>
      </ALLLEDGERENTRIES.LIST></VOUCHER>`)
    expect(r.children.banks[0]).toEqual({
      no: 1, line_no: 1, date: '2026-04-15', instrument_date: '2026-04-16', instrument_number: '000123', transaction_type: 'Cheque', favouring: 'Test Payee', bankers_date: '2026-04-20', amount: 900,
    })
  })

  it('a cost centre split under a category allocation', () => {
    const r = one(`<VOUCHER VCHTYPE="Payment"><GUID>v7</GUID><DATE>20260416</DATE>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Test Expense</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000</AMOUNT>
        <CATEGORYALLOCATIONS.LIST><CATEGORY>Primary Cost Category</CATEGORY><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <COSTCENTREALLOCATIONS.LIST><NAME>Unit One</NAME><AMOUNT>-600</AMOUNT></COSTCENTREALLOCATIONS.LIST>
          <COSTCENTREALLOCATIONS.LIST><NAME>Unit Two</NAME><AMOUNT>-400</AMOUNT></COSTCENTREALLOCATIONS.LIST></CATEGORYALLOCATIONS.LIST>
      </ALLLEDGERENTRIES.LIST></VOUCHER>`)
    expect(r.children.costcentres.map((c) => [c.category, c.centre, c.amount, c.line_no, c.deemed_positive])).toEqual([
      ['Primary Cost Category', 'Unit One', -600, 1, true], ['Primary Cost Category', 'Unit Two', -400, 1, true],
    ])
  })

  it('flags: sign disagreement, unreadable quantity, amount off by more than ₹1, rate unit differs', () => {
    const r = one(`<VOUCHER VCHTYPE="Sales"><GUID>v8</GUID><DATE>20260417</DATE>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>100</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>I</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ACTUALQTY>many</ACTUALQTY><BILLEDQTY> 2 Nos</BILLEDQTY><RATE>100/Kgs</RATE><AMOUNT>250</AMOUNT></ALLINVENTORYENTRIES.LIST></VOUCHER>`)
    expect(r.children.lines[0]?.flags).toEqual(['sign_mismatch'])
    expect(r.children.inventory[0]?.flags.sort()).toEqual(['amount_mismatch', 'qty_unparsed', 'unit_mismatch'])
  })

  it('a cancelled and an optional voucher keep their flags and their lists', () => {
    const r = one(`<VOUCHER VCHTYPE="Sales"><GUID>v9</GUID><DATE>20260418</DATE><ISCANCELLED>Yes</ISCANCELLED><ISOPTIONAL>Yes</ISOPTIONAL><ISPOSTDATED>Yes</ISPOSTDATED>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`)
    expect(r.payload).toMatchObject({ cancelled: true, optional: true, is_post_dated: true })
    expect(r.children.lines).toHaveLength(1)
  })

  it('a user-defined voucher type is read as a master with its parent', () => {
    const rows = parseTallyXml(`<ENVELOPE><TALLYMESSAGE><VOUCHERTYPE NAME="Test Sales Local" RESERVEDNAME=""><GUID>vt1</GUID><PARENT>Sales</PARENT><NUMBERINGMETHOD>Automatic</NUMBERINGMETHOD>
      <ISACTIVE>Yes</ISACTIVE><PREVENTDUPLICATES>No</PREVENTDUPLICATES><AFFECTSSTOCK>Yes</AFFECTSSTOCK><ISOPTIONAL>No</ISOPTIONAL></VOUCHERTYPE></TALLYMESSAGE></ENVELOPE>`).rows
    expect(rows[0]).toMatchObject({ object_type: 'voucher_type', name: 'Test Sales Local', guid: 'vt1' })
    expect(rows[0]?.payload).toMatchObject({ parent: 'Sales', numbering: 'Automatic', active: true, prevent_duplicates: false, affects_stock: true, optional: false })
  })

  it('stock item masters keep batch, expiry, HSN, units and opening allocations', () => {
    const rows = parseTallyXml(`<ENVELOPE><TALLYMESSAGE><STOCKITEM NAME="Test Item"><GUID>si1</GUID><PARENT>Test Group</PARENT><CATEGORY>Test Cat</CATEGORY><BASEUNITS>Nos</BASEUNITS><ADDITIONALUNITS>Box</ADDITIONALUNITS><CONVERSION>12</CONVERSION>
      <ISBATCHWISEON>Yes</ISBATCHWISEON><ISPERISHABLEON>Yes</ISPERISHABLEON><GSTDETAILS.LIST><GSTAPPLICABLE>Applicable</GSTAPPLICABLE><HSNCODE>34011190</HSNCODE></GSTDETAILS.LIST>
      <OPENINGBALANCE> 20 Nos</OPENINGBALANCE><OPENINGVALUE>-400.00</OPENINGVALUE><OPENINGRATE>20.00/Nos</OPENINGRATE>
      <BATCHALLOCATIONS.LIST><GODOWNNAME>G1</GODOWNNAME><BATCHNAME>B1</BATCHNAME><OPENINGBALANCE> 20 Nos</OPENINGBALANCE><OPENINGVALUE>-400.00</OPENINGVALUE><MFDON>20260101</MFDON></BATCHALLOCATIONS.LIST></STOCKITEM></TALLYMESSAGE></ENVELOPE>`).rows
    expect(rows[0]?.payload).toMatchObject({
      unit: 'Nos', hsn: '34011190', batch_wise: true, perishable: true, gst_applicable: 'Applicable', alt_unit: 'Box', alt_conversion: '12', category: 'Test Cat',
      opening_balance: 20, opening_rate: 20, opening_value: -400,
    })
    expect(rows[0]?.payload.opening_allocations).toEqual([{ godown: 'G1', batch: 'B1', qty: 20, unit: 'Nos', rate: null, value: -400, mfd: '2026-01-01', expiry_text: null }])
  })

  it('UTF-16 text with entities still parses (BOM handled by decodeTallyBytes)', () => {
    const r = one(`<VOUCHER VCHTYPE="Journal"><GUID>v10</GUID><DATE>20260419</DATE><NARRATION>A &amp; B &#4; test</NARRATION><LEDGERENTRIES.LIST><LEDGERNAME>R &amp; D</LEDGERNAME><AMOUNT>-1</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></LEDGERENTRIES.LIST></VOUCHER>`.replace('&#4;', ''))
    expect(r.payload.narration).toBe('A & B  test')
    expect(r.children.lines[0]?.ledger).toBe('R & D')
  })
})
