import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { supabaseConfigured } from '@/shared/supabase'
import { Button, ComingInPhase, Field, Icon, Tabs } from '@/ui'
import { LanguageSwitch } from './LanguageSwitch'
import { OtpBoxes } from './OtpBoxes'
import { emailSchema, landingFor, passwordSchema, phoneSchema, signInWithPassword, toE164, verifyTotp } from './authActions'

type Method = 'phone' | 'email'

/**
 * Sign in (`Login`). Staff: WhatsApp number + password. Admin, finance and CA: email + password + TOTP MFA.
 * No public sign-up: Admin creates every account.
 */
export function SignInPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { session, profile, needsMfa, refreshMfa, loading } = useAuth()
  const [method, setMethod] = useState<Method>('phone')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [fieldErr, setFieldErr] = useState<{ id?: string; password?: string }>({})
  const [formErr, setFormErr] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from
  if (!loading && session && !needsMfa) return <Navigate to={from ?? landingFor(profile?.role)} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormErr(null)
    if (session && needsMfa) return onVerify()
    const idCheck = method === 'phone' ? phoneSchema.safeParse(phone) : emailSchema.safeParse(email)
    const pwCheck = passwordSchema.safeParse(password)
    const next = { id: idCheck.success ? undefined : idCheck.error.issues[0]?.message, password: pwCheck.success ? undefined : pwCheck.error.issues[0]?.message }
    setFieldErr(next)
    if (!idCheck.success || !pwCheck.success) return
    setBusy(true)
    const res = await signInWithPassword(method === 'phone' ? { phone: toE164(idCheck.data) } : { email: idCheck.data }, password)
    setBusy(false)
    if (!res.ok) return setFormErr(res.errorKey)
    // The guard above redirects once the session (and its MFA state) lands in AuthProvider.
    if (res.needsMfa) await refreshMfa()
  }

  async function onVerify() {
    if (code.length !== 6) return setFormErr('auth.errors.code')
    setBusy(true)
    const res = await verifyTotp(code)
    setBusy(false)
    if (!res.ok) return setFormErr(res.errorKey ?? 'auth.errors.code')
    await refreshMfa()
    navigate(from ?? landingFor(profile?.role), { replace: true })
  }

  const mfaStep = Boolean(session && needsMfa)

  return (
    <div className="sf-signin">
      <aside className="sf-signin__brand">
        <div className="sf-signin__logo">
          <img src="/brand/southfield-group-logo.png" alt={t('brand.group')} width={316} height={80} />
        </div>
        <div className="sf-signin__companies">
          <p style={{ margin: 0 }}>{t('auth.oneSignIn')}</p>
          <div className="sf-signin__company">
            <img src="/brand/southfield-plastics-logo.svg" alt={t('brand.plastics')} width={154} height={40} />
            <span>{t('auth.plasticsLine')}</span>
          </div>
          <div className="sf-signin__company">
            <img src="/brand/southfield-biochem-logo.png" alt={t('brand.biochem')} width={148} height={40} />
            <span>{t('auth.biochemLine')}</span>
          </div>
        </div>
      </aside>

      <main className="sf-signin__form">
        <form className="sf-signin__inner" onSubmit={onSubmit} noValidate>
          <div className="sf-signin__title">
            <div>
              <h1>{t('auth.signIn')}</h1>
              <p>{t('auth.ownLogin')}</p>
            </div>
            <LanguageSwitch />
          </div>

          {!supabaseConfigured ? (
            <div className="sf-alert" data-tone="danger" role="alert">
              <Icon name="alert" size={16} />
              {t('auth.errors.notConfigured')}
            </div>
          ) : null}

          {!mfaStep ? (
            <>
              <Tabs
                variant="segmented"
                label={t('auth.method')}
                value={method}
                onChange={(m) => {
                  setMethod(m)
                  setFieldErr({})
                  setFormErr(null)
                }}
                tabs={[
                  { key: 'phone', label: t('auth.tabPhone') },
                  { key: 'email', label: t('auth.tabEmail') },
                ]}
              />
              {method === 'phone' ? (
                <Field
                  label={t('auth.whatsappNumber')}
                  prefix="+91"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  className="mono"
                  placeholder={t('auth.phonePlaceholder')}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  error={fieldErr.id ? t(fieldErr.id) : undefined}
                />
              ) : (
                <Field
                  label={t('auth.email')}
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  error={fieldErr.id ? t(fieldErr.id) : undefined}
                />
              )}
              <Field
                label={t('auth.password')}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={fieldErr.password ? t(fieldErr.password) : undefined}
              />
            </>
          ) : (
            <div className="sf-alert" data-tone="info" role="status">
              <Icon name="lock" size={16} />
              {t('auth.mfaPrompt')}
            </div>
          )}

          {formErr ? (
            <div className="sf-alert" data-tone="danger" role="alert">
              <Icon name="alert" size={16} />
              {t(formErr)}
            </div>
          ) : null}

          <Button type="submit" variant="primary" size="touch" busy={busy}>
            {mfaStep ? t('auth.verify') : t('auth.signIn')}
          </Button>

          <div className="sf-otp" style={mfaStep ? { borderStyle: 'solid', borderColor: 'var(--sf-primary)' } : undefined}>
            <div className="sf-otp__head">
              <strong>{mfaStep ? t('auth.mfaTitle') : t('auth.otpTitle')}</strong>
            </div>
            <OtpBoxes value={code} onChange={setCode} disabled={!mfaStep} label={t('auth.codeLabel')} />
            <span className="k">{t('auth.otpHelp')}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <ComingInPhase phase={3}>{t('auth.forgotPhase')}</ComingInPhase>
            <span className="muted">{t('auth.lockNote')}</span>
            <Link to="/staff/sign-in" style={{ fontWeight: 600 }}>
              {t('auth.staffPhoneLink')}
            </Link>
          </div>
        </form>
      </main>
    </div>
  )
}
