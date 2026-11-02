import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { currentFyStartYear, fyLabel, useCompanyChoice } from '@/features/admin/branches/company'
import { Button, Card, Chip, ComingInPhase, DataTable, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, type Column } from '@/ui'

type Series = ViewRow<'doc_series'>
type DocType = ViewRow<'doc_types'>
type Fy = ViewRow<'financial_years'>

const PREFIX_RE = /^[A-Z0-9/-]{1,12}$/

interface Draft {
  id?: string
  doc_type: string
  gstin_id: string
  fy_id: string
  prefix: string
  pad: string
  next_no: string
  status: string
  /** values as loaded, so an edit sends only what changed (prefix and counter lock once numbers are issued) */
  orig?: { prefix: string; pad: string; next_no: string }
}

/** Format hint only: the server builds and checks the real number (api.doc_series.next_number / fits_limit). */
function previewNumber(prefix: string, fy: string | undefined, pad: number, next: number) {
  if (!fy) return ''
  return `${prefix}/${fy.slice(2, 4)}-${fy.slice(5, 7)}/${String(Math.max(1, next)).padStart(Math.min(Math.max(pad, 1), 8), '0')}`
}

/**
 * Numbering and IDs (`Numbering`): the number series of the chosen company per financial year, with the
 * next number and the 16-character GST limit as computed by api.doc_series. Admin adds and edits series
 * through api.upsert_doc_series and opens a financial year through api.open_financial_year.
 */
