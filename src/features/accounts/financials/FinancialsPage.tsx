import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import type { RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { fromPaise, fyStartOf, sumPaise, toPaise, useCompanyAccounts, useCompanyParties, useReadRpc } from '@/features/accounts/cash-book/money'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Card, Checkbox, Chip, DataTable, EmptyState, ErrorRef, Field, KeyValue, PageHeader, SelectField, Skeleton, Tabs, type Column } from '@/ui'

type Num = number | string | null
export interface TbRow {
  account_id: string
  account_name: string
  group_name: string
  nature: string
  opening: Num
  dr: Num
  cr: Num
  closing: Num
}
interface LedgerRow {
  entry_date: string | null
  doc_no: string | null
  voucher_type: string
  narration: string | null
  dr: Num
  cr: Num
  balance: Num
  voucher_id: string | null
}
interface Statement {
  party: { id: string; name: string; gstin: string | null }
  opening: Num
  closing: Num
  lines: { date: string; doc_no: string | null; type: string; dr: Num; cr: Num; balance: Num }[]
  ageing: Record<string, Num> | null
}
type TabKey = 'tb' | 'ledger' | 'statement'

/** A signed balance (debit positive) shown as an amount with Dr / Cr. */
function DrCr({ value }: { value: Num }) {
  const p = toPaise(value)
  if (p === 0) return <span className="sf-amount">0.00</span>
  return (
    <span className="sf-amount">
      {formatIndian(fromPaise(Math.abs(p)))} {p > 0 ? 'Dr' : 'Cr'}
    </span>
  )
}

/**
 * Financials (`Reports`, /accounts/financials): the trial balance of a company for a period (api.trial_balance), the
 * ledger of any account behind it (api.account_ledger, opened by clicking an account) and a party's statement of
 * account (api.statement_of_account — refused to a GST-view user when the party has bills without GST). The
 * statements of profit and loss and the balance sheet are on Schedule III statements. Rows decide what the user sees
 * (RLS): Admin and the CA all transactions, others the GST books. Only server rows are added up here, for display.
 */
export function FinancialsPage() {
  const { t } = useTranslation()
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as TabKey | null) ?? 'tb'
  const setTab = (k: TabKey) => {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }
  const [from, setFrom] = useState(fyStartOf(todayIst()))
  const [to, setTo] = useState(todayIst())
  const [accountId, setAccountId] = useState('')

  return (
    <>
      <PageHeader title={t('financials.title')} subtitle={t('financials.subtitle')} />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <CompanyPicker list={list} value={companyId} onChange={choose} />
        <div style={{ width: 170 }}>
          <Field label={t('common.from')} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div style={{ width: 170 }}>
          <Field label={t('common.to')} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      {isLoading ? <Skeleton height={80} /> : null}
      {!isLoading && list.length === 0 ? <EmptyState title={t('financials.noCompany')} /> : null}

      {companyId ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, alignItems: 'start' }}>
          <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
            <Tabs<TabKey>
              label={t('financials.tabsLabel')}
              value={tab}
              onChange={setTab}
              idBase="fin"
              controls="fin-panel"
              tabs={[
                { key: 'tb', label: t('financials.tab.tb') },
                { key: 'ledger', label: t('financials.tab.ledger') },
                { key: 'statement', label: t('financials.tab.statement') },
              ]}
            />
            <div id="fin-panel" role="tabpanel" aria-labelledby={`fin-tab-${tab}`}>
              {tab === 'tb' ? (
                <TrialBalance
                  companyId={companyId}
                  from={from}
                  to={to}
                  onOpen={(id) => {
                    setAccountId(id)
                    setTab('ledger')
                  }}
                />
              ) : null}
              {tab === 'ledger' ? <Ledger companyId={companyId} from={from} to={to} accountId={accountId} onAccount={setAccountId} /> : null}
              {tab === 'statement' ? <StatementTab companyId={companyId} from={from} to={to} /> : null}
            </div>
          </div>
          <aside style={{ display: 'grid', gap: 16 }}>
            <Card title={t('financials.whoTitle')}>
              <p style={{ margin: 0, fontSize: 13 }}>{t('financials.whoAdmin')}</p>
              <p style={{ margin: '8px 0 0', fontSize: 13 }}>{t('financials.whoOthers')}</p>
              <p style={{ margin: '8px 0 0', fontSize: 13 }}>{t('financials.whoCa')}</p>
            </Card>
            <Card title={t('financials.statementsTitle')}>
              <p style={{ margin: 0, fontSize: 13 }}>{t('financials.statementsBody')}</p>
              <p style={{ margin: '8px 0 0', fontSize: 13 }}>
                <Link to={`/accounts/schedule-iii-statements?company=${companyId}`}>{t('financials.statementsLink')}</Link>
              </p>
            </Card>
          </aside>
        </div>
      ) : null}
    </>
  )
}

