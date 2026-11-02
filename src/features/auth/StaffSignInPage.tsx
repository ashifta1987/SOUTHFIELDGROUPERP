import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { Button, ComingInPhase, Field, Icon, OfflineBadge } from '@/ui'
import { LanguageSwitch } from './LanguageSwitch'
import { OtpBoxes } from './OtpBoxes'
import { landingFor, passwordSchema, phoneSchema, signInWithPassword, toE164 } from './authActions'

/** Staff phone sign-in (`StaffSignIn`): WhatsApp number + password. New-phone WhatsApp code arrives with WhatsApp in Phase 3. */
export function StaffSignInPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { session, profile, loading } = useAuth()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [errs, setErrs] = useState<{ phone?: string; password?: string; form?: string }>({})

  if (!loading && session) return <Navigate to={landingFor(profile?.role)} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const p = phoneSchema.safeParse(phone)
    const pw = passwordSchema.safeParse(password)
    const next = { phone: p.success ? undefined : p.error.issues[0]?.message, password: pw.success ? undefined : pw.error.issues[0]?.message }
    setErrs(next)
    if (!p.success || !pw.success) return
    setBusy(true)
    const res = await signInWithPassword({ phone: toE164(p.data) }, password)
    setBusy(false)
    if (!res.ok) return setErrs({ form: res.errorKey })
    navigate('/staff/home', { replace: true })
  }

  return (
    <main className="sf-staff-signin">
      <div className="sf-staff-signin__top">
        <img src="/brand/southfield-group-logo.png" alt={t('brand.group')} width={172} height={40} />
        <LanguageSwitch />
      </div>
      <div>
        <h1>{t('staffSignIn.title')}</h1>
        <p style={{ margin: '6px 0 0', color: 'var(--sf-text-2)' }}>{t('staffSignIn.sub')}</p>
      </div>
      <OfflineBadge />
      <form className="sf-phone-card" onSubmit={onSubmit} noValidate style={{ padding: 18 }}>
        <Field
          label={t('auth.whatsappNumber')}
          prefix="+91"
          inputMode="numeric"
          autoComplete="tel-national"
          className="mono"
          placeholder={t('auth.phonePlaceholder')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errs.phone ? t(errs.phone) : undefined}
        />
        <Field
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errs.password ? t(errs.password) : undefined}
        />
        {errs.form ? (
          <div className="sf-alert" data-tone="danger" role="alert">
            <Icon name="alert" size={16} />
            {t(errs.form)}
          </div>
        ) : null}
        <Button type="submit" variant="primary" size="hero" busy={busy}>
          {t('auth.signIn')}
        </Button>
        <div style={{ textAlign: 'center' }}>
          <ComingInPhase phase={3}>{t('staffSignIn.forgotPhase')}</ComingInPhase>
        </div>
      </form>
      <div className="sf-otp" style={{ background: 'transparent' }}>
        <div className="sf-otp__head">
          <strong className="muted">{t('staffSignIn.newPhone')}</strong>
        </div>
        <OtpBoxes value="" onChange={() => undefined} disabled label={t('auth.codeLabel')} />
        <ComingInPhase phase={3} />
      </div>
      <p className="sf-staff-signin__foot">{t('staffSignIn.foot')}</p>
    </main>
  )
}
