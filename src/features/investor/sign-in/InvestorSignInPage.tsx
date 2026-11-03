import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { emailSchema, passwordSchema, phoneSchema, signInWithPassword, toE164, verifyTotp } from '@/features/auth/authActions'
import { OtpBoxes } from '@/features/auth/OtpBoxes'
import { Button, Field, Icon, OfflineBadge } from '@/ui'

/**
 * Investor portal sign-in (`InvestorSignIn`): separate from the ERP and the staff app. WhatsApp number or email plus the
 * investor password. The WhatsApp code on every sign-in needs the WhatsApp sender (not yet set up); an account with an
 * authenticator app is asked for its code here. After sign-in the router sends investors to /investor/home and
 * everyone else to their own home.
 */
export function InvestorSignInPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { session, loading, needsMfa, refreshMfa } = useAuth()
  const [who, setWho] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [errs, setErrs] = useState<{ who?: string; password?: string; form?: string }>({})

  if (!loading && session && !needsMfa) return <Navigate to="/investor/home" replace />
  const mfaStep = Boolean(session && needsMfa)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (mfaStep) {
      setBusy(true)
      const res = await verifyTotp(code)
      setBusy(false)
      if (!res.ok) return setErrs({ form: res.errorKey })
      await refreshMfa()
      navigate('/investor/home', { replace: true })
      return
    }
    const isEmail = who.includes('@')
    const id = isEmail ? emailSchema.safeParse(who) : phoneSchema.safeParse(who)
    const pw = passwordSchema.safeParse(password)
    setErrs({ who: id.success ? undefined : 'investorSignIn.whoError', password: pw.success ? undefined : pw.error.issues[0]?.message })
    if (!id.success || !pw.success) return
    setBusy(true)
    const res = await signInWithPassword(isEmail ? { email: id.data } : { phone: toE164(id.data) }, password)
    setBusy(false)
    if (!res.ok) return setErrs({ form: res.errorKey })
    if (res.needsMfa) {
      await refreshMfa()
      return
    }
    navigate('/investor/home', { replace: true })
  }

  return (
    <main style={{ minHeight: '100vh', maxWidth: 480, margin: '0 auto', display: 'flex', flexDirection: 'column', background: 'var(--sf-navy)', fontSize: 'var(--sf-fs-phone)' }}>
      <div style={{ padding: '36px 24px 22px', display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--sf-surface)' }}>
        <span style={{ alignSelf: 'flex-start', padding: '10px 14px', borderRadius: 10, background: 'var(--sf-surface)' }}>
          <img src="/brand/southfield-group-logo.png" alt={t('brand.group')} height={34} style={{ height: 34, width: 'auto', display: 'block' }} />
        </span>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700 }}>{t('investorSignIn.title')}</h1>
          <p style={{ margin: '6px 0 0', fontSize: 14.5, color: 'var(--sf-app-head-sub)' }}>{t('investorSignIn.sub')}</p>
        </div>
      </div>
      <div style={{ flex: '1 1 0%', background: 'var(--sf-paper)', borderRadius: '22px 22px 0 0', padding: '22px 20px', display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--sf-text)' }}>
        <OfflineBadge />
        <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {mfaStep ? (
            <div className="sf-otp">
              <div className="sf-otp__head">
                <strong>{t('investorSignIn.appCode')}</strong>
              </div>
              <OtpBoxes value={code} onChange={setCode} label={t('auth.codeLabel')} />
            </div>
          ) : (
            <>
              <Field
                label={t('investorSignIn.who')}
                autoComplete="username"
                placeholder={t('investorSignIn.whoPlaceholder')}
                value={who}
                onChange={(e) => setWho(e.target.value)}
                error={errs.who ? t(errs.who) : undefined}
              />
              <Field
                label={t('investorSignIn.password')}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={errs.password ? t(errs.password) : undefined}
              />
            </>
          )}
          {errs.form ? (
            <div className="sf-alert" data-tone="danger" role="alert">
              <Icon name="alert" size={16} />
              {t(errs.form)}
            </div>
          ) : null}
          <Button type="submit" variant="primary" size="hero" busy={busy} disabled={mfaStep && code.length !== 6}>
            {mfaStep ? t('investorSignIn.verify') : t('auth.signIn')}
          </Button>
        </form>
        {!mfaStep ? (
          <section aria-labelledby="inv-code" className="sf-otp" style={{ background: 'var(--sf-surface)', border: '1px dashed var(--sf-border-input)', borderRadius: 14 }}>
            <div className="sf-otp__head" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong id="inv-code" style={{ color: 'var(--sf-text-2)' }}>
                {t('investorSignIn.codeTitle')}
              </strong>
              <span className="muted">{t('investorSignIn.codeValid')}</span>
            </div>
            <OtpBoxes value="" onChange={() => undefined} disabled label={t('auth.codeLabel')} />
            <span className="muted" style={{ fontSize: 13 }}>
              {t('investorSignIn.codeLater')}
            </span>
          </section>
        ) : null}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--sf-text-muted)' }}>
          <span>{t('investorSignIn.foot1')}</span>
          <span>{t('investorSignIn.foot2')}</span>
        </div>
      </div>
    </main>
  )
}