export function NumberingPage() {
  const { t } = useTranslation()
  const can = useCan()
  const canManage = can('settings.manage')
  const { list, company, companyId, choose, isLoading, notReady } = useCompanyChoice()
  const on = Boolean(companyId)
  const series = useApiView('doc_series', { order: 'doc_type', eq: { company_id: companyId }, enabled: on })
  const fys = useApiView('financial_years', { order: 'starts_on', ascending: false, eq: { company_id: companyId }, enabled: on })
  const gstins = useApiView('gstins', { order: 'gstin', eq: { company_id: companyId }, enabled: on })
  const docTypes = useApiView('doc_types', { order: 'sort' })
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_doc_series', [['api', 'doc_series']])
  const openFy = useApiMutation<{ p_company_id: string; p_start_year: number }>('open_financial_year', [['api', 'financial_years'], ['api', 'doc_series']])

  const [fyChoice, setFyChoice] = useState<string>('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})

  const fyList = rowsOf(fys)
  const types = rowsOf(docTypes)
  const startYear = currentFyStartYear()
  const currentLabel = fyLabel(startYear)
  const fy: Fy | undefined = fyList.find((f) => f.id === fyChoice) ?? fyList.find((f) => f.label === currentLabel) ?? fyList[0]
  const rows = rowsOf(series).filter((s) => s.fy_id === fy?.id)
  const hasCurrentFy = fyList.some((f) => f.label === currentLabel)
  const typeOf = (key: string): DocType | undefined => types.find((d) => d.key === key)
  const invoiceLimit = typeOf('sales_invoice')?.max_number_length

  function openNew() {
    if (!fy) return
    save.reset()
    setErrors({})
    setDraft({ doc_type: types[0]?.key ?? '', gstin_id: '', fy_id: fy.id, prefix: '', pad: '4', next_no: '1', status: 'active' })
  }
  function openEdit(s: Series) {
    save.reset()
    setErrors({})
    const orig = { prefix: s.prefix, pad: String(s.pad), next_no: String(s.next_no) }
    setDraft({ id: s.id, doc_type: s.doc_type, gstin_id: s.gstin_id ?? '', fy_id: s.fy_id, status: s.status, ...orig, orig })
  }
  function submit() {
    if (!draft || !companyId) return
    const e: Partial<Record<keyof Draft, string>> = {}
    if (!draft.doc_type) e.doc_type = t('numbering.err.docType')
    if (!PREFIX_RE.test(draft.prefix)) e.prefix = t('numbering.err.prefix')
    const pad = Number(draft.pad)
    if (!Number.isInteger(pad) || pad < 1 || pad > 8) e.pad = t('numbering.err.pad')
    const next = Number(draft.next_no)
    if (!/^[0-9]+$/.test(draft.next_no) || next < 1) e.next_no = t('numbering.err.next')
    setErrors(e)
    if (Object.keys(e).length) return
    let p: Record<string, unknown>
    if (draft.id) {
      p = { id: draft.id, status: draft.status }
      if (draft.prefix !== draft.orig?.prefix) p.prefix = draft.prefix
      if (draft.pad !== draft.orig?.pad) p.pad = pad
      if (draft.next_no !== draft.orig?.next_no) p.next_no = next
    } else {
      p = { company_id: companyId, doc_type: draft.doc_type, gstin_id: draft.gstin_id, fy_id: draft.fy_id, prefix: draft.prefix, pad, next_no: next }
    }
    save.mutate({ p }, { onSuccess: () => setDraft(null) })
  }

  const columns: Column<Series>[] = [
    {
      key: 'record',
      header: t('numbering.k.record'),
      render: (s) => (
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <strong>{s.doc_type_label}</strong>
          {typeOf(s.doc_type)?.gst_document ? <span className="k">{t('numbering.gstDocument')}</span> : null}
        </span>
      ),
    },
    { key: 'gstin', header: t('numbering.k.gstin'), render: (s) => (s.gstin ? <span className="mono">{s.gstin}</span> : <span className="muted">{t('numbering.allGstins')}</span>) },
    { key: 'prefix', header: t('numbering.k.prefix'), render: (s) => <span className="mono">{s.prefix}</span> },
    { key: 'next', header: t('numbering.k.next'), render: (s) => <span className="mono">{s.next_number}</span> },
    {
      key: 'length',
      header: t('numbering.k.length'),
      render: (s) => {
        const max = typeOf(s.doc_type)?.max_number_length
        return s.fits_limit ? (
          <Chip tone="teal" icon="check">
            {t('numbering.fits', { count: (s.next_number ?? '').length, max })}
          </Chip>
        ) : (
          <Chip tone="danger" icon="alert">
            {t('numbering.tooLong', { count: (s.next_number ?? '').length, max })}
          </Chip>
        )
      },
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (s) =>
        s.status === 'active' ? (
          <Chip tone="neutral" icon="check">
            {t('numbering.status.active')}
          </Chip>
        ) : (
          <Chip tone="neutral" icon="lock">
            {t('numbering.status.closed')}
          </Chip>
        ),
    },
    ...(canManage
      ? [
          {
            key: 'edit',
            header: <span className="sr-only">{t('common.edit')}</span>,
            align: 'right' as const,
            render: (s: Series) => (
              <Button size="sm" onClick={() => openEdit(s)} aria-label={`${t('common.edit')} ${s.doc_type_label}${s.gstin ? ` ${s.gstin}` : ''}`}>
                {t('common.edit')}
              </Button>
            ),
          },
        ]
      : []),
  ]

  const draftFy = fyList.find((f) => f.id === draft?.fy_id)
  const draftType = draft ? typeOf(draft.doc_type) : undefined
  const preview = draft ? previewNumber(draft.prefix || '…', draftFy?.label, Number(draft.pad) || 4, Number(draft.next_no) || 1) : ''
  const previewTooLong = Boolean(draftType && draft?.prefix && preview.length > draftType.max_number_length)

  return (
    <>
      <PageHeader
        title={t('numbering.title')}
        subtitle={t('numbering.subtitle')}
        actions={
          canManage && fy ? (
            <Button variant="primary" onClick={openNew}>
              {t('numbering.add')}
            </Button>
          ) : null
        }
      />

      <CompanyPicker list={list} value={companyId} onChange={choose} />

      {!canManage && company ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('numbering.readOnly')}
        </p>
      ) : null}

      {!isLoading && !company ? (
        <Card>
          <EmptyState title={t('branches.noCompanyTitle')} body={notReady ? t('branches.notReady') : t('branches.noCompanyBody')} />
        </Card>
      ) : null}

      {company && !fys.isLoading && !hasCurrentFy ? (
        <Card accent="signal">
          <EmptyState
            title={t('numbering.noFyTitle', { fy: currentLabel, company: company.name })}
            body={canManage ? t('numbering.noFyBodyAdmin') : t('numbering.noFyBody')}
            action={
              canManage ? (
                <Button variant="primary" busy={openFy.isPending} onClick={() => openFy.mutate({ p_company_id: company.id, p_start_year: startYear })}>
                  {t('numbering.openFy', { fy: currentLabel })}
                </Button>
              ) : null
            }
          />
          <RpcErrorBox error={openFy.error as RpcError | null} />
        </Card>
      ) : null}

      {company && (fy || fys.isLoading) ? (
        <section className="sf-card" aria-labelledby="num-docs">
          <div className="sf-card__pad sf-card__head" style={{ paddingBottom: 8, alignItems: 'flex-end' }}>
            <div>
              <h2 id="num-docs" className="sf-card__title">
                {t('numbering.docs.title')}
              </h2>
              <p className="k" style={{ margin: '4px 0 0' }}>
                {fy ? t('numbering.docs.perFy', { fy: fy.label }) : ''}
              </p>
            </div>
            {fyList.length > 1 ? (
              <div style={{ minWidth: 180 }}>
                <SelectField label={t('numbering.f.fy')} value={fy?.id ?? ''} onChange={(e) => setFyChoice(e.target.value)} options={fyList.map((f) => ({ value: f.id, label: f.label }))} />
              </div>
            ) : null}
          </div>
          <DataTable
            caption={t('numbering.docs.title')}
            columns={columns}
            rows={rows}
            rowKey={(s) => s.id}
            loading={series.isLoading || fys.isLoading}
            empty={canManage ? t('numbering.docs.emptyAdmin') : t('numbering.docs.empty')}
            minWidth={820}
          />
        </section>
      ) : null}

      <Card title={t('numbering.masters.title')} labelledBy="num-masters">
        <p style={{ marginTop: 0 }}>{t('numbering.masters.body')}</p>
        <ComingInPhase phase={2} />
      </Card>

      <Card>
        <ul className="sf-row" style={{ listStyle: 'none', margin: 0, padding: 0, gap: '8px 28px', color: 'var(--sf-text-2)', fontSize: 13 }}>
          <li>{t('numbering.notes.never')}</li>
          <li>{t('numbering.notes.gapFree')}</li>
          <li>{invoiceLimit ? t('numbering.notes.limit', { max: invoiceLimit }) : t('numbering.notes.limitUnknown')}</li>
          <li>{t('numbering.notes.lock')}</li>
        </ul>
      </Card>

      <FormDialog
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? t('numbering.editTitle') : t('numbering.addTitle')}
        description={t('numbering.formHelp')}
        submitLabel={t('common.save')}
        busy={save.isPending}
        onSubmit={submit}
        error={<RpcErrorBox error={save.error as RpcError | null} />}
        wide
      >
        {draft ? (
          <FieldGrid>
            <SelectField
              label={t('numbering.f.docType')}
              value={draft.doc_type}
              disabled={Boolean(draft.id)}
              onChange={(e) => setDraft({ ...draft, doc_type: e.target.value })}
              options={types.map((d) => ({ value: d.key, label: d.label }))}
              error={errors.doc_type}
            />
            <SelectField
              label={t('numbering.f.fy')}
              value={draft.fy_id}
              disabled={Boolean(draft.id)}
              onChange={(e) => setDraft({ ...draft, fy_id: e.target.value })}
              options={fyList.map((f) => ({ value: f.id, label: f.label }))}
            />
            <SelectField
              label={t('numbering.f.gstin')}
              value={draft.gstin_id}
              disabled={Boolean(draft.id)}
              onChange={(e) => setDraft({ ...draft, gstin_id: e.target.value })}
              placeholder={t('numbering.allGstins')}
              options={rowsOf(gstins).map((g) => ({ value: g.id, label: g.gstin }))}
              help={t('numbering.f.gstinHelp')}
            />
            <Field
              label={t('numbering.f.prefix')}
              className="mono"
              value={draft.prefix}
              maxLength={12}
              onChange={(e) => setDraft({ ...draft, prefix: e.target.value.toUpperCase().replace(/\s/g, '') })}
              error={errors.prefix}
              warning={previewTooLong ? t('numbering.warnTooLong', { max: draftType?.max_number_length }) : undefined}
              help={t('numbering.f.prefixHelp')}
            />
            <Field label={t('numbering.f.pad')} type="number" min={1} max={8} inputMode="numeric" value={draft.pad} onChange={(e) => setDraft({ ...draft, pad: e.target.value })} error={errors.pad} help={t('numbering.f.padHelp')} />
            <Field label={t('numbering.f.next')} type="number" min={1} inputMode="numeric" value={draft.next_no} onChange={(e) => setDraft({ ...draft, next_no: e.target.value })} error={errors.next_no} help={t('numbering.f.nextHelp')} />
            {draft.id ? (
              <SelectField
                label={t('common.status')}
                value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                options={[
                  { value: 'active', label: t('numbering.status.active') },
                  { value: 'closed', label: t('numbering.status.closed') },
                ]}
              />
            ) : null}
            <div style={{ gridColumn: '1 / -1' }} aria-live="polite">
              <span className="k">{t('numbering.preview')}</span>{' '}
              <span className="mono" style={{ fontWeight: 600 }}>
                {preview}
              </span>{' '}
              {draftType ? <span className="k">· {t('numbering.previewLength', { count: preview.length, max: draftType.max_number_length })}</span> : null}
            </div>
          </FieldGrid>
        ) : null}
      </FormDialog>
    </>
  )
}
