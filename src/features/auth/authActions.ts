import { z } from 'zod'
import { api, supabase } from '@/shared/supabase'

/** Shared validation for sign-in forms (reusable by Edge Functions later). */
export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/\D/g, ''))
  .refine((s) => /^[6-9]\d{9}$/.test(s), 'auth.errors.phone')

export const emailSchema = z.string().trim().email('auth.errors.email')
export const passwordSchema = z.string().min(1, 'auth.errors.password')

export type SignInResult = { ok: true; needsMfa: boolean } | { ok: false; errorKey: string }

/** Indian mobile numbers only; stored in E.164 (+91…). */
export function toE164(tenDigits: string): string {
  return `+91${tenDigits}`
}

function mapAuthError(message: string | undefined, code: string | undefined): string {
  const m = (message ?? '').toLowerCase()
  if (code === 'invalid_credentials' || m.includes('invalid login')) return 'auth.errors.invalid'
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || m.includes('rate limit')) return 'auth.errors.locked'
  if (code === 'phone_provider_disabled' || m.includes('phone') && m.includes('disabled')) return 'auth.errors.phoneDisabled'
  if (code === 'user_banned') return 'auth.errors.banned'
  if (m.includes('fetch')) return 'auth.errors.network'
  return 'auth.errors.generic'
}

export async function signInWithPassword(input: { email: string } | { phone: string }, password: string): Promise<SignInResult> {
  const { error } = await supabase.auth.signInWithPassword({ ...input, password })
  if (error) {
    // Failed sign-ins go to the user log (identifier stored masked, throttled on the server).
    void api().rpc('log_sign_in_failure', { p_identifier: 'email' in input ? input.email : input.phone }).then(() => undefined)
    return { ok: false, errorKey: mapAuthError(error.message, error.code) }
  }
  await api().rpc('log_user_event', { p_event: 'sign_in', p_detail: { method: 'email' in input ? 'email' : 'phone' } })
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  return { ok: true, needsMfa: Boolean(data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2') }
}

/** Verify a TOTP code against the user's verified factor (Admin, finance and CA accounts). */
export async function verifyTotp(code: string): Promise<{ ok: boolean; errorKey?: string }> {
  const { data: factors, error } = await supabase.auth.mfa.listFactors()
  if (error) return { ok: false, errorKey: 'auth.errors.generic' }
  const factor = factors.totp.find((f) => f.status === 'verified')
  if (!factor) return { ok: false, errorKey: 'auth.errors.noFactor' }
  const res = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code })
  if (res.error) return { ok: false, errorKey: 'auth.errors.code' }
  return { ok: true }
}

/** Where a signed-in user lands: staff and field roles go to their phone app, investors to their portal, everyone else to Home. */
export function landingFor(role: string | undefined): string {
  const phoneRoles = new Set(['staff', 'factory_staff', 'machine_operator', 'driver', 'salesman', 'shop_staff'])
  if (role === 'investor') return '/investor/home'
  return role && phoneRoles.has(role) ? '/staff/home' : '/'
}

