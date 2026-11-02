import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, makeErrorRef } from '@/shared/supabase'

/**
 * Calling a changing RPC (§3): every call carries a fresh client_request_id so a retry never creates a duplicate,
 * the server decides everything, and any refusal comes back with a rule code (Postgres HINT) and an error reference.
 */
export class RpcError extends Error {
  readonly ref: string
  readonly code?: string
  /** Stable rule code from the database, e.g. "rights.missing", "grant.never_grantable" */
  readonly rule?: string
  constructor(message: string, ref: string, code?: string, rule?: string) {
    super(message)
    this.ref = ref
    this.code = code
    this.rule = rule
  }
}

export function newRequestId(): string {
  return crypto.randomUUID()
}

async function logError(route: string, rpc: string, rule: string | undefined, message: string): Promise<string> {
  try {
    const { data } = await api().rpc('log_error', {
      p_route: route,
      p_rpc: rpc,
      p_rule_code: rule ?? '',
      p_message: message.slice(0, 500),
      p_payload_summary: {},
    })
    if (typeof data === 'string') return data
  } catch {
    /* fall through to a local reference */
  }
  return makeErrorRef()
}

/** Call an `api` RPC. Mutating RPCs get `p_client_request_id` added automatically. */
export async function callApi<T = unknown>(fn: string, args: Record<string, unknown> = {}, opts: { idempotent?: boolean } = { idempotent: true }): Promise<T> {
  const body = opts.idempotent === false ? args : { p_client_request_id: newRequestId(), ...args }
  const { data, error } = await api().rpc(fn, body)
  if (error) {
    const rule = error.hint || undefined
    const ref = await logError(window.location.pathname, fn, rule, error.message)
    throw new RpcError(error.message, ref, error.code, rule)
  }
  return data as T
}

/** TanStack mutation around callApi that refreshes the given query keys afterwards. */
export function useApiMutation<TArgs extends Record<string, unknown>, TResult = unknown>(fn: string, invalidate: string[][] = []) {
  const qc = useQueryClient()
  return useMutation<TResult, RpcError, TArgs>({
    mutationFn: (args) => callApi<TResult>(fn, args),
    onSuccess: async () => {
      await Promise.all(invalidate.map((key) => qc.invalidateQueries({ queryKey: key })))
      await qc.invalidateQueries({ queryKey: ['api', 'me'] })
    },
  })
}

