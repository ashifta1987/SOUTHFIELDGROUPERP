import { createClient, type PostgrestError } from '@supabase/supabase-js'

/**
 * Browser Supabase client. Only the project URL and the publishable (anon) key ever reach the browser
 * (AGENTS.md rule 11). The secret / service-role key lives in Edge Function and CI secrets only.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const supabaseConfigured = Boolean(url && key)

export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

/**
 * The ERP exposes only the `api` schema through the Data API (views + RPCs).
 * Phase 0 has no `api` schema yet, so these calls report `notReady` until the phase that builds them.
 */
export const api = () => supabase.schema('api')

/** Postgres / PostgREST codes meaning "this object is not built yet" rather than a real failure. */
const NOT_READY_CODES = new Set(['PGRST106', 'PGRST202', 'PGRST205', '42P01', '42883', '3F000'])

export function isNotReady(err: { code?: string } | Pick<PostgrestError, 'code'> | null | undefined): boolean {
  return Boolean(err && err.code && NOT_READY_CODES.has(err.code))
}

export class ApiError extends Error {
  readonly ref: string
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
    this.ref = makeErrorRef()
  }
}

/** Short reference ID shown with every error (§UX-6 `ErrorRef`), e.g. ERR-7F3K2. */
export function makeErrorRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  return 'ERR-' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/** Result of an `api` read: rows, or a flag saying the backing object arrives in a later phase. */
export type ApiResult<T> = { status: 'ready'; data: T } | { status: 'not-ready' }
