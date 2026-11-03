// Shared WhatsApp provider adapter (§WA-1). Business code talks only to MessagingProvider; switching from Meta Cloud
// API to a BSP (Gupshup, Interakt, AiSensy, Wati, Twilio) means adding another implementation, nothing else.
export interface SendResult { ok: boolean; messageId?: string; error?: string }
export interface InboundMessage { waMessageId: string; from: string; kind: string; text?: string; timestamp: string }
export interface StatusEvent { waMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; error?: string }

export interface MessagingProvider {
  sendTemplate(to: string, template: string, language: string, params: string[], document?: { url: string; filename: string }): Promise<SendResult>
  sendText(to: string, text: string): Promise<SendResult>
  verifyWebhook(rawBody: string, signatureHeader: string | null): Promise<boolean>
  parseWebhook(body: unknown): { inbound: InboundMessage[]; statuses: StatusEvent[] }
}

/** Meta WhatsApp Cloud API (default). Token and app secret come from Edge Function secrets only. */
export class MetaCloudProvider implements MessagingProvider {
  constructor(private phoneNumberId: string, private token: string, private appSecret: string) {}

  private async post(payload: unknown): Promise<SendResult> {
    const res = await fetch(`https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` }
    return { ok: true, messageId: body?.messages?.[0]?.id }
  }

  sendTemplate(to: string, template: string, language: string, params: string[], document?: { url: string; filename: string }) {
    const components: unknown[] = [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }]
    if (document) components.unshift({ type: 'header', parameters: [{ type: 'document', document: { link: document.url, filename: document.filename } }] })
    return this.post({ messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'template', template: { name: template, language: { code: language }, components } })
  }

  sendText(to: string, text: string) {
    return this.post({ messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'text', text: { body: text } })
  }

  async verifyWebhook(rawBody: string, signatureHeader: string | null) {
    if (!signatureHeader?.startsWith('sha256=')) return false
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
    const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
    return hex === signatureHeader.slice(7)
  }

  parseWebhook(body: any) {
    const inbound: InboundMessage[] = []
    const statuses: StatusEvent[] = []
    for (const entry of body?.entry ?? []) for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {}
      for (const m of v.messages ?? []) inbound.push({ waMessageId: m.id, from: '+' + m.from, kind: m.type, text: m.text?.body, timestamp: m.timestamp })
      for (const s of v.statuses ?? []) statuses.push({ waMessageId: s.id, status: s.status, error: s.errors?.[0]?.title })
    }
    return { inbound, statuses }
  }
}

/** Mock provider for development and tests: never calls Meta. */
export class MockProvider implements MessagingProvider {
  async sendTemplate() { return { ok: true, messageId: 'mock-' + crypto.randomUUID() } }
  async sendText() { return { ok: true, messageId: 'mock-' + crypto.randomUUID() } }
  async verifyWebhook() { return true }
  parseWebhook() { return { inbound: [], statuses: [] } }
}

