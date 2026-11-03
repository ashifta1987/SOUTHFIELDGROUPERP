// Edge Function: help-agent (§HELP-4, Phase 8 provider adapter)
// The in-app help assistant. Runs with the caller's own JWT only (userClient → RLS and rights apply); it never holds the
// service-role key and never changes data except filing a problem report or a handoff, which the user may do anyway.
// Tools are an allow-list mapped to help_* / search_help / explain_error / create_problem_report RPCs. Every text and
// tool result passes the redaction filter (_shared/redact.ts: salary, KYC, bank details, phone numbers and figures of
// bills without GST removed) before it can reach the model. Voice input: {audio_base64, mime} is transcribed first.
// Model: HELP_AI_PROVIDER (owner decision Q-P8-5; India-region endpoint preferred); 'mock' only when HELP_ALLOW_MOCK=true.
// Limits: 20-second timeout; on failure the problem is filed and the user gets its reference.
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, HELP_AI_PROVIDER, HELP_AI_API_KEY (when a real model is chosen), HELP_ALLOW_MOCK.
import { cors, json, rpcOf, userClient } from '../_shared/edge.ts'
import { MockModel, UnconfiguredModel, WEB_TOOLS, runHelpTurn, type ChatMessage, type ModelAdapter } from '../_shared/llm.ts'
import { redactValue } from '../_shared/redact.ts'
import { MockTranscriber } from '../_shared/adapters.ts'
import { withTimeout } from '../_shared/worker.ts'

function modelFor(): ModelAdapter {
  const p = Deno.env.get('HELP_AI_PROVIDER') ?? 'mock'
  if (p === 'mock' && Deno.env.get('HELP_ALLOW_MOCK') === 'true') return new MockModel()
  return new UnconfiguredModel(p)
}

interface Body { message?: string; history?: ChatMessage[]; screen?: string; lang?: string; audio_base64?: string; mime?: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const db = userClient(req)
  const { data: who } = await db.auth.getUser()
  if (!who.user) return json({ error: 'sign in' }, 401)
  const rpc = rpcOf(db)
  const b = (await req.json().catch(() => ({}))) as Body
  let text = (b.message ?? '').slice(0, 2000)
  if (!text && b.audio_base64) {
    const audio = Uint8Array.from(atob(b.audio_base64), (c) => c.charCodeAt(0))
    text = (await new MockTranscriber().transcribe(audio, b.mime ?? 'audio/ogg', b.lang ?? 'en')).text
  }
  if (!text.trim()) return json({ error: 'empty message' }, 400)
  const lang = b.lang ?? 'en'
  const callTool = (tool: string, a: Record<string, unknown>) => {
    switch (tool) {
      case 'search_help': return rpc('search_help', { p_query: String(a['query'] ?? ''), p_screen: b.screen ?? null, p_language: lang })
      case 'explain_error': return rpc('explain_error', { p_ref: String(a['ref'] ?? '') })
      case 'get_document_status': return rpc('help_get_document_status', { p_doc_no: String(a['doc_no'] ?? '') })
      case 'check_my_rights': return rpc('help_check_my_rights', { p_company_id: null, p_right: a['right'] ?? null })
      case 'get_stock': return rpc('help_get_stock', { p_query: String(a['query'] ?? ''), p_company_id: null })
      case 'my_requests': return rpc('help_my_requests', {})
      case 'create_problem_report':
      case 'handoff':
        return rpc('create_problem_report', { p_client_request_id: crypto.randomUUID(), p: {
          what_happened: String(a['what_happened'] ?? text).slice(0, 2000), screen: tool === 'handoff' ? `handoff:${b.screen ?? ''}` : (b.screen ?? 'help'),
          error_ref: (text.match(/ERR-[A-Z0-9]{5}/i)?.[0] ?? '').toUpperCase() } })
      default: throw new Error('tool not allowed')
    }
  }
  try {
    const res = await withTimeout(runHelpTurn({ model: modelFor(), tools: WEB_TOOLS, history: (b.history ?? []).slice(-10), userText: text, redact: redactValue, callTool }), 20000)
    return json(res)
  } catch {
    const filed = (await rpc('create_problem_report', { p_client_request_id: crypto.randomUUID(), p: { what_happened: text.slice(0, 2000), screen: b.screen ?? 'help' } })
      .catch(() => null)) as { code?: string } | null
    return json({ text: `I can't answer right now. I've saved your problem as ${filed?.code ?? 'a report'}.`, toolCalls: [], outcome: 'filed' })
  }
})
