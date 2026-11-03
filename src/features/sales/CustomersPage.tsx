import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { routeForFile } from '@/app/flows'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { PartyErrorBox } from '@/features/sales/customers/shared'
import { Button, Card, Chip, ConfirmDialog, DataTable, EmptyState, ErrorRef, PageHeader, Tabs, type Column } from '@/ui'
import { ApiError, makeErrorRef } from '@/shared/supabase'

type Customer = ViewRow<'customers'>
type Filter = 'all' | 'draft' | 'review' | 'active' | 'check' | 'inactive'
const FILTERS: Filter[] = ['all', 'draft', 'review', 'active', 'check', 'inactive']

/** Which status chip a customer row falls under (the view's status plus its KYC step). */
function bucket(r: Customer): Exclude<Filter, 'all'> {
  if (r.status === 'draft') return r.kyc_status === 'review' ? 'review' : 'draft'
  return (r.status as Exclude<Filter, 'all'>) ?? 'draft'
}

/**
 * Customers register (`Customers`). Rows come from api.customers (master.parties joined to the company), filtered by RLS.
 * Edit opens Customer KYC; Deactivate goes through api.upsert_party. There is no delete: a party with documents is
 * deactivated or merged, so Remove stays disabled with the reason.
 */
export function CustomersPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const can = useCan()
  const { list: companies, company, companyId, choose, isLoading: companiesLoading } = useCompanyChoice()
  const customers = useApiView('customers', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) })
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_party', [['api', 'customers'], ['api', 'parties']])
  const [filter, setFilter] = useState<Filter>('all')
  const [confirm, setConfirm] = useState<{ row: Customer; to: 'inactive' | 'active' } | null>(null)

  const readOnly = profile?.view === 'all-readonly'
  const isAdmin = profile?.view === 'all'
  const canEdit = !readOnly && can('sales.edit')
  const canCreate = !readOnly && can('sales.create')
  const rows = rowsOf(customers)
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, draft: 0, review: 0, active: 0, check: 0, inactive: 0 }
    for (const r of rows) c[bucket(r)] += 1
    return c
  }, [rows])
  const shown = filter === 'all' ? rows : rows.filter((r) => bucket(r) === filter)
  const errRef = customers.error instanceof ApiError ? customers.error.ref : customers.error ? makeErrorRef() : null
  const kycHref = (partyId?: string) => {
    const q = new URLSearchParams()
    if (partyId) q.set('party', partyId)
    if (companyId) q.set('company', companyId)
    return `${routeForFile('CustomerKYC')}?${q.toString()}`
  }

  const columns: Column<Customer>[] = [
    {
      key: 'name',
      header: t('customersList.col.customer'),
      render: (r) => (
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <strong>{r.name}</strong>
          {r.gstin || r.trade_name ? (
            <span className="k">
              {r.trade_name ?? ''}
              {r.trade_name && r.gstin ? ' · ' : ''}
              {r.gstin ? <span className="mono">{r.gstin}</span> : null}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'how', header: t('customersList.col.howPaid'), render: (r) => r.how_paid ?? <span className="muted">—</span> },
    { key: 'received', header: t('customersList.col.received'), align: 'right', render: () => <span className="mono muted">—</span> },
    { key: 'payments', header: t('customersList.col.payments'), align: 'right', render: (r) => <span className="mono muted">{r.payments_count ?? '—'}</span> },
    { key: 'last', header: t('customersList.col.lastPaid'), render: () => <span className="mono muted">—</span> },
    { key: 'status', header: t('customersList.col.status'), render: (r) => <CustomerStatus row={r} /> },
  ]
  if (canEdit) {
    columns.push({
      key: 'admin',
      header: t('customersList.col.admin'),
      render: (r) => (
        <span className="sf-row" style={{ flexWrap: 'nowrap', gap: 6 }}>
          <Link className="sf-btn" data-variant="secondary" data-size="sm" to={kycHref(r.id)} aria-label={t('customersList.editAria', { name: r.name })}>
            {t('customersList.edit')}
          </Link>
          {r.status === 'inactive' ? (
            <Button size="sm" onClick={() => openConfirm(r, 'active')} aria-label={t('customersList.reactivateAria', { name: r.name })}>
              {t('customersList.reactivate')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => openConfirm(r, 'inactive')} aria-label={t('customersList.deactivateAria', { name: r.name })}>
              {t('customersList.deactivate')}
            </Button>
          )}
          <Button size="sm" variant="danger" disabled title={t('customersList.removeDisabled')} aria-label={t('customersList.removeAria', { name: r.name })}>
            {t('customersList.remove')}
          </Button>
        </span>
      ),
    })
  }

  function openConfirm(row: Customer, to: 'inactive' | 'active') {
    save.reset()
    setConfirm({ row, to })
  }
  function doConfirm() {
    if (!confirm) return
    save.mutate({ p: { id: confirm.row.id, status: confirm.to, is_customer: true } }, { onSuccess: () => setConfirm(null) })
  }

  const companyName = company ? company.short_name || company.name : ''

  return (
    <>
      <PageHeader
        title={t('customersList.title')}
        subtitle={company && customers.data?.status === 'ready' ? t('customersList.subtitle', { company: companyName, count: rows.length }) : t('customersList.subtitleNone')}
        actions={
          readOnly ? null : (
            <>
              {isAdmin ? (
                <Link className="sf-btn" data-variant="secondary" to={routeForFile('FormFields')}>
                  {t('customersList.editForm')}
                </Link>
              ) : null}
              {canCreate ? (
                <Link className="sf-btn" data-variant="primary" to={kycHref()}>
                  {t('customersList.add')}
                </Link>
              ) : null}
            </>
          )
        }
      />

      <div className="sf-row" style={{ justifyContent: 'space-between' }}>
        <CompanyPicker list={companies} value={companyId} onChange={choose} />
        <span className="k">{isAdmin ? t('customersList.adminNote') : readOnly ? t('views.readOnly') : canEdit ? t('customersList.rightsNote') : t('customersList.viewOnly')}</span>
      </div>

      {!companiesLoading && companies.length === 0 ? (
        <Card>
          <EmptyState title={t('customersList.emptyTitle')} body={t('customersList.noCompanies')} />
        </Card>
      ) : (
        <>
          <div style={{ display: 'flex' }}>
            <Tabs label={t('customersList.statusFilter')} value={filter} onChange={setFilter} tabs={FILTERS.map((f) => ({ key: f, label: `${t(`customersList.filter.${f}`)} ${counts[f]}` }))} />
          </div>

          {errRef ? <ErrorRef message={t('errors.loadFailed')} next={t('errors.tryAgain')} refId={errRef} /> : null}

          <Card pad={false}>
            <DataTable
              caption={t('customersList.title')}
              columns={columns}
              rows={shown}
              rowKey={(r) => r.id}
              loading={customers.isLoading || companiesLoading}
              minWidth={980}
              rowTone={(r) => (r.status === 'check' ? 'signal' : undefined)}
              empty={
                rows.length > 0 ? (
                  <EmptyState title={t('customersList.emptyFiltered')} />
                ) : (
                  <EmptyState
                    title={t('customersList.emptyTitle')}
                    body={t('customersList.emptyBody')}
                    action={
                      canCreate ? (
                        <Link className="sf-btn" data-variant="primary" to={kycHref()}>
                          {t('customersList.add')}
                        </Link>
                      ) : isAdmin ? (
                        <Link to={routeForFile('DataImport')} style={{ fontWeight: 600 }}>
                          {t('customersList.emptyAction')}
                        </Link>
                      ) : null
                    }
                  />
                )
              }
            />
            <p className="sf-card__foot">
              {t('customersList.foot')} {t('customersList.fromReceipts')}
            </p>
          </Card>
        </>
      )}

      <div className="sf-grid-3">
        <Card title={t('customersList.removeCard.title')}>
          <p>
            <strong>{t('customersList.removeCard.noDocsLead')}</strong> {t('customersList.removeCard.noDocs')}
          </p>
          <p>
            <strong>{t('customersList.removeCard.withDocsLead')}</strong> {t('customersList.removeCard.withDocs')}
          </p>
          <p className="k" style={{ marginBottom: 0 }}>
            {t('customersList.removeCard.now')}
          </p>
        </Card>
        <Card title={t('customersList.editCard.title')}>
          <p>{t('customersList.editCard.p1')}</p>
          <p style={{ marginBottom: 0 }}>{t('customersList.editCard.p2')}</p>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm ? t(confirm.to === 'inactive' ? 'customersList.confirmDeactivate.title' : 'customersList.confirmReactivate.title', { name: confirm.row.name }) : ''}
        effect={
          <>
            {confirm?.to === 'inactive' ? t('customersList.confirmDeactivate.effect') : t('customersList.confirmReactivate.effect')}
            <PartyErrorBox error={save.error} />
          </>
        }
        confirmLabel={confirm?.to === 'inactive' ? t('customersList.confirmDeactivate.confirm') : t('customersList.confirmReactivate.confirm')}
        onConfirm={doConfirm}
        busy={save.isPending}
        danger={confirm?.to === 'inactive'}
      />
    </>
  )
}

function CustomerStatus({ row }: { row: Customer }) {
  const { t } = useTranslation()
  const b = bucket(row)
  if (b === 'check')
    return (
      <Chip tone="signal" icon="alert">
        {t('customersList.status.check')}
      </Chip>
    )
  if (b === 'inactive')
    return (
      <Chip tone="neutral" icon="ban">
        {t('customersList.status.inactive')}
      </Chip>
    )
  if (b === 'active')
    return (
      <Chip tone="teal" icon="check">
        {t('customersList.status.active')}
      </Chip>
    )
  if (b === 'review')
    return (
      <Chip tone="signal" icon="clock">
        {t('customersList.status.review')}
      </Chip>
    )
  return (
    <Chip tone="info" icon="pencil">
      {t('customersList.status.draft')}
    </Chip>
  )
}
