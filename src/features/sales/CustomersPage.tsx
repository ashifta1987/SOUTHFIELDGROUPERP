import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { useCompanies, useCustomers, type CustomerRow } from '@/data/queries'
import { formatDate } from '@/shared/format'
import { ApiError, makeErrorRef } from '@/shared/supabase'
import { Amount, Button, Card, Chip, DataTable, EmptyState, ErrorRef, PageHeader, Tabs, type Column } from '@/ui'
import { routeForFile } from '@/app/flows'

/**
 * Customers register (`Customers`). Rows come from `api.customers` (master.parties, Phase 2), filtered by RLS for the
 * user's company scope and view. Add / Edit / Deactivate / Remove arrive with Customer KYC in Phase 2.
 */
export function CustomersPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const companies = useCompanies()
  const companyRows = companies.data?.status === 'ready' ? companies.data.data : []
  const [companyId, setCompanyId] = useState<string | undefined>(undefined)
  const activeCompany = companyId ?? companyRows[0]?.id
  const customers = useCustomers(activeCompany)
  const isAdmin = profile?.view === 'all'
  const readOnly = profile?.view === 'all-readonly'
  const notReady = customers.data?.status === 'not-ready'
  const rows = customers.data?.status === 'ready' ? customers.data.data : undefined
  const errRef = customers.error instanceof ApiError ? customers.error.ref : customers.error ? makeErrorRef() : null

  const columns: Column<CustomerRow>[] = [
    { key: 'name', header: t('customers.col.customer'), render: (r) => <strong>{r.name}</strong> },
    { key: 'how', header: t('customers.col.howPaid'), render: (r) => r.how_paid ?? '—' },
    { key: 'received', header: t('customers.col.received'), align: 'right', render: (r) => <Amount value={r.received_fy} /> },
    { key: 'payments', header: t('customers.col.payments'), align: 'right', render: (r) => <span className="mono">{r.payments_count ?? '—'}</span> },
    { key: 'last', header: t('customers.col.lastPaid'), render: (r) => <span className="mono">{r.last_paid_on ? formatDate(r.last_paid_on) : '—'}</span> },
    {
      key: 'status',
      header: t('customers.col.status'),
      render: (r) =>
        r.status === 'check' ? (
          <Chip tone="signal" icon="alert">
            {t('customers.status.check')}
          </Chip>
        ) : r.status === 'draft' ? (
          <Chip tone="info" icon="pencil">
            {r.status_note ?? t('customers.status.draft')}
          </Chip>
        ) : r.status === 'inactive' ? (
          <Chip tone="neutral" icon="ban">
            {t('customers.status.inactive')}
          </Chip>
        ) : (
          <Chip tone="teal" icon="check">
            {t('customers.status.active')}
          </Chip>
        ),
    },
  ]
  if (isAdmin) {
    columns.push({
      key: 'admin',
      header: t('customers.col.admin'),
      render: () => (
        <span className="sf-row" style={{ flexWrap: 'nowrap', gap: 6 }}>
          <Button size="sm" comingInPhase={2}>
            {t('common.edit')}
          </Button>
          <Button size="sm" comingInPhase={2}>
            {t('customers.deactivate')}
          </Button>
          <Button size="sm" variant="danger" comingInPhase={2}>
            {t('customers.remove')}
          </Button>
        </span>
      ),
    })
  }

  return (
    <>
      <PageHeader
        title={t('customers.title')}
        subtitle={notReady ? t('customers.subtitleEmpty') : t('customers.subtitle')}
        actions={
          readOnly ? null : (
            <>
              {isAdmin ? <Button comingInPhase={2}>{t('customers.editForm')}</Button> : null}
              <Button variant="primary" comingInPhase={2}>
                {t('customers.add')}
              </Button>
            </>
          )
        }
      />

      <div className="sf-row" style={{ justifyContent: 'space-between' }}>
        {companyRows.length > 0 ? (
          <Tabs
            variant="segmented"
            label={t('customers.companyTabs')}
            tabs={companyRows.map((c) => ({ key: c.id, label: c.name }))}
            value={activeCompany ?? ''}
            onChange={setCompanyId}
          />
        ) : (
          <span className="k">{t('customers.noCompanies')}</span>
        )}
        <span className="k">{isAdmin ? t('customers.adminNote') : readOnly ? t('views.readOnly') : t('customers.rightsNote')}</span>
      </div>

      {errRef ? <ErrorRef message={t('errors.loadFailed')} next={t('errors.tryAgain')} refId={errRef} /> : null}

      <Card pad={false}>
        <DataTable
          caption={t('customers.title')}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={customers.isLoading}
          minWidth={900}
          rowTone={(r) => (r.status === 'check' ? 'signal' : undefined)}
          empty={
            <EmptyState
              title={t('customers.emptyTitle')}
              body={notReady ? t('customers.emptyBodyPhase') : t('customers.emptyBody')}
              action={
                <a href={routeForFile('DataImport')} style={{ fontWeight: 600 }}>
                  {t('customers.emptyAction')}
                </a>
              }
            />
          }
        />
        <p className="sf-card__foot">{t('customers.foot')}</p>
      </Card>

      <div className="sf-grid-3">
        <Card title={t('customers.removeCard.title')}>
          <p>
            <strong>{t('customers.removeCard.noDocsLead')}</strong> {t('customers.removeCard.noDocs')}
          </p>
          <p>
            <strong>{t('customers.removeCard.withDocsLead')}</strong> {t('customers.removeCard.withDocs')}
          </p>
        </Card>
        <Card title={t('customers.editCard.title')}>
          <p>{t('customers.editCard.p1')}</p>
          <p>{t('customers.editCard.p2')}</p>
        </Card>
      </div>
    </>
  )
}
