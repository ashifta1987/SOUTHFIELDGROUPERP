import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { api, makeErrorRef } from '@/shared/supabase'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice, todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { RuleErrorBox } from '@/features/sales/invoice/RuleErrorBox'
import { sumAmounts, type SalesDoc } from '@/features/sales/invoice/docs'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, KpiTiles, PageHeader, TaxClassChip, type Column } from '@/ui'
import { formatDate, formatIndian } from '@/shared/format'
import { RpcError } from '@/data/rpc'

/** Last day of a YYYY-MM month. */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/** Credit notes reduce sales: shown with a minus sign and netted in the footer. */
const signed = (r: SalesDoc, v: number) => (r.doc_type === 'credit_note' ? -v : v)

/**
 * Sales register (`SalesRegister` for Admin, `CompanyPortal` for the accountant): posted documents of one month
 * from api.sales_documents. Which rows arrive is decided by RLS for the signed-in user — bills without GST reach
 * only Admin and the CA; the browser never filters them. Footer totals are sums of the rows the server returned.
 */
export function SalesRegisterPage({ variant }: { variant: 'admin' | 'accountant' }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const seesAll = profile?.view === 'all' || profile?.view === 'all-readonly'
  const choice = useCompanyChoice()
  const [month, setMonth] = useState(() => todayIst().slice(0, 7))
  const range = /^\d{4}-\d{2}$/.test(month) ? monthRange(month) : null
  const companyId = choice.companyId
  const showKind = variant === 'admin' && seesAll

  const docs = useQuery<SalesDoc[], RpcError>({
    queryKey: ['api', 'sales_documents', 'register', companyId ?? '', month],
    enabled: Boolean(companyId && range),
    staleTime: 10_000,
    queryFn: async () => {
      const { data, error } = await api()
        .from('sales_documents')
        .select('*')
        .eq('company_id', companyId ?? '')
        .eq('status', 'posted')
        .gte('doc_date', range?.from ?? '')
        .lte('doc_date', range?.to ?? '')
        .order('doc_date', { ascending: false })
        .order('doc_no', { ascending: false })
        .limit(1000)
      if (error) throw new RpcError(error.message, makeErrorRef(), error.code, error.hint || undefined)
      return (data ?? []) as SalesDoc[]
    },
  })
  const receivables = useApiView('receivables', { eq: { company_id: companyId ?? '', kind: 'sales_document' }, limit: 5000, enabled: Boolean(companyId) })
  const openById = new Map(rowsOf(receivables).map((r) => [r.id ?? '', r.open_amount]))
  const rows = docs.data ?? []
  const withGst = rows.filter((r) => r.tax_class !== 'without_gst')
  const without = rows.filter((r) => r.tax_class === 'without_gst')
  const net = (list: SalesDoc[], pick: (r: SalesDoc) => number) => sumAmounts(list.map((r) => signed(r, pick(r))))

  const columns: Column<SalesDoc>[] = [
    { key: 'date', header: t('salesRegister.cols.date'), render: (r) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{formatDate(r.doc_date)}</span> },
    { key: 'no', header: t('salesRegister.cols.no'), render: (r) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{r.doc_no}</span> },
    { key: 'party', header: t('salesRegister.cols.customer'), render: (r) => r.party_name },
    { key: 'gstin', header: t('salesRegister.cols.gstin'), render: (r) => <span className="mono">{r.party_gstin ?? '—'}</span> },
    ...(showKind
      ? [
          {
            key: 'kind',
            header: t('salesRegister.cols.kind'),
            render: (r: SalesDoc) =>
              r.tax_class === 'without_gst' ? (
                <TaxClassChip taxClass="withoutGst" reason={r.lawful_reason ? t(`invoice.reasons.${r.lawful_reason}`) : null} />
              ) : (
                <Chip tone="info">{r.doc_type === 'credit_note' ? t('salesRegister.creditNote') : t('salesRegister.withGst')}</Chip>
              ),
          } satisfies Column<SalesDoc>,
        ]
      : []),
    { key: 'taxable', header: t('salesRegister.cols.taxable'), align: 'right', render: (r) => <Amount value={signed(r, Number(r.taxable))} /> },
    { key: 'tax', header: t('salesRegister.cols.tax'), align: 'right', render: (r) => <Amount value={signed(r, sumAmounts([r.cgst, r.sgst, r.igst]))} /> },
    { key: 'total', header: t('salesRegister.cols.total'), align: 'right', render: (r) => <Amount value={signed(r, Number(r.total))} /> },
    {
      key: 'open',
      header: t('salesRegister.cols.open'),
      render: (r) => {
        if (r.doc_type === 'credit_note') return <span className="muted">—</span>
        const open = openById.get(r.id)
        if (open === undefined || open === null) return <span className="muted">—</span>
        return Number(open) <= 0 ? (
          <Chip tone="success" icon="check">
            {t('salesRegister.settled')}
          </Chip>
        ) : (
          <span data-testid="open-amount">
            {t('salesRegister.openShort')} <Amount value={open} />
          </span>
        )
      },
    },
  ]

  const footer = rows.length ? (
    <tr>
      <td colSpan={showKind ? 5 : 4}>{t('salesRegister.footer', { count: rows.length })}</td>
      <td className="r">
        <Amount value={net(rows, (r) => Number(r.taxable))} />
      </td>
      <td className="r">
        <Amount value={net(rows, (r) => sumAmounts([r.cgst, r.sgst, r.igst]))} />
      </td>
      <td className="r" data-testid="register-total">
        <Amount value={net(rows, (r) => Number(r.total))} />
      </td>
      <td />
    </tr>
  ) : null

  const kpis = [
    { key: 'all', label: t('salesRegister.kpi.all', { count: rows.length }), value: <Amount value={net(rows, (r) => Number(r.total))} rupee digits={0} /> },
    ...(seesAll
      ? [
          { key: 'with', label: t('salesRegister.kpi.with', { count: withGst.length }), value: <Amount value={net(withGst, (r) => Number(r.total))} rupee digits={0} /> },
          { key: 'without', label: t('salesRegister.kpi.without', { count: without.length }), value: <Amount value={net(without, (r) => Number(r.total))} rupee digits={0} /> },
        ]
      : []),
  ]

  // Admin view: bills without GST grouped by customer (only rows RLS returned).
  const byCustomer = new Map<string, { name: string; count: number; total: number }>()
  for (const r of without) {
    const cur = byCustomer.get(r.party_id) ?? { name: r.party_name, count: 0, total: 0 }
    cur.count += 1
    cur.total = sumAmounts([cur.total, signed(r, Number(r.total))])
    byCustomer.set(r.party_id, cur)
  }
  const monthLabel = range ? new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(`${range.from}T12:00:00+05:30`)) : month

  return (
    <>
      <PageHeader
        title={t('salesRegister.title', { month: monthLabel })}
        subtitle={variant === 'admin' ? t('salesRegister.subtitleAdmin') : t('salesRegister.subtitleAccountant')}
        actions={
          <>
            <Button comingInPhase={9}>{t('salesRegister.export')}</Button>
            <Button variant="primary" onClick={() => navigate(`/sales/invoices${companyId ? `?company=${companyId}` : ''}`)}>
              {t('salesRegister.newBill')}
            </Button>
          </>
        }
      />

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ width: 200 }}>
          <Field label={t('salesRegister.month')} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} panelId="sales-register-panel" />
      </div>

      {choice.list.length === 0 && !choice.isLoading ? (
        <Card>
          <EmptyState title={t('salesRegister.noCompanyTitle')} body={t('salesRegister.noCompanyBody')} />
        </Card>
      ) : (
        <div id="sales-register-panel" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <KpiTiles items={kpis} ariaLabel={t('salesRegister.kpi.label')} />
          <div style={{ display: 'grid', gridTemplateColumns: seesAll && variant === 'admin' ? 'minmax(0, 1fr) 340px' : 'minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <TableCard title={t('salesRegister.tableTitle')} action={<span className="muted">{t('salesRegister.count', { count: rows.length })}</span>}>
              <DataTable
                caption={t('salesRegister.tableTitle')}
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                loading={docs.isLoading}
                error={docs.error ? <RuleErrorBox error={docs.error} /> : undefined}
                onRowClick={(r) => navigate(`/sales/invoices?company=${r.company_id}&doc=${r.id}`)}
                rowTone={(r) => (r.tax_class === 'without_gst' ? 'signal' : undefined)}
                footer={footer}
                minWidth={900}
                empty={<EmptyState title={t('salesRegister.emptyTitle')} body={t('salesRegister.emptyBody')} />}
              />
            </TableCard>
            {seesAll && variant === 'admin' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Card title={t('salesRegister.withoutByCustomer')}>
                  {byCustomer.size === 0 ? (
                    <p className="muted" style={{ margin: 0 }}>{t('salesRegister.noneWithout')}</p>
                  ) : (
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {[...byCustomer.entries()]
                        .sort((a, b) => b[1].total - a[1].total)
                        .map(([id, c]) => (
                          <li key={id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderTop: '1px solid var(--sf-line-faint)' }}>
                            <span>
                              {c.name} · {c.count}
                            </span>
                            <span className="mono">{formatIndian(c.total, 0)}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </Card>
                <Card title={t('salesRegister.sameForAccountant')}>
                  <p className="muted" style={{ margin: 0 }}>{t('salesRegister.sameForAccountantBody')}</p>
                </Card>
              </div>
            ) : null}
          </div>
          <Card title={t('salesRegister.whoSees.title')}>
            <p className="muted" style={{ marginTop: 0 }}>{variant === 'admin' ? t('salesRegister.whoSees.admin') : t('salesRegister.whoSees.accountant')}</p>
            <p className="muted" style={{ marginBottom: 0 }}>{t('salesRegister.whoSees.statements')}</p>
          </Card>
        </div>
      )}
    </>
  )
}
