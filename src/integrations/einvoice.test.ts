import { describe, expect, it } from 'vitest'
import { MockEway, MockGsp, QR_CLAIM_KEYS, UnconfiguredGsp, decodeSignedQr, fyOf, irnFor, missingQrClaims, type EinvoicePayload } from '../../supabase/functions/_shared/einvoice'
import { cleanBankLines, parseGpsPayload } from '../../supabase/functions/_shared/adapters'

// Synthetic GSTINs and figures only.
const payload: EinvoicePayload = {
  Version: '1.1',
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { Typ: 'INV', No: 'TSI/26-27/0007', Dt: '03/11/2026' },
  SellerDtls: { Gstin: '32AAAAA1111A1Z5', LglNm: 'Test Company A Pvt Ltd', Stcd: '32' },
  BuyerDtls: { Gstin: '33BBBBB2222B1Z3', LglNm: 'Test Buyer', Pos: '33' },
  ItemList: [
    { SlNo: '1', HsnCd: '99999001', AssAmt: 200, TotItemVal: 236 },
    { SlNo: '2', HsnCd: '99999002', AssAmt: 50, TotItemVal: 50 },
  ],
  ValDtls: { AssVal: 250, TotInvVal: 286 },
}
const fixedNow = () => new Date('2026-11-03T06:30:00Z')

describe('GSP mock round trip', () => {
  it('works out the financial year from the document date', () => {
    expect(fyOf('03/11/2026')).toBe('2026-27')
    expect(fyOf('15/03/2027')).toBe('2026-27')
    expect(fyOf('01/04/2027')).toBe('2027-28')
  })
  it('returns an IRN made like the IRP (SHA-256 of GSTIN + FY + type + number), an acknowledgement and a signed QR', async () => {
    const r = await new MockGsp({ now: fixedNow }).generateIrn(payload)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.irn).toMatch(/^[0-9a-f]{64}$/)
    expect(r.irn).toBe(await irnFor(payload))
    expect(r.ack_no).toMatch(/^1[0-9]{14}$/)
    expect(r.ack_date).toBe('2026-11-03T06:30:00.000Z')
    const again = await new MockGsp({ now: fixedNow }).generateIrn(payload)
    expect(again.ok && again.irn).toBe(r.irn)
  })
  it('refuses a B2C document and reports provider failures as retryable or not', async () => {
    const b2c = await new MockGsp().generateIrn({ ...payload, BuyerDtls: { ...payload.BuyerDtls, Gstin: 'URP' } })
    expect(b2c).toMatchObject({ ok: false, retryable: false })
    expect(await new MockGsp({ failWith: 'Test timeout' }).generateIrn(payload)).toEqual({ ok: false, error: 'Test timeout', retryable: true })
    expect(await new UnconfiguredGsp('somegsp').generateIrn()).toMatchObject({ ok: false, retryable: false })
  })
  it('cancels a valid IRN only', async () => {
    expect((await new MockGsp({ now: fixedNow }).cancelIrn('a'.repeat(64))).ok).toBe(true)
    expect((await new MockGsp().cancelIrn('nope')).ok).toBe(false)
  })
  it('makes a 12-digit e-way bill number valid until the end of the next day (IST)', async () => {
    const r = await new MockEway({ now: fixedNow }).generate({ docNo: payload.DocDtls.No })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.eway_bill_no).toMatch(/^[0-9]{12}$/)
    expect(r.valid_until).toBe('2026-11-04T18:29:00.000Z')
  })
})

describe('e-invoice QR payload shape', () => {
  it('carries every field NIC puts in the signed QR, with the main HSN by value', async () => {
    const r = await new MockGsp({ now: fixedNow }).generateIrn(payload)
    if (!r.ok) throw new Error('mock failed')
    const { claims, issuer, isMock } = decodeSignedQr(r.signed_qr)
    expect(Object.keys(claims).sort()).toEqual([...QR_CLAIM_KEYS].sort())
    expect(missingQrClaims(claims)).toEqual([])
    expect(claims).toMatchObject({ SellerGstin: '32AAAAA1111A1Z5', BuyerGstin: '33BBBBB2222B1Z3', DocNo: 'TSI/26-27/0007', DocTyp: 'INV', DocDt: '03/11/2026',
      TotInvVal: 286, ItemCnt: 2, MainHsnCode: '99999001', Irn: r.irn, IrnDt: '2026-11-03 12:00:00' })
    expect(issuer).toBe('MOCK')
    expect(isMock).toBe(true)
  })
  it('reads the QR made by the database mock too (data as a JSON string)', () => {
    const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const jwt = `${b64('{"alg":"none"}')}.${b64(JSON.stringify({ data: JSON.stringify({ DocNo: 'X1', Irn: 'f'.repeat(64) }), iss: 'MOCK' }))}.MOCK`
    const { claims } = decodeSignedQr(jwt)
    expect(claims.DocNo).toBe('X1')
    expect(missingQrClaims(claims)).toContain('SellerGstin')
  })
  it('refuses something that is not a three-part token', () => {
    expect(() => decodeSignedQr('abc')).toThrow()
  })
})

describe('feed and GPS payload cleaning', () => {
  it('keeps only well-formed bank lines, rounded to paise', () => {
    expect(cleanBankLines([{ date: '2026-11-01', description: 'Test UPI', amount: '100.456', balance: '' }, { date: 'bad', amount: 5 }, { date: '2026-11-02', amount: 0 }]))
      .toEqual([{ date: '2026-11-01', description: 'Test UPI', ref: null, amount: 100.46, balance: null }])
  })
  it('drops GPS points with bad coordinates or times', () => {
    const r = parseGpsPayload({ device_id: 'TEST-DEV', points: [{ ts: '2026-11-03T06:30:00Z', lat: 10.5, lon: 76.2 }, { ts: 'x', lat: 1, lng: 1 }, { at: '2026-11-03T06:31:00Z', lat: 99, lng: 1 }] })
    expect(r.deviceRef).toBe('TEST-DEV')
    expect(r.points).toEqual([{ at: '2026-11-03T06:30:00.000Z', lat: 10.5, lng: 76.2, accuracy_m: null }])
  })
})
