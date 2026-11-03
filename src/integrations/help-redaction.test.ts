import { describe, expect, it } from 'vitest'
import { looksClean, redactText, redactValue } from '../../supabase/functions/_shared/redact'
import { MockModel, WHATSAPP_TOOLS, WEB_TOOLS, runHelpTurn } from '../../supabase/functions/_shared/llm'

describe('help redaction filter (nothing private reaches the model)', () => {
  it('masks Aadhaar, PAN, IFSC, UPI, phone and bank account numbers in text', () => {
    const t = redactText('Aadhaar 2345 6789 0123, PAN ABCPE1234F, IFSC SBIN0001234, upi test.name@okaxis, call +91 98765 43210, a/c 001234567890123')
    expect(t).not.toMatch(/2345 6789 0123|ABCPE1234F|SBIN0001234|test\.name@okaxis|98765 43210|001234567890123/)
    expect(t).toContain('[aadhaar]')
    expect(t).toContain('[pan]')
    expect(t).toContain('[ifsc]')
    expect(t).toContain('[phone]')
    expect(looksClean(t)).toBe(true)
  })
  it('masks salary and pay amounts', () => {
    expect(redactText('my salary is ₹ 25,000 this month')).toBe('my salary is [amount] this month')
    expect(redactText('advance of Rs. 5000 asked')).toContain('[amount]')
  })
  it('keeps ordinary how-to text and error references', () => {
    const t = 'How do I post invoice SB/26-27/0001? I got ERR-7F3K2 on 03-11-2026.'
    expect(redactText(t)).toBe(t)
  })
  it('drops salary, KYC and bank fields from tool results', () => {
    const out = redactValue({ name: 'Test Worker', monthly_salary: 30000, pay_basis: 'monthly', aadhaar_last4: '1234', bank_account_no: '1234567890', ifsc: 'SBIN0001234', status: 'active' })
    expect(out).toEqual({ name: 'Test Worker', status: 'active' })
  })
  it('drops bills without GST from lists and withholds a single one', () => {
    const docs = [
      { doc_no: 'T1', type: 'sales_invoice', amount: 100, tax_class: 'taxable' },
      { doc_no: 'T2', type: 'bill_of_supply', amount: 50 },
      { doc_no: 'T3', tax_class: 'without_gst', amount: 70 },
    ]
    expect(redactValue({ found: true, documents: docs })).toEqual({ found: true, documents: [{ doc_no: 'T1', type: 'sales_invoice', amount: 100, tax_class: 'taxable' }] })
    expect(redactValue({ doc_no: 'T3', tax_class: 'without_gst', amount: 70 })).toEqual({ withheld: true })
  })
})

describe('help assistant turn with the mock model', () => {
  it('sends only redacted text and tool results to the model', async () => {
    const model = new MockModel()
    const res = await runHelpTurn({
      model, tools: WEB_TOOLS, history: [], redact: redactValue,
      userText: 'stock of soap? my phone is 9876543210',
      callTool: async () => [{ product: 'Test Soap', free: 10, monthly_salary: 99999, bank_account_no: '123456789012' }],
    })
    expect(res.toolCalls).toEqual([{ tool: 'get_stock', ok: true }])
    const sent = JSON.stringify(model.seen)
    expect(sent).not.toMatch(/9876543210|99999|123456789012/)
    expect(sent).toContain('Test Soap')
  })
  it('routes an error reference to explain_error and a broken screen to a problem report', async () => {
    const calls: string[] = []
    const run = (text: string) => runHelpTurn({ model: new MockModel(), tools: WEB_TOOLS, history: [], userText: text, redact: redactValue,
      callTool: async (tool) => { calls.push(tool); return { code: 'HR-TEST' } } })
    await run('what does ERR-ab12c mean')
    expect((await run('the print button is not working')).outcome).toBe('filed')
    expect(calls).toEqual(['explain_error', 'create_problem_report'])
  })
  it('has no data tools on WhatsApp and declines them', async () => {
    expect(WHATSAPP_TOOLS.map((t) => t.name).sort()).toEqual(['create_problem_report', 'explain_error', 'handoff', 'search_help', 'ticket_status'])
    let called = false
    const res = await runHelpTurn({ model: new MockModel(), tools: WHATSAPP_TOOLS, history: [], userText: 'how many soaps in stock', redact: redactValue,
      callTool: async () => { called = true; return [] } })
    expect(called).toBe(false)
    expect(res.toolCalls).toEqual([])
  })
})
