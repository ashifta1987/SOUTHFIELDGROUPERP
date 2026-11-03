// Webhook signature helpers (pure: Web Crypto only, so the same file runs in Deno Edge Functions and in Vitest).
// Every inbound handler verifies the signature on the RAW body before parsing or storing anything.

const enc = new TextEncoder()

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacSha256(secret: string, data: string | Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const body = typeof data === 'string' ? enc.encode(data) : data
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, body as BufferSource))
}

export async function sha256Hex(data: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(data))))
}

/** Constant-time comparison of two strings (no early exit on the first difference). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

/**
 * Shopify: header `X-Shopify-Hmac-Sha256` = base64(HMAC-SHA256(raw body, app client secret)).
 * Documented at shopify.dev (webhooks → verify). The body must be the exact raw bytes received.
 */
export async function verifyShopifyHmac(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false
  const expected = bytesToBase64(await hmacSha256(secret, rawBody))
  return timingSafeEqual(expected, header.trim())
}

/**
 * Generic HMAC-SHA256 check for providers whose scheme is not yet confirmed (hex digest, optional `sha256=` prefix,
 * optional timestamp signed as `${timestamp}.${body}` to stop replays). Used by the Meta-style and generic adapters.
 */
export async function verifyGenericHmac(
  rawBody: string,
  header: string | null,
  secret: string,
  opts: { prefix?: string; timestamp?: string | null; toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  if (!header || !secret) return false
  let sig = header.trim()
  if (opts.prefix) {
    if (!sig.startsWith(opts.prefix)) return false
    sig = sig.slice(opts.prefix.length)
  }
  let signed = rawBody
  if (opts.timestamp !== undefined) {
    if (!opts.timestamp) return false
    const ts = Number(opts.timestamp)
    const now = Math.floor((opts.now ?? Date.now()) / 1000)
    if (!Number.isFinite(ts) || Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false
    signed = `${opts.timestamp}.${rawBody}`
  }
  const expected = bytesToHex(await hmacSha256(secret, signed))
  return timingSafeEqual(expected, sig.toLowerCase())
}
