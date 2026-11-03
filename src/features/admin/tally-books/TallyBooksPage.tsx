import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { routeForFile } from '@/app/flows'
import { api } from '@/shared/supabase'
import { formatDate, formatIndian } from '@/shared/format'
import { Card, Chip, DataTable, EmptyState, KpiTiles, PageHeader, Skeleton, type Column } from '@/ui'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { BatchStatus } from '@/features/admin/import-data/ImportHistory'
import { ChartOfAccounts, GroupMapping } from './ChartOfAccounts'
import { AccountsCard, OpenBillsCard } from './OpeningBalances'
import { TableCard, TWO_COLS } from '@/features/admin/import-data/layout'

type Batch = ViewRow<'import_batches'>
type KeyCount = ViewRow<'source_key_counts'>

/** Vouchers loaded from Tally for a company, counted by the server (tally_vouchers is Admin/CA only by RLS). */
function useVoucherCount(companyId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['api', 'tally_vouchers', 'count', companyId ?? ''],
    enabled: Boolean(companyId) && enabled,
    staleTime: 10_000,
    queryFn: async () => {
      const { count, error } = await api().from('tally_vouchers').select('id', { count: 'exact', head: true }).eq('company_id', companyId as string)
      if (error) throw new Error(error.message)
      return count ?? 0
    },
  })
}

/**
 * Tally books (`TallyBiochem`, `TallyPlastics`): what one company's Tally load brought in — batches, records read,
 * the chart of accounts and Tally group mapping, accounts with opening balances, opening bills and loaded vouchers.
 * The company is the one whose logo_key matches the page (or the one picked); every figure comes from api views.
 */
