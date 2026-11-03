// E-invoice (IRP through a GSP) and e-way bill adapters. Business code talks only to GspAdapter / EwayAdapter; the owner
// picks the GSP later (Q-P8-1) and the real adapter is added beside MockGsp without touching the callers.
// Pure module (Web Crypto only): imported by the Edge Functions and unit-tested by Vitest.

export interface IrnSuccess { ok: true; irn: string; ack_no: string; ack_date: string; signed_qr: string }
export interface ProviderFailure { ok: false; error: string; retryable: boolean }
export type IrnResult = IrnSuccess | ProviderFailure
export type CancelResult = { ok: true; cancel_date: string } | ProviderFailure

export interface EwaySuccess { ok: true; eway_bill_no: string; generated_at: string; valid_until: string | null }
export type EwayResult = EwaySuccess | ProviderFailure

/** INV-01 request as built by app.einvoice_payload (only the fields the adapters read are typed). */
export interface EinvoicePayload {
  Version: string
  TranDtls: { TaxSch: string; SupTyp: string }
  DocDtls: { Typ: 'INV' | 'CRN' | 'DBN'; No: string; Dt: string }
  SellerDtls: { Gstin: string; LglNm: string; Stcd?: string }
  BuyerDtls: { Gstin: string; LglNm: string; Pos: string }
  ItemList: Array<{ SlNo: string; HsnCd: string | null; AssAmt: number; TotItemVal: number }>
  ValDtls: { AssVal: number; TotInvVal: number }
}

/** The fields NIC puts inside the signed QR code (the JWT payload's `data`, itself a JSON string). */
export interface QrClaims {
  SellerGstin: string
  BuyerGstin: string
  DocNo: string
  DocTyp: string
  DocDt: string
  TotInvVal: number
  ItemCnt: number
  MainHsnCode: string | null
  Irn: string
  IrnDt: string
}
export const QR_CLAIM_KEYS: Array<keyof QrClaims> = ['SellerGstin', 'BuyerGstin', 'DocNo', 'DocTyp', 'DocDt', 'TotInvVal', 'ItemCnt', 'MainHsnCode', 'Irn', 'IrnDt']

export interface GspAdapter {
  readonly name: string
  generateIrn(payload: EinvoicePayload): Promise<IrnResult>
  cancelIrn(irn: string, reasonCode: '1' | '2' | '3' | '4', remark: string): Promise<CancelResult>
}

export interface EwayAdapter {
  readonly name: string
  generate(payload: Record<string, unknown>): Promise<EwayResult>
  updatePartB(ewbNo: string, vehicleNo: string, reason: string): Promise<{ ok: true; valid_until: string | null } | ProviderFailure>
  cancel(ewbNo: string, remark: string): Promise<{ ok: true } | ProviderFailure>
}

// ─────────── helpers ───────────
const enc = new TextEncoder()
const dec = new TextDecoder()

