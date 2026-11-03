import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useApiMutation } from '@/data/rpc'
import { Button, Field, SelectField, TextAreaField } from '@/ui'
import { REQUEST_KEYS, useInvestorMe, useMyRequests } from '../common/investor'
import { InvestorError, Line, LoadFailed, Loading, NotLinked, PCard, RequestList, RequestTabs, cleanAmount } from '../common/ui'

type Source = 'land_rent' | 'incentive' | 'dividend' | 'investment'
interface Args extends Record<string, unknown> {
  p_kind: 'withdraw'
  p: { partner_id: string; source: Source; amount: string; note: string | null }
}

/**
 * Investor portal · request a withdrawal (`InvestorWithdraw`). The only write here is `submit_partner_request`; Admin
 * decides it with the server's checks (never more than the company owes the partner on their current account) and the
 * company pays from its bank. My own requests are listed with their status from `v_investor_requests`.
 */
export function InvestorWithdrawPage() {
  const { t } = useTranslation()
  const { me, isLoading, isError } = useInvestorMe()
  const requests = useMyRequests()
  const send = useApiMutation<Args, { id: string; doc_no: string; status: string }>('submit_partner_request', REQUEST_KEYS)
  const [partnerId, setPartnerId] = useState('')
  const [source, setSource] = useState<Source>('land_rent')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  if (isLoading) return <Loading />
  if (isError || !me) return <LoadFailed />
  const partners = me.partners
  const chosen = partnerId || partners[0]?.partner_id || ''
  const amt = cleanAmount(amount)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSent(null)
    if (!chosen || !amt.ok) return
    send.mutate(
      { p_kind: 'withdraw', p: { partner_id: chosen, source, amount: amt.value, note: note.trim() || null } },
      {
        onSuccess: (r) => {
          setSent(r.doc_no)
          setAmount('')
          setNote('')
        },
      },
    )
  }

  return (
    <>
      <h1 className="sr-only">{t('investorWithdraw.title')}</h1>
      <RequestTabs />
      {partners.length === 0 ? (
        <NotLinked />
      ) : (
        <>
          <PCard labelId="wd-what" title={t('investorWithdraw.whatTitle')} action={me.display_name ?? undefined}>
            <div>
              <Line label={t('investor.source.land_rent')}>
                <span className="muted">{t('investorWithdraw.whenDue')}</span>
              </Line>
              <Line label={t('investor.source.incentive')}>
                <span className="muted">{t('investorWithdraw.afterClose')}</span>
              </Line>
              <Line label={t('investor.source.dividend')}>
                <span className="muted">{t('investorWithdraw.whenDeclared')}</span>
              </Line>
              <Line label={t('investor.source.investment')}>
                <span className="muted">{t('investorWithdraw.byAgreement')}</span>
              </Line>
            </div>
          </PCard>
          <form className="sf-phone-card" onSubmit={onSubmit} noValidate aria-labelledby="wd-form">
            <h2 id="wd-form" className="sr-only">
              {t('investorWithdraw.formTitle')}
            </h2>
            {partners.length > 1 ? (
              <SelectField label={t('investor.company')} value={chosen} onChange={(e) => setPartnerId(e.target.value)} options={partners.map((p) => ({ value: p.partner_id, label: p.company ?? p.name }))} />
            ) : null}
            <SelectField
              label={t('investorWithdraw.drawFrom')}
              value={source}
              onChange={(e) => setSource(e.target.value as Source)}
              options={(['land_rent', 'incentive', 'dividend', 'investment'] as const).map((s) => ({ value: s, label: t(`investorWithdraw.from.${s}`) }))}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field
                label={t('investorWithdraw.amount')}
                inputMode="decimal"
                className="mono"
                autoComplete="off"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                error={amount && !amt.ok ? t('investorWithdraw.amountFormat') : undefined}
              />
              <SelectField label={t('investorWithdraw.payTo')} value="bank" onChange={() => undefined} options={[{ value: 'bank', label: t('investorWithdraw.bankOnFile') }]} />
            </div>
            <TextAreaField label={t('investorWithdraw.note')} placeholder={t('investorWithdraw.optional')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
            <InvestorError error={send.error} />
            {sent ? (
              <div className="sf-phone-note" role="status" data-testid="investor-sent">
                {t('investor.sent', { doc: sent })}
              </div>
            ) : null}
            <Button type="submit" variant="primary" size="hero" busy={send.isPending} disabled={!amt.ok || !chosen}>
              {t('investor.send')}
            </Button>
          </form>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            {t('investorWithdraw.rule1')}
          </p>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            {t('investorWithdraw.rule2')}
          </p>
        </>
      )}
      <RequestList rows={requests.rows} kinds={['withdraw', 'info']} loading={requests.isLoading} title={t('investorWithdraw.mine')} emptyText={t('investorWithdraw.noneYet')} />
    </>
  )
}