/* ─────────── Trial balance ─────────── */
function TrialBalance({ companyId, from, to, onOpen }: { companyId: string; from: string; to: string; onOpen: (accountId: string) => void }) {
  const { t } = useTranslation()
  const q = useReadRpc<TbRow[]>('trial_balance', { p_company_id: companyId, p_from: from, p_to: to })
  const [hideZero, setHideZero] = useState(true)
  const all = q.data ?? []
  const rows = hideZero ? all.filter((r) => toPaise(r.opening) !== 0 || toPaise(r.dr) !== 0 || toPaise(r.cr) !== 0 || toPaise(r.closing) !== 0) : all
  const dr = sumPaise(all, (r) => r.dr)
  const cr = sumPaise(all, (r) => r.cr)
  const closingDr = all.reduce((s, r) => s + Math.max(0, toPaise(r.closing)), 0)
  const closingCr = all.reduce((s, r) => s + Math.max(0, -toPaise(r.closing)), 0)
  const diff = closingDr - closingCr

  const cols: Column<TbRow>[] = [
    {
      key: 'acc',
      header: t('financials.col.account'),
      render: (r) => (
        <button type="button" onClick={() => onOpen(r.account_id)} title={t('financials.openLedger', { name: r.account_name })} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', minHeight: 24, color: 'var(--sf-primary)', textDecoration: 'underline' }}>
          {r.account_name}
        </button>
      ),
    },
    { key: 'group', header: t('financials.col.group'), render: (r) => <span className="muted">{`${r.group_name} · ${t(`financials.nature.${r.nature}`, { defaultValue: r.nature })}`}</span> },
    { key: 'open', header: t('financials.col.opening'), align: 'right', render: (r) => <DrCr value={r.opening} /> },
    { key: 'dr', header: t('financials.col.dr'), align: 'right', render: (r) => <Amount value={r.dr} /> },
    { key: 'cr', header: t('financials.col.cr'), align: 'right', render: (r) => <Amount value={r.cr} /> },
    { key: 'close', header: t('financials.col.closing'), align: 'right', render: (r) => <DrCr value={r.closing} /> },
  ]
  return (
    <TableCard
      title={t('financials.tbTitle')}
      action={
        q.data ? (
          diff === 0 ? (
            <Chip tone="success" icon="check">
              {t('financials.balanced')}
            </Chip>
          ) : (
            <Chip tone="danger" icon="cross">
              {t('financials.outBy', { amount: formatIndian(fromPaise(Math.abs(diff))) })}
            </Chip>
          )
        ) : null
      }
    >
      <div className="sf-card__pad" style={{ paddingTop: 0, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <p className="muted" style={{ margin: 0, fontSize: 13, flex: '1 1 300px' }}>
          {t('financials.tbNote')}
        </p>
        <Checkbox label={t('financials.hideZero')} checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
      </div>
      <DataTable
        caption={t('financials.tbTitle')}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.account_id}
        loading={q.isLoading}
        error={q.error ? <RpcErrorBox error={q.error as RpcError} /> : undefined}
        empty={<EmptyState title={t('financials.tbEmpty')} body={t('financials.tbEmptyBody')} />}
        minWidth={860}
        footer={
          all.length ? (
            <tr>
              <th scope="row" colSpan={3} style={{ textAlign: 'left' }}>
                {t('financials.totals')}
              </th>
              <td className="r">
                <strong>
                  <Amount value={fromPaise(dr)} />
                </strong>
              </td>
              <td className="r">
                <strong>
                  <Amount value={fromPaise(cr)} />
                </strong>
              </td>
              <td className="r">
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <strong className="sf-amount">{`${formatIndian(fromPaise(closingDr))} Dr`}</strong>
                  <strong className="sf-amount">{`${formatIndian(fromPaise(closingCr))} Cr`}</strong>
                </span>
              </td>
            </tr>
          ) : undefined
        }
      />
    </TableCard>
  )
}

/* ─────────── Account ledger ─────────── */
function Ledger({ companyId, from, to, accountId, onAccount }: { companyId: string; from: string; to: string; accountId: string; onAccount: (id: string) => void }) {
  const { t } = useTranslation()
  const accounts = useCompanyAccounts(companyId)
  const current = accounts.list.find((a) => a.id === accountId)
  const q = useReadRpc<LedgerRow[]>('account_ledger', { p_account_id: accountId, p_from: from, p_to: to }, Boolean(accountId))
  const rows = q.data ?? []
  const last = rows[rows.length - 1]
  const cols: Column<LedgerRow>[] = [
    { key: 'date', header: t('financials.col.date'), render: (r) => <span className="mono">{r.entry_date ? formatDate(r.entry_date) : ''}</span> },
    { key: 'no', header: t('financials.col.docNo'), render: (r) => <span className="mono">{r.doc_no ?? ''}</span> },
    { key: 'type', header: t('financials.col.type'), render: (r) => t(`financials.vtype.${r.voucher_type}`, { defaultValue: r.voucher_type }) },
    { key: 'narr', header: t('financials.col.narration'), render: (r) => r.narration ?? '' },
    { key: 'dr', header: t('financials.col.dr'), align: 'right', render: (r) => (r.dr === null ? '' : <Amount value={r.dr} />) },
    { key: 'cr', header: t('financials.col.cr'), align: 'right', render: (r) => (r.cr === null ? '' : <Amount value={r.cr} />) },
    { key: 'bal', header: t('financials.col.balance'), align: 'right', render: (r) => <DrCr value={r.balance} /> },
  ]
  return (
    <TableCard
      title={current ? t('financials.ledgerOf', { name: current.name }) : t('financials.tab.ledger')}
      action={
        <div style={{ width: 300 }}>
          <SelectField
            label={t('financials.account')}
            value={accountId}
            onChange={(e) => onAccount(e.target.value)}
            placeholder={t('financials.pickAccount')}
            options={accounts.list.map((a) => ({ value: a.id ?? '', label: a.name ?? '' }))}
          />
        </div>
      }
    >
      {!accountId ? (
        <div className="sf-card__pad" style={{ paddingTop: 0 }}>
          <EmptyState title={t('financials.pickAccountTitle')} body={t('financials.pickAccountBody')} />
        </div>
      ) : (
        <DataTable
          caption={t('financials.tab.ledger')}
          columns={cols}
          rows={rows}
          rowKey={(r) => `${r.voucher_id ?? 'open'}-${rows.indexOf(r)}`}
          loading={q.isLoading}
          error={q.error ? <RpcErrorBox error={q.error as RpcError} /> : undefined}
          empty={<EmptyState title={t('financials.ledgerEmpty')} />}
          minWidth={860}
          footer={
            last ? (
              <tr>
                <th scope="row" colSpan={6} style={{ textAlign: 'left' }}>
                  {t('financials.closing')}
                </th>
                <td className="r">
                  <strong>
                    <DrCr value={last.balance} />
                  </strong>
                </td>
              </tr>
            ) : undefined
          }
        />
      )}
    </TableCard>
  )
}

/* ─────────── Statement of account ─────────── */
function StatementTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const parties = useCompanyParties(companyId, 'both')
  const [partyId, setPartyId] = useState('')
  const q = useReadRpc<Statement>('statement_of_account', { p_company_id: companyId, p_party_id: partyId, p_from: from, p_to: to }, Boolean(partyId))
  const s = q.data
  const err = q.error as RpcError | null
  const cols: Column<Statement['lines'][number]>[] = [
    { key: 'date', header: t('financials.col.date'), render: (r) => <span className="mono">{formatDate(r.date)}</span> },
    { key: 'no', header: t('financials.col.docNo'), render: (r) => <span className="mono">{r.doc_no ?? ''}</span> },
    { key: 'type', header: t('financials.col.type'), render: (r) => t(`financials.vtype.${r.type}`, { defaultValue: r.type }) },
    { key: 'dr', header: t('financials.col.dr'), align: 'right', render: (r) => <Amount value={r.dr} /> },
    { key: 'cr', header: t('financials.col.cr'), align: 'right', render: (r) => <Amount value={r.cr} /> },
    { key: 'bal', header: t('financials.col.balance'), align: 'right', render: (r) => <DrCr value={r.balance} /> },
  ]
  return (
    <TableCard
      title={s ? t('financials.statementOf', { name: s.party.name }) : t('financials.tab.statement')}
      action={
        <div style={{ width: 320 }}>
          <SelectField label={t('financials.party')} value={partyId} onChange={(e) => setPartyId(e.target.value)} placeholder={t('financials.pickParty')} options={parties.list.map((p) => ({ value: p.id, label: p.name }))} />
        </div>
      }
    >
      <div className="sf-card__pad" style={{ paddingTop: 0, display: 'grid', gap: 12 }}>
        {!partyId ? <EmptyState title={t('financials.pickPartyTitle')} body={t('financials.pickPartyBody')} /> : null}
        {err ? err.rule === 'statement.admin_only' ? <ErrorRef message={t('financials.adminOnly')} next={t('errors.nextStep')} refId={err.ref} /> : <RpcErrorBox error={err} /> : null}
        {partyId && q.isLoading ? <Skeleton height={60} /> : null}
        {s ? (
          <KeyValue
            rows={[
              { label: t('financials.gstin'), value: <span className="mono">{s.party.gstin ?? '—'}</span> },
              { label: t('financials.opening'), value: <DrCr value={s.opening} /> },
              ...Object.entries(s.ageing ?? {}).map(([bucket, v]) => ({ label: t('financials.ageing', { bucket }), value: <Amount value={v} /> })),
              { label: t('financials.closing'), value: <DrCr value={s.closing} />, total: true },
            ]}
          />
        ) : null}
      </div>
      {s ? <DataTable caption={t('financials.tab.statement')} columns={cols} rows={s.lines} rowKey={(r) => `${r.doc_no}-${s.lines.indexOf(r)}`} empty={<EmptyState title={t('financials.statementEmpty')} />} minWidth={760} /> : null}
      {profile?.view !== 'all' && profile?.view !== 'all-readonly' ? (
        <p className="muted sf-card__pad" style={{ margin: 0, fontSize: 12.5 }}>
          {t('financials.statementRule')}
        </p>
      ) : null}
    </TableCard>
  )
}
