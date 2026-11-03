// Small provider adapters for Phase 8: bank statement feeds, GPS provider intake and voice-note transcription.
// Each has a mock used on DEV/tests; real providers are added beside them once the owner chooses (Q-P8-2, Q-P8-3, Q-P8-5).
// Credentials only from Edge Function secrets. Pure module.

export interface BankLine { date: string; description: string; ref: string | null; amount: number; balance: number | null }
export interface BankFeedAdapter {
  readonly name: string
  /** Lines since the cursor (the provider's own paging token), and the next cursor. */
  fetch(externalRef: string | null, cursor: string | null): Promise<{ ok: true; lines: BankLine[]; cursor: string | null } | { ok: false; error: string; retryable: boolean }>
}

/** Mock feed: returns nothing new (DEV never holds real statements). Tests pass their own synthetic lines. */
export class MockBankFeed implements BankFeedAdapter {
  readonly name = 'mock'
  constructor(private lines: BankLine[] = []) {}
  async fetch(_ref: string | null, cursor: string | null) {
    return { ok: true as const, lines: this.lines, cursor: cursor ?? 'mock-0' }
  }
}

export class UnconfiguredBankFeed implements BankFeedAdapter {
  constructor(readonly name: string) {}
  async fetch() { return { ok: false as const, error: `bank feed provider "${this.name}" is not configured yet (owner decision)`, retryable: false } }
}

export function bankFeedFor(provider: string): BankFeedAdapter {
  return provider === 'mock' ? new MockBankFeed() : new UnconfiguredBankFeed(provider)
}

/** Validate and normalise statement lines before they reach api.bank_feed_import. Amount: + in, − out. */
export function cleanBankLines(lines: unknown[]): BankLine[] {
  const out: BankLine[] = []
  for (const l of lines) {
    const o = l as Record<string, unknown>
    const date = String(o['date'] ?? '')
    const amount = Number(o['amount'])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount === 0) continue
    out.push({ date, description: String(o['description'] ?? '').slice(0, 300), ref: o['ref'] == null ? null : String(o['ref']).slice(0, 100),
               amount: Math.round(amount * 100) / 100, balance: o['balance'] == null || o['balance'] === '' ? null : Math.round(Number(o['balance']) * 100) / 100 })
  }
  return out
}

export interface GpsPoint { at: string; lat: number; lng: number; accuracy_m: number | null }

/** Generic GPS provider payload: {device_id, points: [{ts|at, lat, lng|lon, accuracy}]}. Invalid points are dropped. */
export function parseGpsPayload(body: unknown): { deviceRef: string | null; points: GpsPoint[] } {
  const o = (body ?? {}) as Record<string, unknown>
  const deviceRef = o['device_id'] ?? o['deviceId'] ?? o['imei']
  const raw = (o['points'] ?? (o['lat'] != null ? [o] : [])) as Array<Record<string, unknown>>
  const points: GpsPoint[] = []
  for (const p of raw) {
    const at = String(p['at'] ?? p['ts'] ?? p['timestamp'] ?? '')
    const lat = Number(p['lat'])
    const lng = Number(p['lng'] ?? p['lon'])
    if (!at || Number.isNaN(Date.parse(at)) || !(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) continue
    points.push({ at: new Date(at).toISOString(), lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracy_m: p['accuracy'] == null ? null : Number(p['accuracy']) })
  }
  return { deviceRef: deviceRef == null ? null : String(deviceRef), points }
}

export interface Transcriber { readonly name: string; transcribe(audio: Uint8Array, mime: string, languageHint: string): Promise<{ text: string; language: string }> }
export class MockTranscriber implements Transcriber {
  readonly name = 'mock'
  async transcribe(_audio: Uint8Array, _mime: string, languageHint: string) { return { text: '(voice note)', language: languageHint } }
}
