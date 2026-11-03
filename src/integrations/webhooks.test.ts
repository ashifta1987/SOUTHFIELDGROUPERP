import { describe, expect, it } from 'vitest'
import { bytesToBase64, hmacSha256, timingSafeEqual, verifyGenericHmac, verifyShopifyHmac } from '../../supabase/functions/_shared/hmac'
import { backoffSchedule, backoffSeconds, shouldDeadLetter } from '../../supabase/functions/_shared/backoff'

const secret = 'test-webhook-secret'
const body = JSON.stringify({ id: 820982911946154500, line_items: [{ sku: 'TEST-SKU', quantity: 1, price: '118.00' }] })

async function shopifySig(raw: string, key = secret) {
  return bytesToBase64(await hmacSha256(key, raw))
}
async function hexSig(raw: string, key = secret) {
  return Array.from(await hmacSha256(key, raw), (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('Shopify webhook HMAC (base64 HMAC-SHA256 of the raw body)', () => {
  it('accepts a valid signature', async () => {
    expect(await verifyShopifyHmac(body, await shopifySig(body), secret)).toBe(true)
  })
  it('refuses a signature made with another secret', async () => {
    expect(await verifyShopifyHmac(body, await shopifySig(body, 'other-secret'), secret)).toBe(false)
  })
  it('refuses a tampered body', async () => {
    const sig = await shopifySig(body)
    expect(await verifyShopifyHmac(body.replace('118.00', '1.00'), sig, secret)).toBe(false)
  })
  it('refuses a missing header or missing secret', async () => {
    expect(await verifyShopifyHmac(body, null, secret)).toBe(false)
    expect(await verifyShopifyHmac(body, await shopifySig(body), '')).toBe(false)
  })
  it('matches a known HMAC-SHA256 vector (RFC 4231 case 2)', async () => {
    const mac = Array.from(await hmacSha256('Jefe', 'what do ya want for nothing?'), (b) => b.toString(16).padStart(2, '0')).join('')
    expect(mac).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  })
})

describe('generic HMAC (hex, optional prefix and timestamp)', () => {
  it('accepts a valid hex signature with the sha256= prefix', async () => {
    expect(await verifyGenericHmac(body, 'sha256=' + (await hexSig(body)), secret, { prefix: 'sha256=' })).toBe(true)
  })
  it('refuses a tampered body and a wrong prefix', async () => {
    const sig = 'sha256=' + (await hexSig(body))
    expect(await verifyGenericHmac(body + ' ', sig, secret, { prefix: 'sha256=' })).toBe(false)
    expect(await verifyGenericHmac(body, (await hexSig(body)), secret, { prefix: 'sha256=' })).toBe(false)
  })
  it('signs the timestamp too and refuses old deliveries (replay)', async () => {
    const now = Date.UTC(2026, 10, 3, 10, 0, 0)
    const ts = String(Math.floor(now / 1000))
    const sig = await hexSig(`${ts}.${body}`)
    expect(await verifyGenericHmac(body, sig, secret, { timestamp: ts, now })).toBe(true)
    expect(await verifyGenericHmac(body, sig, secret, { timestamp: ts, now: now + 10 * 60 * 1000 })).toBe(false)
    expect(await verifyGenericHmac(body, sig, secret, { timestamp: null, now })).toBe(false)
  })
  it('compares in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('back-off schedule (mirrors app.integration_backoff_seconds)', () => {
  it('doubles from the base and caps at the maximum', () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffSeconds(a, 60, 21600))).toEqual([60, 120, 240, 480, 960])
    expect(backoffSeconds(20, 60, 21600)).toBe(21600)
    expect(backoffSeconds(0, 60, 21600)).toBe(60)
  })
  it('lists the waits before the dead letter', () => {
    expect(backoffSchedule(5, 60, 21600)).toEqual([60, 120, 240, 480])
  })
  it('dead-letters after the last attempt or on a non-retryable error', () => {
    expect(shouldDeadLetter(4, 5, true)).toBe(false)
    expect(shouldDeadLetter(5, 5, true)).toBe(true)
    expect(shouldDeadLetter(1, 5, false)).toBe(true)
  })
})