export function TallyBooksPage({ logoKey }: { logoKey: 'biochem' | 'plastics' }) {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const isAdmin = profile?.view === 'all'
  const readOnly = profile?.view === 'all-readonly'
  const canSee = isAdmin || readOnly || can('accounts.view') || can('data.import')
  const canManage = can('settings.manage') && !readOnly
  const canImport = can('data.import') && !readOnly

  const companies = useApiView('companies', { order: 'code' })
  const [params, setParams] = useSearchParams()
  const list = rowsOf(companies)
  const wanted = params.get('company')
  const company = list.find((c) => c.id === wanted) ?? list.find((c) => c.logo_key === logoKey) ?? list.find((c) => c.status === 'active') ?? list[0]
  const companyId = company?.id

  function choose(id: string) {
    const next = new URLSearchParams(params)
    next.set('company', id)
    setParams(next, { replace: true })
  }

  const batches = useApiView('import_batches', { order: 'created_at', ascending: false, eq: { company_id: companyId }, limit: 50, enabled: Boolean(companyId) && canSee })
  const keys = useApiView('source_key_counts', { order: 'object_type', eq: { company_id: companyId }, enabled: Boolean(companyId) && canSee })
  const mapBugs = useApiView('bug_items', { order: 'created_at', eq: { company_id: companyId, kind: 'map_head', status: 'open' }, limit: 200, enabled: Boolean(companyId) && canSee })
  const vouchers = useVoucherCount(companyId, isAdmin || readOnly)

  const batchList = rowsOf(batches)
  const keyList = rowsOf(keys)
  const n = (type: string) => keyList.find((k) => k.object_type === type)?.n ?? 0
  const last = batchList[0]
  const name = company?.short_name || company?.name || ''

  if (!canSee) {
    return (
      <>
        <PageHeader title={t('tallyBooks.titleNoCompany')} />
        <Card>
          <p className="muted" style={{ margin: 0 }}>
            {t('tallyBooks.noRight')}
          </p>
        </Card>
      </>
    )
  }

  const batchCols: Column<Batch>[] = [
    { key: 'code', header: t('tallyBooks.batches.code'), render: (b) => <span className="mono">{b.code}</span> },
    { key: 'file', header: t('tallyBooks.batches.file'), render: (b) => <span style={{ overflowWrap: 'anywhere' }}>{b.file_name ?? '—'}</span> },
    { key: 'rows', header: t('tallyBooks.batches.rows'), align: 'right', render: (b) => <span className="mono">{formatIndian(b.row_count ?? 0, 0)}</span> },
    { key: 'bugs', header: t('tallyBooks.batches.bugs'), align: 'right', render: (b) => <span className="mono">{b.open_bugs ?? 0}</span> },
    { key: 'status', header: t('tallyBooks.batches.status'), render: (b) => <BatchStatus status={b.status} /> },
    { key: 'when', header: t('tallyBooks.batches.when'), render: (b) => <span className="mono">{formatDate(b.created_at)}</span> },
  ]
  const keyCols: Column<KeyCount>[] = [
    { key: 'type', header: t('tallyBooks.read.type'), render: (k) => t(`importData.object.${k.object_type}`, { defaultValue: k.object_type }) },
    { key: 'n', header: t('tallyBooks.read.count'), align: 'right', render: (k) => <span className="mono">{formatIndian(k.n ?? 0, 0)}</span> },
    { key: 'alter', header: t('tallyBooks.read.alter'), align: 'right', render: (k) => <span className="mono">{k.max_alter_id ?? '—'}</span> },
  ]

  return (
    <>
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {company ? t('tallyBooks.title', { name }) : t('tallyBooks.titleNoCompany')}
            <Chip tone="neutral">{t('tallyBooks.adminOnly')}</Chip>
          </span>
        }
        subtitle={last ? t('tallyBooks.subtitleLast', { code: last.code, date: formatDate(last.created_at), batches: batchList.length }) : t('tallyBooks.subtitle')}
        actions={
          canImport ? (
            <Link className="sf-btn" data-variant="primary" to={`${routeForFile('DataImport')}${companyId ? `?company=${companyId}` : ''}`}>
              {t('tallyBooks.plan')}
            </Link>
          ) : null
        }
      />

      {companies.isLoading ? (
        <Card>
          <Skeleton height={100} />
        </Card>
      ) : !company ? (
        <Card>
          <EmptyState title={t('tallyBooks.noCompany')} />
        </Card>
      ) : (
        <>
          <div style={{ marginBottom: 16 }}>
            <CompanyPicker list={list} value={companyId} onChange={choose} />
          </div>
          {readOnly ? (
            <p className="muted" style={{ margin: '0 0 16px' }}>
              {t('tallyBooks.readOnly')}
            </p>
          ) : null}

          <div style={{ marginBottom: 16 }}>
            <KpiTiles
              ariaLabel={t('tallyBooks.kpi.label')}
              items={[
                { key: 'ledgers', label: t('tallyBooks.kpi.ledgers'), value: <span className="mono">{formatIndian(n('ledger'), 0)}</span>, sub: t('tallyBooks.kpi.fromTally') },
                { key: 'groups', label: t('tallyBooks.kpi.groups'), value: <span className="mono">{formatIndian(n('group'), 0)}</span>, sub: t('tallyBooks.kpi.fromTally') },
                { key: 'items', label: t('tallyBooks.kpi.items'), value: <span className="mono">{formatIndian(n('stock_item'), 0)}</span>, sub: t('tallyBooks.kpi.fromTally') },
                {
                  key: 'vouchers',
                  label: t('tallyBooks.kpi.vouchers'),
                  value: isAdmin || readOnly ? <span className="mono">{vouchers.data === undefined ? '—' : formatIndian(vouchers.data, 0)}</span> : '—',
                  sub: t('tallyBooks.kpi.adminCa'),
                },
                { key: 'waiting', label: t('tallyBooks.kpi.waiting'), value: <span className="mono">{rowsOf(mapBugs).length}</span>, sub: t('tallyBooks.kpi.toMap') },
              ]}
            />
          </div>

          <div style={TWO_COLS}>
            <TableCard title={t('tallyBooks.batches.title')}>
              <DataTable
                caption={t('tallyBooks.batches.caption')}
                columns={batchCols}
                rows={batchList}
                rowKey={(b) => b.id}
                loading={batches.isLoading}
                minWidth={560}
                error={batches.error ? t('errors.loadFailed') : undefined}
                empty={<EmptyState title={t('tallyBooks.batches.empty')} />}
              />
            </TableCard>
            <TableCard title={t('tallyBooks.read.title')}>
              <DataTable
                caption={t('tallyBooks.read.caption')}
                columns={keyCols}
                rows={keyList}
                rowKey={(k) => k.object_type}
                loading={keys.isLoading}
                minWidth={360}
                error={keys.error ? t('errors.loadFailed') : undefined}
                empty={<EmptyState title={t('tallyBooks.read.empty')} />}
              />
            </TableCard>
          </div>

          <div style={TWO_COLS}>
            <ChartOfAccounts companyId={company.id} canManage={canManage} />
            <GroupMapping companyId={company.id} canManage={canManage} canImport={canImport} batches={batchList} />
          </div>

          <div style={{ display: 'grid', gap: 16 }}>
            <AccountsCard companyId={company.id} />
            <OpenBillsCard companyId={company.id} isAdmin={isAdmin} />
          </div>
        </>
      )}
    </>
  )
}
