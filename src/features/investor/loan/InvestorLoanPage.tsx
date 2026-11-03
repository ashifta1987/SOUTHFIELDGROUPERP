import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useApiMutation } from '@/data/rpc'
import { SegRadio } from '@/features/staff/common'
import { Button, Field, SelectField } from '@/ui'
import { REQUEST_KEYS, useGroupSummary, useInvestorMe, useMyRequests } from '../common/investor'
import { InvestorError, Line, LoadFailed, Loading, LoanBalance, NotLinked, PCard, RequestList, RequestTabs, cleanAmount } from '../common/ui'

type Direction = 'borrow' | 'lend'
type RepayFrom = 'land_rent' | 'incentive' | 'bank'
interface Args extends Record<string, unknown> {
  p_kind: 'loan_to_partner' | 'loan_from_partner'
  p: { partner_id: string; amount: string; repay_months: number | null; repay_from: RepayFrom | null; purpose: string | null }
}

/**
 * Investor portal · loan request (`InvestorLoan`): borrow from a company (`loan_to_partner`) or lend to it
 * (`loan_from_partner`). The only write is `submit_partner_request`. When Admin decides, the server runs the Companies
 * Act checks (s.185 for directors and interested parties, the s.186 limit, a director's declaration that money lent is
 * not borrowed); their messages come from the server.
 */
export function InvestorLoanPage() {
  const { t } = useTranslation()
  const { me, isLoading, isError } = useInvestorMe()
  const group = useGroupSummary()
  const requests = useMyRequests()
  const send = useApiMutation<Args, { id: string; doc_no: string; status: string }>('submit_partner_request', REQUEST_KEYS)
  const [direction, setDirection] = useState<Direction>('borrow')
  const [partnerId, setPartnerId] = useState('')
  const [amount, setAmount] = useState('')
  const [months, setMonths] = useState('')
  const [repayFrom, setRepayFrom] = useState<RepayFrom>('land_rent')
  const [purpose, setPurpose] = useState('')
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
      {
        p_kind: direction === 'borrow' ? 'loan_to_partner' : 'loan_from_partner',
        p: { partner_id: chosen, amount: amt.value, repay_months: months ? Number(months) : null, repay_from: direction === 'borrow' ? repayFrom : null, purpose: purpose.trim() || null },
      },
      {
        onSuccess: (r) => {
          setSent(r.doc_no)
          setAmount('')
          setPurpose('')
        },
      },
    )
  }

  return (
    <>
      <h1 className="sr-only">{t('investorLoan.title')}</h1>
      <RequestTabs />
      {partners.length === 0 ? (
        <NotLinked />
      ) : (
        <>
          <PCard labelId="loan-accts" title={t('investorLoan.accounts')}>
            <div>
              {(group.summary?.companies ?? []).map((c) => (
                <Line key={c.company_id} label={c.company ?? ''}>
                  <LoanBalance value={c.my_loan_account} />
                </Line>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {t('investorLoan.accountsNote')}
            </span>
          </PCard>
          <form className="sf-phone-card" onSubmit={onSubmit} noValidate aria-labelledby="loan-form">
            <h2 id="loan-form" className="sr-only">
              {t('investorLoan.formTitle')}
            </h2>
            <SegRadio<Direction>
              legend={t('investorLoan.direction')}
              name="loan-direction"
              value={direction}
              onChange={setDirection}
              options={[
                { value: 'borrow', label: t('investorLoan.borrow') },
                { value: 'lend', label: t('investorLoan.lend') },
              ]}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <SelectField label={t('investor.company')} value={chosen} onChange={(e) => setPartnerId(e.target.value)} options={partners.map((p) => ({ value: p.partner_id, label: p.company ?? p.name }))} />
              <Field
                label={t('investorLoan.amount')}
                inputMode="decimal"
                className="mono"
                autoComplete="off"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                error={amount && !amt.ok ? t('investorLoan.amountFormat') : undefined}
              />
              <SelectField
                label={t('investorLoan.repayOver')}
                value={months}
                onChange={(e) => setMonths(e.target.value)}
                placeholder={t('investorLoan.choose')}
                options={['3', '6', '12', '24', '36'].map((m) => ({ value: m, label: t('investorLoan.months', { n: m }) }))}
              />
              {direction === 'borrow' ? (
                <SelectField
                  label={t('investorLoan.repayFrom')}
                  value={repayFrom}
                  onChange={(e) => setRepayFrom(e.target.value as RepayFrom)}
                  options={(['land_rent', 'incentive', 'bank'] as const).map((r) => ({ value: r, label: t(`investor.repayFrom.${r}`) }))}
                />
              ) : null}
            </div>
            <Field label={t('investorLoan.purpose')} placeholder={t('investorLoan.purposeHint')} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} />
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
            {t('investorLoan.rule')}
          </p>
        </>
      )}
      <RequestList rows={requests.rows} kinds={['loan_to_partner', 'loan_from_partner']} loading={requests.isLoading} title={t('investorLoan.mine')} emptyText={t('investorLoan.noneYet')} />
    </>
  )
}
