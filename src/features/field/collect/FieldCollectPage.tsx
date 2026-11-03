import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { RpcError } from '@/data/rpc'
import { Amount, Button, Field, SelectField } from '@/ui'
import { AccountSummary, PromiseForm, StatementButton } from '../common/account'
import { FieldErrorBox, FieldFrame, FieldGate, sendOrQueue, todayIstIso, uploadFieldPhoto, useFieldCompany, useFieldRefresh, useFieldRights, useMyCustomers, useMyDay, useOpenVisit } from '../common/field'

interface CollectResult {
  voucher_id: string
  doc_no: string
  allocated: { kind: string; bill_ref: string | null; amount: number | string }[]
  on_account: number | string
  balance_gst: number | string
}

const AMOUNT = /^\d+(\.\d{1,2})?$/

/**
 * Collect payment (§15A.4): amount and mode (cash, cheque with a photo, UPI or bank with the reference). The server
 * refuses cash of ₹2 lakh or more from one customer in a day (Phase 3 cash rule), allocates oldest bill first among the
 * bills the salesman may see, issues the receipt number at once and queues the WhatsApp receipt. Cash shows as
 * "with me" until handed over. Promise to pay and the statement on WhatsApp are on the same screen.
 */
export function FieldCollectPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const rights = useFieldRights()
  const refresh = useFieldRefresh()
  const { companyId, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const { open } = useOpenVisit(companyId)
  const customers = useMyCustomers(companyId)
  const row = (customers.data?.status === 'ready' ? (customers.data.data ?? []) : []).find((c) => c.party_id === id)
  const onDuty = day.data?.status === 'ready' ? Boolean(day.data.data?.on_duty) : undefined
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<'cash' | 'cheque' | 'upi' | 'bank'>('cash')
  const [reference, setReference] = useState('')
  const [cheque, setCheque] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [uploadErr, setUploadErr] = useState(false)
  const [result, setResult] = useState<CollectResult | null>(null)
  const [queued, setQueued] = useState(false)
  const clean = amount.replace(/[,\s]/g, '')

  async function collect() {
    if (!companyId) return
    setBusy(true)
    setError(null)
    setUploadErr(false)
    setResult(null)
    setQueued(false)
    try {
      let chequePath: string | null = null
      if (mode === 'cheque' && cheque) {
        try {
          chequePath = await uploadFieldPhoto(companyId, 'cheques', cheque)
        } catch {
          setUploadErr(true)
          return
        }
      }
      const out = await sendOrQueue<CollectResult>(
        'field_collect',
        {
          p: {
            company_id: companyId,
            party_id: id,
            amount: clean,
            mode,
            reference: reference.trim() || null,
            cheque_photo_path: chequePath,
            visit_id: open && open.party_id === id ? open.id : null,
            date: todayIstIso(),
          },
        },
        'collection',
      )
      if (out.queued) setQueued(true)
      else setResult(out.result)
      setAmount('')
      setReference('')
      setCheque(null)
      await refresh()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <FieldFrame title={t('fieldCollect.title')} sub={row?.name} back={`/field/customers/${id}`} onDuty={onDuty}>
      <FieldGate loading={isLoading || customers.isLoading} companyId={companyId} sell={rights.sell}>
        {!row || !companyId ? (
          <div className="sf-phone-note" role="status">
            {t('fieldCollect.notMine')}
          </div>
        ) : (
          <>
            <AccountSummary companyId={companyId} partyId={id} />
            <section className="sf-phone-card" aria-labelledby="collect-head">
              <h2 id="collect-head">{t('fieldCollect.heading')}</h2>
              <Field label={t('fieldCollect.amount')} inputMode="decimal" prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <SelectField
                label={t('fieldCollect.mode')}
                value={mode}
                onChange={(e) => setMode(e.target.value as 'cash' | 'cheque' | 'upi' | 'bank')}
                options={(['cash', 'cheque', 'upi', 'bank'] as const).map((m) => ({ value: m, label: t(`fieldCollect.modes.${m}`) }))}
              />
              {mode === 'upi' || mode === 'bank' || mode === 'cheque' ? (
                <Field label={mode === 'cheque' ? t('fieldCollect.chequeNo') : t('fieldCollect.reference')} value={reference} onChange={(e) => setReference(e.target.value)} />
              ) : null}
              {mode === 'cheque' ? (
                <label className="sf-field">
                  <span className="sf-field__label">{t('fieldCollect.chequePhoto')}</span>
                  <input type="file" accept="image/*" capture="environment" className="sf-input" onChange={(e) => setCheque(e.target.files?.[0] ?? null)} />
                </label>
              ) : null}
              {mode === 'cash' ? (
                <p className="k" style={{ margin: 0 }}>
                  {t('fieldCollect.cashRule')}
                </p>
              ) : null}
              <Button variant="primary" size="hero" busy={busy} disabled={!AMOUNT.test(clean) || Number(clean) <= 0} onClick={() => void collect()}>
                {t('fieldCollect.collect')}
              </Button>
              {uploadErr ? (
                <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
                  {t('fieldCollect.uploadFailed')}
                </p>
              ) : null}
              <FieldErrorBox error={error} />
              {result ? (
                <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0, flexDirection: 'column', alignItems: 'flex-start' }} data-testid="collect-result">
                  <strong>{t('fieldCollect.done', { doc: result.doc_no })}</strong>
                  {result.allocated.map((a, i) => (
                    <span key={i}>
                      {a.bill_ref ?? '—'} · <Amount value={a.amount} rupee />
                    </span>
                  ))}
                  {Number(result.on_account) > 0 ? (
                    <span>
                      {t('fieldCollect.onAccount')} <Amount value={result.on_account} rupee />
                    </span>
                  ) : null}
                  <span>
                    {t('fieldCollect.balance')} <Amount value={result.balance_gst} rupee />
                  </span>
                  {mode === 'cash' ? <span className="k">{t('fieldCollect.withMe')}</span> : null}
                </div>
              ) : null}
              {queued ? (
                <p role="status" className="sf-alert" data-tone="signal" style={{ margin: 0 }}>
                  {t('fieldCollect.queued')}
                </p>
              ) : null}
            </section>
            <StatementButton companyId={companyId} partyId={id} />
            <PromiseForm companyId={companyId} partyId={id} />
          </>
        )}
      </FieldGate>
    </FieldFrame>
  )
}
