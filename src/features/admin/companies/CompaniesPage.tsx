import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { routeForFile } from '@/app/flows'
import { Button, Card, Chip, EmptyState, Field, FieldGrid, FormDialog, PageHeader, Skeleton, TextAreaField } from '@/ui'

type Company = ViewRow<'companies'>
type Gstin = ViewRow<'gstins'>
type Series = ViewRow<'doc_series'>

/** Logos available in /public/brand, chosen per company by Admin (logo_key). */
export const LOGOS: Record<string, string> = {
  plastics: '/brand/southfield-plastics-logo.svg',
  biochem: '/brand/southfield-biochem-logo.png',
  group: '/brand/southfield-group-logo.png',
}

interface Draft {
  id?: string
  code: string
  legal_name: string
  short_name: string
  pan: string
  cin: string
  registered_address: string
  logo_key: string
}
const EMPTY: Draft = { code: '', legal_name: '', short_name: '', pan: '', cin: '', registered_address: '', logo_key: '' }

/**
 * Companies (`Companies`): one card per legal entity with its GSTINs, address and invoice series.
 * Everything comes from api.companies / api.gstins / api.doc_series; Admin adds and edits through api.upsert_company.
 */
export function CompaniesPage() {
  const { t } = useTranslation()
  const can = useCan()
  const canManage = can('org.manage')
  const companies = useApiView('companies', { order: 'code' })
  const gstins = useApiView('gstins', { order: 'gstin' })
  const series = useApiView('doc_series', { order: 'doc_type' })
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_company', [['api', 'companies']])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})

  const list = rowsOf(companies)
  const notReady = companies.data?.status === 'not-ready'

  function openNew() {
    save.reset()
    setErrors({})
    setDraft({ ...EMPTY })
  }
  function openEdit(c: Company) {
    save.reset()
    setErrors({})
    setDraft({
      id: c.id,
      code: c.code,
      legal_name: c.name,
      short_name: c.short_name,
      pan: c.pan ?? '',
      cin: c.cin ?? '',
      registered_address: c.registered_address ?? '',
      logo_key: c.logo_key ?? '',
    })
  }
  function validate(d: Draft) {
    const e: Partial<Record<keyof Draft, string>> = {}
    if (!d.id && !/^[A-Z0-9]{2,8}$/.test(d.code.trim().toUpperCase())) e.code = t('companies.err.code')
    if (d.legal_name.trim().length < 2) e.legal_name = t('companies.err.legalName')
    if (d.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(d.pan.trim().toUpperCase())) e.pan = t('companies.err.pan')
    return e
  }
  function submit() {
    if (!draft) return
    const e = validate(draft)
    setErrors(e)
    if (Object.keys(e).length) return
    const p: Record<string, unknown> = {
      legal_name: draft.legal_name.trim(),
      short_name: draft.short_name.trim() || draft.legal_name.trim(),
      pan: draft.pan.trim().toUpperCase(),
      cin: draft.cin.trim(),
      registered_address: draft.registered_address.trim(),
      logo_key: draft.logo_key,
    }
    if (draft.id) p.id = draft.id
    else p.code = draft.code.trim().toUpperCase()
    save.mutate({ p }, { onSuccess: () => setDraft(null) })
  }

  return (
    <>
      <PageHeader
        title={t('companies.title')}
        subtitle={t('companies.subtitle')}
        actions={
          canManage ? (
            <Button variant="primary" onClick={openNew}>
              {t('companies.add')}
            </Button>
          ) : null
        }
      />

      {companies.isLoading ? (
        <div className="sf-grid-3">
          <Card>
            <Skeleton height={120} />
          </Card>
          <Card>
            <Skeleton height={120} />
          </Card>
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            title={t('companies.emptyTitle')}
            body={notReady ? t('companies.emptyNotReady') : canManage ? t('companies.emptyBodyAdmin') : t('companies.emptyBody')}
            action={
              canManage ? (
                <Button variant="primary" onClick={openNew}>
                  {t('companies.add')}
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="sf-grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
          {list.map((c) => (
            <CompanyCard
              key={c.id}
              c={c}
              gstins={rowsOf(gstins).filter((g) => g.company_id === c.id)}
              series={rowsOf(series).filter((s) => s.company_id === c.id)}
              onEdit={canManage ? () => openEdit(c) : undefined}
            />
          ))}
        </div>
      )}

      <Card pad={false}>
        <div className="sf-card__pad" style={{ paddingBottom: 6 }}>
          <h2 className="sf-card__title">{t('companies.apart.title')}</h2>
        </div>
        <div className="sf-table-wrap">
          <table className="sf-table">
            <caption className="sr-only">{t('companies.apart.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('companies.apart.separate')}</th>
                <th scope="col">{t('companies.apart.shared')}</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                <tr key={i}>
                  <td>{t(`companies.apart.s${i}`)}</td>
                  <td>{t(`companies.apart.h${i}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <FormDialog
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? t('companies.editTitle') : t('companies.addTitle')}
        description={t('companies.formHelp')}
        submitLabel={t('common.save')}
        busy={save.isPending}
        onSubmit={submit}
        error={<RpcErrorBox error={save.error as RpcError | null} />}
        wide
      >
        {draft ? (
          <FieldGrid>
            <Field
              label={t('companies.f.code')}
              className="mono"
              value={draft.code}
              disabled={Boolean(draft.id)}
              maxLength={8}
              onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
              error={errors.code}
              help={t('companies.f.codeHelp')}
            />
            <Field label={t('companies.f.legalName')} value={draft.legal_name} onChange={(e) => setDraft({ ...draft, legal_name: e.target.value })} error={errors.legal_name} />
            <Field label={t('companies.f.shortName')} value={draft.short_name} onChange={(e) => setDraft({ ...draft, short_name: e.target.value })} />
            <Field label={t('companies.f.pan')} className="mono" value={draft.pan} maxLength={10} onChange={(e) => setDraft({ ...draft, pan: e.target.value.toUpperCase() })} error={errors.pan} />
            <Field label={t('companies.f.cin')} className="mono" value={draft.cin} onChange={(e) => setDraft({ ...draft, cin: e.target.value.toUpperCase() })} />
            <div className="sf-field">
              <span className="sf-field__label" id="logo-label">
                {t('companies.f.logo')}
              </span>
              <div className="sf-row" role="radiogroup" aria-labelledby="logo-label">
                {(['', 'plastics', 'biochem', 'group'] as const).map((k) => (
                  <label key={k || 'none'} className="sf-chip" data-tone={draft.logo_key === k ? 'teal' : 'outline'} style={{ cursor: 'pointer' }}>
                    <input type="radio" name="logo" className="sr-only" checked={draft.logo_key === k} onChange={() => setDraft({ ...draft, logo_key: k })} />
                    {k ? t(`companies.logo.${k}`) : t('common.none')}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <TextAreaField label={t('companies.f.address')} value={draft.registered_address} onChange={(e) => setDraft({ ...draft, registered_address: e.target.value })} />
            </div>
          </FieldGrid>
        ) : null}
      </FormDialog>
    </>
  )
}

function CompanyCard({ c, gstins, series, onEdit }: { c: Company; gstins: Gstin[]; series: Series[]; onEdit?: () => void }) {
  const { t } = useTranslation()
  const logo = c.logo_key ? LOGOS[c.logo_key] : undefined
  const invoiceSeries = series.filter((s) => s.doc_type === 'sales_invoice')
  return (
    <section className="sf-card sf-card__pad" style={{ borderTop: '4px solid var(--sf-navy)' }} aria-labelledby={`co-${c.id}`}>
      <div className="sf-card__head" style={{ alignItems: 'center' }}>
        {logo ? (
          <img src={logo} alt="" height={44} style={{ height: 44, width: 'auto' }} />
        ) : (
          <span className="mono" style={{ fontSize: 22, fontWeight: 600 }}>
            {c.code}
          </span>
        )}
        <Chip tone={c.status === 'active' ? 'teal' : 'neutral'} icon={c.status === 'active' ? 'check' : 'ban'}>
          {c.status === 'active' ? t('companies.setUp') : t('common.inactive')}
        </Chip>
      </div>
      <h2 id={`co-${c.id}`} className="sf-card__title" style={{ margin: '14px 0 10px', fontSize: 17 }}>
        {c.name}
      </h2>
      <dl style={{ display: 'grid', gridTemplateColumns: '128px 1fr', gap: '6px 12px', margin: 0, fontSize: 13 }}>
        <dt className="muted">{t('companies.k.gstins')}</dt>
        <dd style={{ margin: 0 }}>
          {gstins.length === 0 ? (
            <span className="muted">{t('companies.noGstin')}</span>
          ) : (
            gstins.map((g) => (
              <div key={g.id}>
                <span className="mono">{g.gstin}</span> {g.trade_name ?? ''} {g.is_principal ? <span className="k">· {t('companies.principal')}</span> : null}
              </div>
            ))
          )}
        </dd>
        <dt className="muted">{t('companies.k.pan')}</dt>
        <dd className="mono" style={{ margin: 0 }}>
          {c.pan ?? '—'}
        </dd>
        <dt className="muted">{t('companies.k.address')}</dt>
        <dd style={{ margin: 0 }}>{c.registered_address ?? '—'}</dd>
        <dt className="muted">{t('companies.k.branches')}</dt>
        <dd className="mono" style={{ margin: 0 }}>
          {c.branch_count ?? 0}
        </dd>
        <dt className="muted">{t('companies.k.invoices')}</dt>
        <dd style={{ margin: 0 }}>
          {invoiceSeries.length === 0 ? (
            <span className="muted">{t('companies.noSeries')}</span>
          ) : (
            invoiceSeries.map((s) => (
              <div key={s.id} className="mono">
                {s.next_number}
              </div>
            ))
          )}
        </dd>
      </dl>
      <div className="sf-row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
        <Link to={routeForFile('Branches')} style={{ fontWeight: 600, fontSize: 13 }}>
          {t('companies.toBranches')}
        </Link>
        {onEdit ? (
          <Button size="sm" onClick={onEdit}>
            {t('common.edit')}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

