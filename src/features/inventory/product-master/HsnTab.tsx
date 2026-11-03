import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { todayIst } from '@/features/admin/branches/company'
import { formatDate } from '@/shared/format'
import { Button, Card, Checkbox, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'
import { rateText, TAX_CLASSES } from './shared'

type Hsn = ViewRow<'hsn_codes'>

/**
 * HSN and GST rates: api.hsn_codes with the rate in force today. Rates are never typed into code or prefilled:
 * Admin enters each version from a date (api.add_hsn_rate) and marks whether the CA has confirmed it.
 */
export function HsnTab({ canManage, adding, setAdding }: { canManage: boolean; adding: boolean; setAdding: (v: boolean) => void }) {
  const { t } = useTranslation()
  const hsnQ = useApiView('hsn_codes', { order: 'code' })
  const rows = rowsOf(hsnQ)
  const [rateFor, setRateFor] = useState<Hsn | null>(null)
  const [historyFor, setHistoryFor] = useState<Hsn | null>(null)

  const columns: Column<Hsn>[] = [
    { key: 'code', header: t('productMaster.h.code'), width: 110, render: (h) => <span className="mono">{h.code}</span> },
    { key: 'desc', header: t('productMaster.h.description'), render: (h) => h.description },
    { key: 'kind', header: t('productMaster.h.kind'), render: (h) => t(`productMaster.h.kinds.${h.kind}`) },
    { key: 'rate', header: t('productMaster.h.rate'), align: 'right', render: (h) => <span className="mono">{rateText(h.current_rate)}</span> },
    { key: 'class', header: t('productMaster.h.class'), render: (h) => (h.current_tax_class ? t(`productMaster.taxClass.${h.current_tax_class}`) : <span className="muted">—</span>) },
    { key: 'ca', header: t('productMaster.h.ca'), render: (h) => <CaChip rate={h.current_rate} confirmed={h.current_ca_confirmed} /> },
    {
      key: 'actions',
      header: <span className="sr-only">{t('productMaster.col.actions')}</span>,
      render: (h) => (
        <div className="sf-row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
          <Button size="sm" aria-label={t('productMaster.h.historyFor', { code: h.code })} onClick={() => setHistoryFor(h)}>
            {t('productMaster.h.history')}
          </Button>
          {canManage ? (
            <Button size="sm" aria-label={t('productMaster.h.addRateFor', { code: h.code })} onClick={() => setRateFor(h)}>
              {t('productMaster.h.addRate')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <>
      <Card pad={false}>
        <div className="sf-card__pad" style={{ paddingBottom: 8 }}>
          <div className="sf-card__head">
            <h2 className="sf-card__title">{t('productMaster.h.title')}</h2>
          </div>
          <p className="k" style={{ margin: 0, fontSize: 13 }}>
            {t('productMaster.h.help')}
          </p>
        </div>
        <DataTable
          caption={t('productMaster.h.title')}
          columns={columns}
          rows={rows}
          rowKey={(h) => h.code}
          loading={hsnQ.isLoading}
          empty={
            <EmptyState
              title={t('productMaster.h.emptyTitle')}
              body={canManage ? t('productMaster.h.emptyBodyAdmin') : t('productMaster.h.emptyBody')}
              action={
                canManage ? (
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    {t('productMaster.h.add')}
                  </Button>
                ) : null
              }
            />
          }
        />
      </Card>
      {adding ? <HsnDialog onClose={() => setAdding(false)} /> : null}
      {rateFor ? <RateDialog hsn={rateFor} onClose={() => setRateFor(null)} /> : null}
      {historyFor ? <HistoryDialog hsn={historyFor} onClose={() => setHistoryFor(null)} /> : null}
    </>
  )
}

export function CaChip({ rate, confirmed }: { rate: number | null; confirmed: boolean | null }) {
  const { t } = useTranslation()
  if (rate === null) return <Chip tone="neutral" icon="info">{t('productMaster.h.noRate')}</Chip>
  return confirmed ? (
    <Chip tone="teal" icon="check">
      {t('productMaster.h.confirmed')}
    </Chip>
  ) : (
    <Chip tone="signal" icon="alert">
      {t('productMaster.h.notConfirmed')}
    </Chip>
  )
}

function HsnDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState('goods')
  const [errors, setErrors] = useState<{ code?: string; description?: string }>({})
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_hsn', [['api', 'hsn_codes']])

  function submit() {
    const e: { code?: string; description?: string } = {}
    if (!/^[0-9]{4,8}$/.test(code.trim())) e.code = t('productMaster.h.errCode')
    if (description.trim().length < 2) e.description = t('productMaster.h.errDescription')
    setErrors(e)
    if (Object.keys(e).length) return
    save.mutate({ p: { code: code.trim(), description: description.trim(), kind } }, { onSuccess: onClose })
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('productMaster.h.addTitle')}
      description={t('productMaster.h.addHelp')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      onSubmit={submit}
      error={<RpcErrorBox error={save.error as RpcError | null} />}
    >
      <FieldGrid>
        <Field label={t('productMaster.h.code')} className="mono" inputMode="numeric" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} error={errors.code} />
        <SelectField
          label={t('productMaster.h.kind')}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          options={['goods', 'services'].map((k) => ({ value: k, label: t(`productMaster.h.kinds.${k}`) }))}
        />
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label={t('productMaster.h.description')} value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} />
        </div>
      </FieldGrid>
    </FormDialog>
  )
}

function RateDialog({ hsn, onClose }: { hsn: Hsn; onClose: () => void }) {
  const { t } = useTranslation()
  const [rate, setRate] = useState('')
  const [cess, setCess] = useState('')
  const [taxClass, setTaxClass] = useState('taxable')
  const [from, setFrom] = useState(todayIst())
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<{ rate?: string; cess?: string; from?: string }>({})
  const save = useApiMutation<Record<string, unknown>>('add_hsn_rate', [['api', 'hsn_codes'], ['api', 'hsn_rates'], ['api', 'products']])

  function submit() {
    const e: { rate?: string; cess?: string; from?: string } = {}
    const num = /^\d{1,3}(\.\d{1,4})?$/
    if (!num.test(rate.trim()) || Number(rate) > 100) e.rate = t('productMaster.h.errRate')
    if (cess.trim() && !num.test(cess.trim())) e.cess = t('productMaster.h.errRate')
    if (!from) e.from = t('productMaster.h.errFrom')
    setErrors(e)
    if (Object.keys(e).length) return
    save.mutate(
      {
        p_hsn: hsn.code,
        p_rate: rate.trim(),
        p_cess: cess.trim() || null,
        p_tax_class: taxClass,
        p_effective_from: from,
        p_ca_confirmed: confirmed,
        p_note: note.trim() || null,
      },
      { onSuccess: onClose },
    )
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('productMaster.h.rateTitle', { code: hsn.code })}
      description={t('productMaster.h.rateHelp')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      onSubmit={submit}
      error={<RpcErrorBox error={save.error as RpcError | null} />}
    >
      <FieldGrid>
        <Field label={t('productMaster.h.ratePct')} className="mono" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} error={errors.rate} help={t('productMaster.h.rateNoPrefill')} />
        <Field label={t('productMaster.h.cessPct')} className="mono" inputMode="decimal" value={cess} onChange={(e) => setCess(e.target.value)} error={errors.cess} />
        <SelectField
          label={t('productMaster.h.class')}
          value={taxClass}
          onChange={(e) => setTaxClass(e.target.value)}
          options={TAX_CLASSES.map((c) => ({ value: c, label: t(`productMaster.taxClass.${c}`) }))}
        />
        <Field label={t('productMaster.h.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} error={errors.from} />
        <div style={{ gridColumn: '1 / -1' }}>
          <Checkbox label={t('productMaster.h.caCheckbox')} hint={t('productMaster.h.caHint')} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <TextAreaField label={t('productMaster.h.note')} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </FieldGrid>
    </FormDialog>
  )
}

function HistoryDialog({ hsn, onClose }: { hsn: Hsn; onClose: () => void }) {
  const { t } = useTranslation()
  const q = useApiView('hsn_rates', { eq: { hsn_code: hsn.code }, order: 'effective_from', ascending: false })
  const rows = rowsOf(q)
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('productMaster.h.historyTitle', { code: hsn.code })}
      description={hsn.description}
      submitLabel={t('common.close')}
      onSubmit={onClose}
      wide
    >
      {q.isLoading ? (
        <Skeleton height={60} />
      ) : rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('productMaster.h.noHistory')}
        </p>
      ) : (
        <div className="sf-table-wrap">
          <table className="sf-table">
            <caption className="sr-only">{t('productMaster.h.historyTitle', { code: hsn.code })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('productMaster.h.from')}</th>
                <th scope="col">{t('productMaster.h.to')}</th>
                <th scope="col" className="r">
                  {t('productMaster.h.ratePct')}
                </th>
                <th scope="col" className="r">
                  {t('productMaster.h.cessPct')}
                </th>
                <th scope="col">{t('productMaster.h.class')}</th>
                <th scope="col">{t('productMaster.h.ca')}</th>
                <th scope="col">{t('productMaster.h.note')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{formatDate(r.effective_from)}</td>
                  <td className="mono">{r.effective_to ? formatDate(r.effective_to) : t('productMaster.h.open')}</td>
                  <td className="r mono">{rateText(r.rate)}</td>
                  <td className="r mono">{rateText(r.cess_rate)}</td>
                  <td>{t(`productMaster.taxClass.${r.tax_class}`)}</td>
                  <td>
                    <CaChip rate={r.rate} confirmed={r.ca_confirmed} />
                  </td>
                  <td>{r.note ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </FormDialog>
  )
}
