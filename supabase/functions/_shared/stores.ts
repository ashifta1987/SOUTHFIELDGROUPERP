// Online store webhook adapters (Shopify, Amazon, Flipkart, JioMart, Meesho). Each adapter: verify the signature on the
// raw body, give the event id used for dedupe, and normalise an order into the shape app.ingest_online_order takes.
// Only Shopify's scheme is publicly documented (HMAC-SHA256, base64, header X-Shopify-Hmac-Sha256). Amazon SP-API sends
// notifications through SQS/EventBridge, not signed HTTPS webhooks; Flipkart, JioMart and Meesho seller APIs do not
// publish a webhook signature scheme. Those use a generic HMAC (hex, timestamped) on our relay — needsConfirmation: true
// until the owner's store accounts confirm the real scheme (Q-P8-4). Pure module.

import { verifyGenericHmac, verifyShopifyHmac } from './hmac.ts'

export type Headers = { get(name: string): string | null }

export interface NormalisedOrder {
  external_order_id: string
  order_date: string // YYYY-MM-DD
  ship_state: string // GST state code, 2 digits
  lines: Array<{ sku: string; qty: number; price_incl_tax: number }>
}

export interface StoreAdapter {
  readonly provider: 'shopify' | 'amazon' | 'flipkart' | 'jiomart' | 'meesho'
  readonly needsConfirmation: boolean
  verify(rawBody: string, headers: Headers, secret: string, now?: number): Promise<boolean>
  eventId(headers: Headers, body: unknown): string | null
  topic(headers: Headers, body: unknown): string | null
  /** 'order' | 'order_cancel' | null (ignored) */
  kind(topic: string | null): 'order' | 'order_cancel' | null
  normaliseOrder(body: unknown): NormalisedOrder | null
}

/** ISO 3166-2:IN subdivision → GST state code (CBIC state code list). */
export const GST_STATE_CODE: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UT: '05', HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10', SK: '11', AR: '12', NL: '13', MN: '14',
  MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OR: '21', OD: '21', CT: '22', CG: '22', MP: '23', GJ: '24', DN: '26', DD: '26', MH: '27',
  KA: '29', GA: '30', LD: '31', KL: '32', TN: '33', PY: '34', AN: '35', TG: '36', TS: '36', AP: '37', LA: '38',
}

export function stateCodeOf(v: string | null | undefined): string | null {
  if (!v) return null
  const s = v.trim().toUpperCase().replace(/^IN-/, '')
  if (/^[0-9]{2}$/.test(s)) return s
  return GST_STATE_CODE[s] ?? null
}

type Json = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? NaN))
const str = (v: unknown) => (v == null ? '' : String(v))

export const shopify: StoreAdapter = {
  provider: 'shopify',
  needsConfirmation: false,
  verify: (raw, h, secret) => verifyShopifyHmac(raw, h.get('x-shopify-hmac-sha256'), secret),
  eventId: (h) => h.get('x-shopify-event-id') ?? h.get('x-shopify-webhook-id'),
  topic: (h) => h.get('x-shopify-topic'),
  kind: (t) => (t === 'orders/create' || t === 'orders/paid' ? 'order' : t === 'orders/cancelled' ? 'order_cancel' : null),
  normaliseOrder(body) {
    const o = body as Json
    const ship = (o['shipping_address'] ?? o['billing_address'] ?? {}) as Json
    const state = stateCodeOf(str(ship['province_code']))
    const items = (o['line_items'] ?? []) as Json[]
    if (!o['id'] || !state || items.length === 0) return null
    const taxesIncluded = Boolean(o['taxes_included'])
    const lines = items.map((li) => {
      const qty = num(li['quantity'])
      const price = num(li['price'])
      const tax = ((li['tax_lines'] ?? []) as Json[]).reduce((s, t) => s + num(t['price']), 0)
      return { sku: str(li['sku']), qty, price_incl_tax: Math.round((taxesIncluded ? price : price + tax / qty) * 100) / 100 }
    })
    if (lines.some((l) => !l.sku || !(l.qty > 0) || !(l.price_incl_tax >= 0))) return null
    return { external_order_id: str(o['id']), order_date: str(o['created_at']).slice(0, 10), ship_state: state, lines }
  },
}

/** Generic adapter: X-Signature = hex HMAC-SHA256 of `${X-Timestamp}.${body}`; event id X-Event-Id or body.event_id. */
function generic(provider: StoreAdapter['provider']): StoreAdapter {
  return {
    provider,
    needsConfirmation: true,
    verify: (raw, h, secret, now) =>
      verifyGenericHmac(raw, h.get('x-signature'), secret, { prefix: h.get('x-signature')?.startsWith('sha256=') ? 'sha256=' : undefined, timestamp: h.get('x-timestamp'), now }),
    eventId: (h, b) => h.get('x-event-id') ?? (str((b as Json)?.['event_id']) || null),
    topic: (h, b) => h.get('x-event-type') ?? (str((b as Json)?.['event_type']) || null),
    kind: (t) => (t && /cancel/i.test(t) ? 'order_cancel' : t && /order/i.test(t) ? 'order' : null),
    normaliseOrder(body) {
      const o = ((body as Json)?.['order'] ?? body) as Json
      const state = stateCodeOf(str(o['ship_state'] ?? o['state_code'] ?? o['state']))
      const items = (o['lines'] ?? o['items'] ?? []) as Json[]
      if (!o['order_id'] && !o['external_order_id']) return null
      if (!state || items.length === 0) return null
      const lines = items.map((li) => ({ sku: str(li['sku']), qty: num(li['qty'] ?? li['quantity']), price_incl_tax: num(li['price_incl_tax'] ?? li['selling_price']) }))
      if (lines.some((l) => !l.sku || !(l.qty > 0) || !(l.price_incl_tax >= 0))) return null
      return { external_order_id: str(o['external_order_id'] ?? o['order_id']), order_date: str(o['order_date'] ?? o['created_at']).slice(0, 10), ship_state: state, lines }
    },
  }
}

export const STORE_ADAPTERS: Record<string, StoreAdapter> = {
  shopify,
  amazon: generic('amazon'),
  flipkart: generic('flipkart'),
  jiomart: generic('jiomart'),
  meesho: generic('meesho'),
}
