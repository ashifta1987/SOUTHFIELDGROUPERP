import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { fromPaise, sumPaise, toPaise } from '@/features/accounts/cash-book/money'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, KpiTiles, PageHeader, Skeleton, StatusChip, Tabs, type Column } from '@/ui'
import { BillEditor, emptyDraft, EMPTY_LINE, type BillDraft } from './BillEditor'
import { PaymentEntry, PaymentList, usePayables } from './Payments'

type Tab = 'bills' | 'payables' | 'payments'
type Bill = ViewRow<'purchase_bills'>
type Payable = ViewRow<'payables'>

/**
 * Bills and payments (/purchase/bills-and-payments): supplier bills entered with the tax the server works out and
 * posted to the books (api.save_purchase_draft / api.post_purchase_bill), what is owed to suppliers (api.payables,
 * MSME bills flagged), and payments set against bills (api.post_payment, cash limits applied by the server).
 */
export function BillsPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'payables' ? 'payables' : params.get('tab') === 'payments' ? 'payments' : 'bills'
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const [payParty, setPayParty] = useState('')

  function setTab(k: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }

  const canBill = !readOnly && can('purchase_bills.create')
  const canCash = !readOnly && can('cash_book.create')
  const canBank = !readOnly && can('receipts_payments.create')
  const canReverse = !readOnly && can('accounts.cancel')

  return (
    <>
      <PageHeader title={t('bills.title')} subtitle={t('bills.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <Tabs
          label={t('bills.tabs')}
          value={tab}
          onChange={setTab}
          controls="bills-panel"
          idBase="bills"
          tabs={[
            { key: 'bills', label: t('bills.tabBills') },
            { key: 'payables', label: t('bills.tabPayables') },
            { key: 'payments', label: t('bills.tabPayments') },
          ]}
        />
        <CompanyPicker list={list} value={companyId} onChange={choose} />
      </div>
      <div id="bills-panel" role="tabpanel" aria-labelledby={`bills-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {isLoading ? (
          <Card>
            <Skeleton height={80} />
          </Card>
        ) : !companyId ? (
          <Card>
            <EmptyState title={t('bills.noCompany')} />
          </Card>
        ) : tab === 'bills' ? (
          <BillsTab key={companyId} companyId={companyId} canBill={canBill} />
        ) : tab === 'payables' ? (
          <PayablesTab
            companyId={companyId}
            canPay={canCash || canBank}
            onPay={(partyId) => {
              setPayParty(partyId)
              setTab('payments')
            }}
          />
        ) : (
          <>
            {canCash || canBank ? (
              <PaymentEntry key={companyId} companyId={companyId} canCash={canCash} canBank={canBank} partyId={payParty} setPartyId={setPayParty} />
            ) : (
              <p className="muted">{readOnly ? t('bills.readOnly') : t('bills.noPayRight')}</p>
            )}
            <PaymentList companyId={companyId} canReverse={canReverse} />
          </>
        )}
      </div>
    </>
  )
}

function BillsTab({ companyId, canBill }: { companyId: string; canBill: boolean }) {
  const { t } = useTranslation()
  const q = useApiView('purchase_bills', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 200 })
  const rows = rowsOf(q)
  const [draft, setDraft] = useState<BillDraft>(emptyDraft())
  const [posted, setPosted] = useState<string | null>(null)
  const [opening, setOpening] = useState<Bill | null>(null)

  const columns: Column<Bill>[] = [
    { key: 'date', header: t('bills.list.date'), render: (b) => <span className="mono">{formatDate(b.bill_date)}</span> },
    {
      key: 'no',
      header: t('bills.list.no'),
      render: (b) => (
        <div>
          <div className="mono" style={{ fontWeight: 600 }}>
            {b.doc_no ?? '—'}
          </div>
          <div className="k mono">{t('bills.list.supplierNo', { no: b.supplier_bill_no })}</div>
        </div>
      ),
    },
    { key: 'party', header: t('bills.list.supplier'), render: (b) => b.party_name },
    { key: 'due', header: t('bills.list.due'), render: (b) => (b.due_date ? <span className="mono">{formatDate(b.due_date)}</span> : '—') },
    { key: 'tax', header: t('bills.list.tax'), align: 'right', render: (b) => <Amount value={fromPaise(toPaise(b.cgst) + toPaise(b.sgst) + toPaise(b.igst))} /> },
    { key: 'total', header: t('bills.list.total'), align: 'right', render: (b) => <Amount value={b.total} /> },
    { key: 'settled', header: t('bills.list.settled'), align: 'right', render: (b) => <Amount value={b.settled} /> },
    {
      key: 'status',
      header: t('common.status'),
      render: (b) => (
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {b.status === 'draft' ? <StatusChip status="draft" /> : b.status === 'cancelled' ? <Chip tone="neutral">{t('bills.status.cancelled')}</Chip> : <StatusChip status="posted" />}
          {b.msme_due ? <Chip tone="signal">{t('bills.payables.msmeChip')}</Chip> : null}
        </span>
      ),
    },
    {
      key: 'act',
      header: <span className="sr-only">{t('bills.list.actions')}</span>,
      render: (b) =>
        canBill && b.status === 'draft' ? (
          <Button size="sm" variant="link" busy={opening?.id === b.id} aria-label={t('bills.list.openAria', { no: b.supplier_bill_no })} onClick={() => setOpening(b)}>
            {t('bills.list.open')}
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      {posted ? (
        <div className="sf-alert" data-tone="success" role="status">
          {t('bills.editor.posted', { no: posted })}
        </div>
      ) : null}
      {canBill ? (
        <BillEditor
          companyId={companyId}
          draft={draft}
          setDraft={setDraft}
          onDone={(no) => {
            setPosted(no)
            setDraft(emptyDraft())
          }}
        />
      ) : (
        <p className="muted">{t('bills.noBillRight')}</p>
      )}
      {opening ? (
        <DraftLoader
          bill={opening}
          onLoad={(d) => {
            setPosted(null)
            setDraft(d)
            setOpening(null)
          }}
        />
      ) : null}
      <TableCard title={t('bills.list.title')}>
        <DataTable caption={t('bills.list.title')} columns={columns} rows={rows} rowKey={(b) => b.id} loading={q.isLoading} minWidth={900} empty={<EmptyState title={t('bills.list.emptyTitle')} body={t('bills.list.emptyBody')} />} />
      </TableCard>
    </>
  )
}

/** Reads a draft bill's lines (api.purchase_bill_lines) and hands the bill to the editor. */
function DraftLoader({ bill, onLoad }: { bill: Bill; onLoad: (d: BillDraft) => void }) {
  const lines = useApiView('purchase_bill_lines', { eq: { bill_id: bill.id }, order: 'line_no' })
  const ready = lines.data?.status === 'ready'
  useEffect(() => {
    if (!ready) return
    const ls = rowsOf(lines)
    onLoad({
      id: bill.id,
      party_id: bill.party_id,
      gstin_id: bill.gstin_id,
      supplier_bill_no: bill.supplier_bill_no,
      supplier_bill_date: bill.supplier_bill_date,
      bill_date: bill.bill_date,
      itc_eligible: bill.itc_eligible,
      reverse_charge: bill.reverse_charge,
      lines: ls.length
        ? ls.map((l) => ({
            kind: l.product_id ? ('product' as const) : ('account' as const),
            product_id: l.product_id ?? '',
            account_id: l.account_id ?? '',
            description: l.description ?? '',
            hsn_code: l.hsn_code ?? '',
            qty: String(l.qty),
            rate: String(l.rate),
            discount: Number(l.discount) ? String(l.discount) : '',
          }))
        : [{ ...EMPTY_LINE }],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  return null
}

function PayablesTab({ companyId, canPay, onPay }: { companyId: string; canPay: boolean; onPay: (partyId: string) => void }) {
  const { t } = useTranslation()
  const p = usePayables(companyId)
  const msme = p.list.filter((b) => b.msme_due)
  const overdue = p.list.filter((b) => Number(b.days_overdue) > 0)
  const columns: Column<Payable>[] = [
    { key: 'party', header: t('bills.payables.supplier'), render: (b) => b.party_name ?? '—' },
    { key: 'ref', header: t('bills.payables.ref'), render: (b) => <span className="mono">{b.bill_ref ?? '—'}</span> },
    { key: 'date', header: t('bills.payables.date'), render: (b) => (b.bill_date ? <span className="mono">{formatDate(b.bill_date)}</span> : '—') },
    { key: 'due', header: t('bills.payables.due'), render: (b) => (b.due_date ? <span className="mono">{formatDate(b.due_date)}</span> : '—') },
    {
      key: 'late',
      header: t('bills.payables.overdue'),
      align: 'right',
      render: (b) => (Number(b.days_overdue) > 0 ? <Chip tone="danger">{t('bills.payables.days', { count: Number(b.days_overdue) })}</Chip> : <span className="muted">{t('bills.payables.notDue')}</span>),
    },
    { key: 'msme', header: t('bills.payables.msme'), render: (b) => (b.msme_due ? <Chip tone="signal">{t('bills.payables.msmeChip')}</Chip> : null) },
    { key: 'amount', header: t('bills.payables.amount'), align: 'right', render: (b) => <Amount value={b.amount} /> },
    { key: 'open', header: t('bills.payables.open'), align: 'right', render: (b) => <Amount value={b.open_amount} /> },
    {
      key: 'act',
      header: <span className="sr-only">{t('bills.list.actions')}</span>,
      render: (b) =>
        canPay && b.party_id ? (
          <Button size="sm" aria-label={t('bills.payables.payAria', { ref: b.bill_ref ?? '', supplier: b.party_name ?? '' })} onClick={() => onPay(b.party_id ?? '')}>
            {t('bills.payables.pay')}
          </Button>
        ) : null,
    },
  ]
  return (
    <>
      <KpiTiles
        ariaLabel={t('bills.payables.kpis')}
        items={[
          { key: 'all', label: t('bills.payables.kpiOpen', { n: p.list.length }), value: <Amount value={fromPaise(sumPaise(p.list, (b) => b.open_amount))} rupee /> },
          { key: 'over', label: t('bills.payables.kpiOverdue', { n: overdue.length }), value: <Amount value={fromPaise(sumPaise(overdue, (b) => b.open_amount))} rupee /> },
          { key: 'msme', label: t('bills.payables.kpiMsme', { n: msme.length }), value: <Amount value={fromPaise(sumPaise(msme, (b) => b.open_amount))} rupee />, sub: t('bills.payables.msmeSub') },
        ]}
      />
      <TableCard title={t('bills.payables.title')}>
        <DataTable
          caption={t('bills.payables.title')}
          columns={columns}
          rows={p.list}
          rowKey={(b) => `${b.kind}-${b.id}`}
          loading={p.isLoading}
          minWidth={900}
          rowTone={(b) => (b.msme_due && Number(b.days_overdue) > 0 ? 'signal' : undefined)}
          empty={<EmptyState title={t('bills.payables.emptyTitle')} body={t('bills.payables.emptyBody')} />}
        />
      </TableCard>
    </>
  )
}