export async function sha256HexOf(text: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function base64UrlEncode(text: string): string {
  let bin = ''
  for (const b of enc.encode(text)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/** Financial year (April–March) of a DD/MM/YYYY date, as "2026-27". */
export function fyOf(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split('/').map(Number)
  if (!d || !m || !y) throw new Error('date must be DD/MM/YYYY')
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** IRN as the IRP makes it: SHA-256 (hex) of supplier GSTIN + FY + document type + document number. */
export function irnFor(p: EinvoicePayload): Promise<string> {
  return sha256HexOf(p.SellerDtls.Gstin + fyOf(p.DocDtls.Dt) + p.DocDtls.Typ + p.DocDtls.No)
}

export function buildQrClaims(p: EinvoicePayload, irn: string, irnDt: string): QrClaims {
  const main = [...p.ItemList].sort((a, b) => b.AssAmt - a.AssAmt)[0]
  return {
    SellerGstin: p.SellerDtls.Gstin, BuyerGstin: p.BuyerDtls.Gstin, DocNo: p.DocDtls.No, DocTyp: p.DocDtls.Typ, DocDt: p.DocDtls.Dt,
    TotInvVal: p.ValDtls.TotInvVal, ItemCnt: p.ItemList.length, MainHsnCode: main?.HsnCd ?? null, Irn: irn, IrnDt: irnDt,
  }
}

/** An unsigned JWT-shaped QR payload (header.payload.MOCK) — mock provider only; the real one is signed by NIC. */
export function mockSignedQr(claims: QrClaims): string {
  return `${base64UrlEncode('{"alg":"none","typ":"JWT"}')}.${base64UrlEncode(JSON.stringify({ data: JSON.stringify(claims), iss: 'MOCK' }))}.MOCK`
}

/** Read the claims inside a signed QR (does not verify NIC's signature — the printed QR is verified by the reader app). */
export function decodeSignedQr(jwt: string): { claims: QrClaims; issuer: string | null; isMock: boolean } {
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) throw new Error('a signed QR has three parts')
  const body = JSON.parse(base64UrlDecode(parts[1])) as { data?: string | QrClaims; iss?: string }
  const claims = (typeof body.data === 'string' ? JSON.parse(body.data) : body.data) as QrClaims
  return { claims, issuer: body.iss ?? null, isMock: parts[2] === 'MOCK' }
}

export function missingQrClaims(c: Partial<QrClaims>): string[] {
  return QR_CLAIM_KEYS.filter((k) => c[k] === undefined || c[k] === '')
}

function istStamp(d: Date): string {
  const t = new Date(d.getTime() + 330 * 60000).toISOString()
  return `${t.slice(0, 10)} ${t.slice(11, 19)}`
}

// ─────────── Mock providers (DEV and tests; never used where integrations.allow_mock is off) ───────────
export class MockGsp implements GspAdapter {
  readonly name = 'mock'
  constructor(private opts: { failWith?: string; retryable?: boolean; now?: () => Date } = {}) {}

  async generateIrn(p: EinvoicePayload): Promise<IrnResult> {
    if (this.opts.failWith) return { ok: false, error: this.opts.failWith, retryable: this.opts.retryable ?? true }
    if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(p.SellerDtls?.Gstin ?? '') || !/^[0-9]{2}[A-Z0-9]{13}$/.test(p.BuyerDtls?.Gstin ?? '')) {
      return { ok: false, error: 'seller and buyer GSTINs are required (B2B only)', retryable: false }
    }
    const now = (this.opts.now ?? (() => new Date()))()
    const irn = await irnFor(p)
    const ackNo = '1' + (BigInt('0x' + irn.slice(0, 15)) % 10n ** 14n).toString().padStart(14, '0')
    return { ok: true, irn, ack_no: ackNo, ack_date: now.toISOString(), signed_qr: mockSignedQr(buildQrClaims(p, irn, istStamp(now))) }
  }

  async cancelIrn(irn: string): Promise<CancelResult> {
    if (!/^[0-9a-f]{64}$/i.test(irn)) return { ok: false, error: 'invalid IRN', retryable: false }
    return { ok: true, cancel_date: (this.opts.now ?? (() => new Date()))().toISOString() }
  }
}

export class MockEway implements EwayAdapter {
  readonly name = 'mock'
  constructor(private opts: { now?: () => Date } = {}) {}
  private validUntil(): string {
    const now = (this.opts.now ?? (() => new Date()))()
    const ist = new Date(now.getTime() + 330 * 60000)
    const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 23, 59) - 330 * 60000
    return new Date(end).toISOString()
  }
  async generate(payload: Record<string, unknown>): Promise<EwayResult> {
    const h = await sha256HexOf(JSON.stringify(payload))
    const no = '1' + (BigInt('0x' + h.slice(0, 15)) % 10n ** 11n).toString().padStart(11, '0')
    return { ok: true, eway_bill_no: no, generated_at: (this.opts.now ?? (() => new Date()))().toISOString(), valid_until: this.validUntil() }
  }
  async updatePartB() { return { ok: true as const, valid_until: this.validUntil() } }
  async cancel() { return { ok: true as const } }
}

/**
 * Placeholder for the GSP the owner chooses. Credentials come only from Edge Function secrets (GSP_BASE_URL,
 * GSP_CLIENT_ID, GSP_CLIENT_SECRET, GSP_USERNAME, GSP_PASSWORD per GSTIN). Until the GSP's API contract is known it
 * refuses (non-retryable), so a request is dead-lettered to the Bug fixer instead of pretending to succeed.
 */
export class UnconfiguredGsp implements GspAdapter, EwayAdapter {
  constructor(readonly name: string) {}
  private no(): ProviderFailure { return { ok: false, error: `provider "${this.name}" is not configured yet (owner decision)`, retryable: false } }
  async generateIrn() { return this.no() }
  async cancelIrn() { return this.no() }
  async generate() { return this.no() }
  async updatePartB() { return this.no() }
  async cancel() { return this.no() }
}

export function gspFor(provider: string): GspAdapter & Partial<EwayAdapter> {
  return provider === 'mock' ? new MockGsp() : new UnconfiguredGsp(provider)
}
export function ewayFor(provider: string): EwayAdapter {
  return provider === 'mock' ? new MockEway() : new UnconfiguredGsp(provider)
}
