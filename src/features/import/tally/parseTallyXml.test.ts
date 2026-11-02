import { describe, expect, it } from 'vitest'
import { chunk, decodeTallyBytes, parseTallyXml, sanitizeTallyXml, tallyAmount, tallyDate, tallyQty } from './parseTallyXml'

// Synthetic Tally XML only (never real data).
const XML = `<?xml version="1.0"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><STATICVARIABLES><SVCURRENTCOMPANY>Test Company A</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE><GROUP NAME="Sundry Debtors"><GUID>g-grp-1</GUID><PARENT>Current Assets</PARENT><ALTERID>2</ALTERID></GROUP></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Test Traders Pvt Ltd"><GUID>g-led-1</GUID><MASTERID>101</MASTERID><ALTERID>10</ALTERID>
  <PARENT>Sundry Debtors</PARENT><INCOMETAXNUMBER>CCCCC1111C</INCOMETAXNUMBER><LEDGERMOBILE>9000000001</LEDGERMOBILE>
  <ADDRESS.LIST><ADDRESS>Test Street 1</ADDRESS><ADDRESS>Test Town</ADDRESS></ADDRESS.LIST>
  <LEDGSTREGDETAILS.LIST><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><GSTIN>32CCCCC1111C1ZN</GSTIN></LEDGSTREGDETAILS.LIST>
  <OPENINGBALANCE>-1500.00</OPENINGBALANCE>
  <BILLALLOCATIONS.LIST><NAME>TB-1</NAME><BILLDATE>20260301</BILLDATE><OPENINGBALANCE>-1500.00</OPENINGBALANCE></BILLALLOCATIONS.LIST>
</LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><STOCKITEM NAME="Test Soap 100 g"><GUID>g-si-1</GUID><ALTERID>4</ALTERID><PARENT>Test Soaps</PARENT><BASEUNITS>Nos</BASEUNITS>
  <GSTDETAILS.LIST><HSNCODE>34011190</HSNCODE></GSTDETAILS.LIST><OPENINGBALANCE>-5 Nos</OPENINGBALANCE><OPENINGVALUE>-250.00</OPENINGVALUE>
  <MRPDETAILS.LIST><MRPRATEDETAILS.LIST><MRPRATE>45.00</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST></STOCKITEM></TALLYMESSAGE>
<TALLYMESSAGE><COSTCENTRE NAME="Test Worker One"><GUID>g-emp-1</GUID><FORPAYROLL>Yes</FORPAYROLL><ISEMPLOYEEGROUP>No</ISEMPLOYEEGROUP>
  <EMPLOYEENUMBER>E01</EMPLOYEENUMBER><INCOMETAXNUMBER>WWWWW1111W</INCOMETAXNUMBER><AADHARNUMBER>1234 5678 9012</AADHARNUMBER></COSTCENTRE></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Sales" ACTION="Create"><GUID>g-v-1</GUID><ALTERID>5</ALTERID><DATE>20260410</DATE><VOUCHERNUMBER>T/1</VOUCHERNUMBER>
  <PARTYLEDGERNAME>Test Traders Pvt Ltd</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Test Traders Pvt Ltd</LEDGERNAME><AMOUNT>-1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output GST</LEDGERNAME><AMOUNT>180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`

describe('parseTallyXml', () => {
  const parsed = parseTallyXml(XML)

  it('reads every master and voucher with its Tally identity', () => {
    expect(parsed.counts).toEqual({ group: 1, ledger: 1, stock_item: 1, employee: 1, voucher: 1 })
    const ledger = parsed.rows.find((r) => r.object_type === 'ledger')!
    expect(ledger).toMatchObject({ name: 'Test Traders Pvt Ltd', guid: 'g-led-1', master_id: '101', alter_id: 10 })
    expect(parsed.companyName).toBe('Test Company A')
  })

  it('keeps ledger GST, PAN, phone, address, opening and bill-wise outstanding (negative = debit)', () => {
    const p = parsed.rows.find((r) => r.object_type === 'ledger')!.payload
    expect(p).toMatchObject({ parent: 'Sundry Debtors', gstin: '32CCCCC1111C1ZN', gst_reg_type: 'Regular', pan: 'CCCCC1111C', phone: '9000000001', address: 'Test Street 1, Test Town', opening: -1500 })
    expect(p.bills).toEqual([{ ref: 'TB-1', date: '2026-03-01', amount: -1500, due: null }])
  })

  it('reads stock items with HSN, unit, MRP and opening (negative stock kept as is)', () => {
    const p = parsed.rows.find((r) => r.object_type === 'stock_item')!.payload
    expect(p).toMatchObject({ parent: 'Test Soaps', unit: 'Nos', hsn: '34011190', mrp: 45, opening_qty: -5, opening_value: -250 })
  })

  it('turns payroll cost centres into employees and keeps only the Aadhaar last 4', () => {
    const e = parsed.rows.find((r) => r.object_type === 'employee')!
    expect(e.payload).toMatchObject({ code: 'E01', pan: 'WWWWW1111W', aadhaar_last4: '9012' })
    expect(JSON.stringify(e)).not.toContain('5678')
  })

  it('reads vouchers with lines, party amount and the period', () => {
    const v = parsed.rows.find((r) => r.object_type === 'voucher')!
    expect(v.payload).toMatchObject({ type: 'Sales', number: 'T/1', date: '2026-04-10', party: 'Test Traders Pvt Ltd', amount: 1180, cancelled: false })
    expect((v.payload.lines as unknown[]).length).toBe(3)
    expect(parsed.periodFrom).toBe('2026-04-10')
    expect(parsed.periodTo).toBe('2026-04-10')
  })

  it('rejects files that are not XML', () => {
    expect(() => parseTallyXml('this is not xml <')).toThrow('not_tally_xml')
  })
})

describe('helpers', () => {
  it('parses Tally amounts, quantities and dates', () => {
    expect(tallyAmount('-1,500.00')).toBe(-1500)
    expect(tallyAmount('1500 Dr')).toBe(-1500)
    expect(tallyAmount('1500 Cr')).toBe(1500)
    expect(tallyAmount(null)).toBeNull()
    expect(tallyQty('100 Nos')).toEqual({ qty: 100, unit: 'Nos' })
    expect(tallyDate('20260401')).toBe('2026-04-01')
  })
  it('decodes UTF-16 files and strips control characters', () => {
    const s = '<A>x</A>'
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from(s).flatMap((c) => [c.charCodeAt(0), 0])])
    expect(decodeTallyBytes(utf16)).toBe(s)
    expect(sanitizeTallyXml('<A>a&#4;b</A>')).toBe('<A>ab</A>')
  })
  it('chunks rows', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

