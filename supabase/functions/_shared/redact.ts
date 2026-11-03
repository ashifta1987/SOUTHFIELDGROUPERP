// Redaction filter for anything the help assistant sends to an outside AI model (AGENTS.md rule 10, §HELP-6).
// Never sent: salary / pay figures, KYC (Aadhaar, PAN), bank details (account numbers, IFSC, UPI), phone numbers,
// and any figure of a bill without GST. Applied to the user's text, tool results and the conversation history.
// Pure module: no Deno or Node imports (unit-tested with Vitest in src/integrations/redact.test.ts).

/** Keys whose values are never sent to the model, whatever they contain. */
const BLOCKED_KEY = /(salary|wage|pay(_|-)?(rate|basis|amount|slip)?$|^pay$|gross|net_pay|ctc|basic|allowance|deduction|advance_amount|aadhaar|aadhar|pan(_no)?$|kyc|bank|account_?(no|number|last4)|ifsc|upi|password|otp|secret|token)/i

/** Documents of these kinds are bills without GST; their figures never leave. */
function isWithoutGst(o: Record<string, unknown>): boolean {
  const cls = o['tax_class'] ?? o['taxClass']
  const type = o['doc_type'] ?? o['type'] ?? o['sub']
  return cls === 'without_gst' || cls === 'unclassified' || type === 'bill_of_supply' || o['lawful_reason'] != null
}

const PATTERNS: Array<[RegExp, string]> = [
  // Aadhaar: 12 digits, often in groups of 4 (also the masked form is left alone: XXXX XXXX 1234 has 4 digits only).
  [/\b[2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}\b/g, '[aadhaar]'],
  // PAN: AAAAA9999A
  [/\b[A-Z]{3}[ABCFGHLJPT][A-Z][0-9]{4}[A-Z]\b/g, '[pan]'],
  // IFSC: AAAA0XXXXXX
  [/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, '[ifsc]'],
  // UPI id (handle@bank — an e-mail address has a dot after the domain and is left alone)
  [/\b[\w.-]{2,}@[A-Za-z]{2,}(?![\w.])/g, '[upi]'],
  // Indian mobile numbers (+91 optional)
  [/(?:\+?91[ -]?)?\b[6-9][0-9]{4}[ -]?[0-9]{5}\b/g, '[phone]'],
  // Bank account numbers and any other long digit run (9–18 digits)
  [/\b[0-9]{9,18}\b/g, '[number]'],
  // Amounts following pay words: "salary 25,000", "pay is ₹ 18000", "wage: Rs. 500"
  [/\b(salary|salaries|wage|wages|pay|payslip|ctc|advance)\b([^.\n]{0,20}?)(₹|rs\.?|inr)?\s?[0-9][0-9,]*(\.[0-9]+)?/gi, '$1$2[amount]'],
]

/** Mask personal and pay data in free text. */
export function redactText(text: string): string {
  let out = text
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}

/**
 * Deep-clean a tool result before it reaches the model: blocked keys are removed, bills without GST are dropped from
 * lists (and replaced by a neutral marker when they are the whole result), and every string is text-redacted.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) {
    return value.filter((v) => !(v && typeof v === 'object' && !Array.isArray(v) && isWithoutGst(v as Record<string, unknown>))).map(redactValue)
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (isWithoutGst(o)) return { withheld: true }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) {
      if (BLOCKED_KEY.test(k)) continue
      out[k] = redactValue(v)
    }
    return out
  }
  return value
}

/** True when nothing that must not leave is still present (used by tests and as a last check before sending). */
export function looksClean(text: string): boolean {
  return redactText(text) === text
}
