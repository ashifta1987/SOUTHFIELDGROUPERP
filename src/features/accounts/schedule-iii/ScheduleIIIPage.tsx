import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { fromPaise, fyStartOf, toPaise, useReadRpc } from '@/features/accounts/cash-book/money'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, ErrorRef, Field, FormDialog, PageHeader, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'

type Num = number | string | null
interface BsLine {
  side: 'assets' | 'equity_liabilities'
  section: string
  code: string
  label: string
  amount: Num
}
interface PlLine {
  section: string
  code: string
  label: string
  amount: Num
}
export interface S3 {
  balance_sheet: BsLine[]
  profit_and_loss: PlLine[]
  profit_for_period: Num
  profit_brought_forward: Num
  unmapped_groups: { group_id: string; group: string; nature: string; balance: Num }[]
  mapping_confirmed_by_ca: boolean
  totals: { assets: Num; equity_liabilities: Num; difference: Num }
  all_transactions: boolean
  status: string
}
type MapRow = ViewRow<'schedule3_map'>
type LineRow = ViewRow<'schedule3_lines'>

const S3_RULES = new Set(['schedule3.group', 'schedule3.line'])
function S3ErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule && S3_RULES.has(error.rule)) return <ErrorRef message={t(`scheduleIII.rules.${error.rule.slice(10)}`)} next={t('errors.nextStep')} refId={error.ref} />
  if (error.rule === 'rights.reason_required') return <ErrorRef message={t('scheduleIII.rules.note')} next={t('errors.nextStep')} refId={error.ref} />
  return <RpcErrorBox error={error} />
}

/** Lines a group of this nature may sit on (balance-sheet side or P&L section). */
function linesFor(nature: string | null, lines: LineRow[]): LineRow[] {
  if (nature === 'asset') return lines.filter((l) => l.statement === 'bs' && l.side === 'assets')
  if (nature === 'liability' || nature === 'equity') return lines.filter((l) => l.statement === 'bs' && l.side === 'equity_liabilities')
  if (nature === 'income') return lines.filter((l) => l.statement === 'pl' && l.section === 'Income')
  if (nature === 'expense') return lines.filter((l) => l.statement === 'pl' && l.section !== 'Income')
  return lines
}

/**
 * Schedule III statements (`ScheduleIIIBiochem`, /accounts/schedule-iii-statements): the balance sheet and the
 * statement of profit and loss under the Companies Act 2013, Schedule III, Division I, from api.schedule3_statements
 * (the server maps each account group to a line, adds the period's profit to reserves and surplus and returns the
 * totals and their difference). Admin maps groups to lines (api.set_schedule3_map — a change clears the CA's
 * confirmation) and records the CA's confirmation with a note (api.confirm_schedule3_map). Groups not yet mapped stay
 * on their natural side so the sheet still balances, and are listed to map.
 */
export function ScheduleIIIPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const canEdit = can('settings.manage') && !readOnly
  const { list, companyId, company, choose, isLoading } = useCompanyChoice()
  const [from, setFrom] = useState(fyStartOf(todayIst()))
  const [to, setTo] = useState(todayIst())
  const q = useReadRpc<S3>('schedule3_statements', { p_company_id: companyId, p_from: from, p_to: to }, Boolean(companyId))
  const s = q.data

  return (
    <>
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {t('scheduleIII.title')}
            {s ? <Chip tone="signal">{t('scheduleIII.draft')}</Chip> : null}
          </span>
        }
        subtitle={t('scheduleIII.subtitle', { company: company?.name ?? '', date: formatDate(to) })}
      />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <CompanyPicker list={list} value={companyId} onChange={choose} />
        <div style={{ width: 170 }}>
          <Field label={t('common.from')} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div style={{ width: 170 }}>
          <Field label={t('scheduleIII.asAt')} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      {isLoading ? <Skeleton height={80} /> : null}
      {!isLoading && list.length === 0 ? <EmptyState title={t('scheduleIII.noCompany')} /> : null}
      <S3ErrorBox error={q.error as RpcError | null} />

      {companyId ? (
        <>
          {s ? <BalanceCheck s={s} /> : q.isLoading ? <Skeleton height={60} /> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, alignItems: 'start', margin: '16px 0' }}>
            <BalanceSheetCard s={s} loading={q.isLoading} to={to} />
            <ProfitLossCard s={s} loading={q.isLoading} from={from} to={to} />
          </div>
          {s && s.unmapped_groups.length ? <UnmappedCard s={s} /> : null}
          <MappingCard companyId={companyId} canEdit={canEdit} confirmed={s?.mapping_confirmed_by_ca ?? false} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
            <Card title={t('scheduleIII.viewTitle')}>
              <p style={{ margin: 0, fontSize: 13 }}>{t('scheduleIII.viewAdmin')}</p>
              <p style={{ margin: '8px 0 0', fontSize: 13 }}>{t('scheduleIII.viewOthers')}</p>
              <p style={{ margin: '8px 0 0', fontSize: 13 }}>{t('scheduleIII.viewCa')}</p>
              {s && !s.all_transactions ? <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--sf-signal-ink)' }}>{t('scheduleIII.gstOnly')}</p> : null}
            </Card>
            <Card title={t('scheduleIII.caTitle')} accent="signal">
              <p style={{ margin: 0, fontSize: 13 }}>{t('scheduleIII.caBody')}</p>
              <p style={{ margin: '8px 0 0', fontSize: 13 }}>
                <Link to={`/accounts/financials?company=${companyId}`}>{t('scheduleIII.tbLink')}</Link>
              </p>
            </Card>
          </div>
        </>
      ) : null}
    </>
  )
}

/** The server's totals: assets against equity and liabilities, and the difference (zero when the books balance). */
function BalanceCheck({ s }: { s: S3 }) {
  const { t } = useTranslation()
  const diff = toPaise(s.totals.difference)
  return (
    <Card>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }} role="status" aria-label={t('scheduleIII.checkLabel')}>
        <strong>{t('scheduleIII.checkLabel')}</strong>
        <span>
          {t('scheduleIII.assets')} <Amount value={s.totals.assets} rupee />
        </span>
        <span aria-hidden="true">=</span>
        <span>
          {t('scheduleIII.equityLiabilities')} <Amount value={s.totals.equity_liabilities} rupee />
        </span>
        {diff === 0 ? (
          <Chip tone="success" icon="check">
            {t('scheduleIII.balanced')}
          </Chip>
        ) : (
          <Chip tone="danger" icon="cross">
            {t('scheduleIII.difference', { amount: formatIndian(fromPaise(diff)) })}
          </Chip>
        )}
        {s.mapping_confirmed_by_ca ? (
          <Chip tone="success" icon="check">
            {t('scheduleIII.caConfirmed')}
          </Chip>
        ) : (
          <Chip tone="signal">{t('scheduleIII.caNotConfirmed')}</Chip>
        )}
      </div>
    </Card>
  )
}

interface Shown {
  key: string
  label: string
  amount: Num
  kind: 'head' | 'line' | 'total'
}

function StatementTable({ caption, rows }: { caption: string; rows: Shown[] }) {
  const cols: Column<Shown>[] = [
    {
      key: 'label',
      header: <span className="sr-only">{caption}</span>,
      render: (r) => (r.kind === 'line' ? <span style={{ paddingLeft: 16, display: 'inline-block' }}>{r.label}</span> : <strong>{r.label}</strong>),
    },
    { key: 'amt', header: '₹', align: 'right', render: (r) => (r.kind === 'head' ? '' : r.kind === 'total' ? <strong><Amount value={r.amount} /></strong> : <Amount value={r.amount} />) },
  ]
  return <DataTable caption={caption} columns={cols} rows={rows} rowKey={(r) => r.key} minWidth={380} />
}

function BalanceSheetCard({ s, loading, to }: { s: S3 | undefined; loading: boolean; to: string }) {
  const { t } = useTranslation()
  const rows: Shown[] = []
  if (s) {
    for (const side of ['equity_liabilities', 'assets'] as const) {
      rows.push({ key: `h-${side}`, label: t(`scheduleIII.side.${side}`), amount: null, kind: 'head' })
      let section = ''
      for (const l of s.balance_sheet.filter((x) => x.side === side)) {
        if (l.section !== section) {
          section = l.section
          rows.push({ key: `s-${side}-${section}`, label: section, amount: null, kind: 'head' })
        }
        rows.push({ key: l.code, label: l.label, amount: l.amount, kind: 'line' })
      }
      rows.push({ key: `t-${side}`, label: t('scheduleIII.total'), amount: side === 'assets' ? s.totals.assets : s.totals.equity_liabilities, kind: 'total' })
    }
  }
  return (
    <TableCard title={t('scheduleIII.bsTitle', { date: formatDate(to) })}>
      {loading ? (
        <div className="sf-card__pad">
          <Skeleton height={200} />
        </div>
      ) : s ? (
        <StatementTable caption={t('scheduleIII.bsTitle', { date: formatDate(to) })} rows={rows} />
      ) : null}
    </TableCard>
  )
}

function ProfitLossCard({ s, loading, from, to }: { s: S3 | undefined; loading: boolean; from: string; to: string }) {
  const { t } = useTranslation()
  const rows: Shown[] = []
  if (s) {
    let section = ''
    for (const l of s.profit_and_loss) {
      if (l.section !== section) {
        section = l.section
        rows.push({ key: `s-${section}`, label: section, amount: null, kind: 'head' })
      }
      rows.push({ key: l.code, label: l.label, amount: l.amount, kind: 'line' })
    }
    rows.push({ key: 'profit', label: t('scheduleIII.profit'), amount: s.profit_for_period, kind: 'total' })
    rows.push({ key: 'bf', label: t('scheduleIII.broughtForward'), amount: s.profit_brought_forward, kind: 'line' })
  }
  const title = t('scheduleIII.plTitle', { from: formatDate(from), to: formatDate(to) })
  return (
    <TableCard title={title}>
      {loading ? (
        <div className="sf-card__pad">
          <Skeleton height={200} />
        </div>
      ) : s ? (
        <>
          <StatementTable caption={title} rows={rows} />
          <p className="muted sf-card__pad" style={{ margin: 0, fontSize: 12.5 }}>
            {t('scheduleIII.plNote')}
          </p>
        </>
      ) : null}
    </TableCard>
  )
}

function UnmappedCard({ s }: { s: S3 }) {
  const { t } = useTranslation()
  return (
    <Card title={t('scheduleIII.unmappedTitle')} accent="signal" style={{ marginBottom: 16 }}>
      <p style={{ margin: '0 0 8px', fontSize: 13 }}>{t('scheduleIII.unmappedBody')}</p>
      <DataTable
        caption={t('scheduleIII.unmappedTitle')}
        rows={s.unmapped_groups}
        rowKey={(r) => r.group_id}
        minWidth={420}
        columns={[
          { key: 'g', header: t('scheduleIII.col.group'), render: (r) => r.group },
          { key: 'n', header: t('scheduleIII.col.nature'), render: (r) => t(`scheduleIII.nature.${r.nature}`, { defaultValue: r.nature }) },
          { key: 'b', header: t('scheduleIII.col.balance'), align: 'right', render: (r) => <Amount value={r.balance} /> },
        ]}
      />
    </Card>
  )
}

/* ─────────── Mapping editor ─────────── */
function MappingCard({ companyId, canEdit, confirmed }: { companyId: string; canEdit: boolean; confirmed: boolean }) {
  const { t } = useTranslation()
  const map = useApiView('schedule3_map', { eq: { company_id: companyId }, order: 'group_name' })
  const linesQ = useApiView('schedule3_lines', { order: 'sort' })
  const lines = rowsOf(linesQ)
  const rows = rowsOf(map)
  const invalidate = [['api', 'schedule3_map'], ['api', 'schedule3_statements']]
  const set = useApiMutation<{ p: { account_group_id: string; line_code: string } }>('set_schedule3_map', invalidate)
  const confirm = useApiMutation<{ p_company_id: string; p_note: string }, { confirmed: number }>('confirm_schedule3_map', invalidate)
  const [saving, setSaving] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const mapped = rows.filter((r) => r.line_code).length

  const cols: Column<MapRow>[] = [
    { key: 'g', header: t('scheduleIII.col.group'), render: (r) => r.group_name },
    { key: 'n', header: t('scheduleIII.col.nature'), render: (r) => t(`scheduleIII.nature.${r.nature}`, { defaultValue: r.nature ?? '' }) },
    {
      key: 'line',
      header: t('scheduleIII.col.line'),
      width: '40%',
      render: (r) =>
        canEdit ? (
          <SelectField
            label={t('scheduleIII.lineFor', { group: r.group_name })}
            value={r.line_code ?? ''}
            disabled={saving === r.account_group_id}
            onChange={(e) => {
              if (!e.target.value || !r.account_group_id) return
              setSaving(r.account_group_id)
              set.mutate({ p: { account_group_id: r.account_group_id, line_code: e.target.value } }, { onSettled: () => setSaving(null) })
            }}
            placeholder={t('scheduleIII.notMapped')}
            options={linesFor(r.nature, lines).map((l) => ({ value: l.code ?? '', label: l.statement === 'bs' ? `${l.section} · ${l.label}` : l.label ?? '' }))}
          />
        ) : (
          (r.line_label ?? <span className="muted">{t('scheduleIII.notMapped')}</span>)
        ),
    },
    {
      key: 'ca',
      header: t('scheduleIII.col.ca'),
      render: (r) =>
        !r.line_code ? (
          <span className="muted">—</span>
        ) : r.ca_confirmed ? (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Chip tone="success" icon="check">
              {t('scheduleIII.confirmed')}
            </Chip>
            {r.confirmed_at ? <span className="muted" style={{ fontSize: 12 }}>{formatDate(r.confirmed_at)}</span> : null}
          </span>
        ) : (
          <Chip tone="signal">{t('scheduleIII.toConfirm')}</Chip>
        ),
    },
  ]

  return (
    <TableCard
      title={t('scheduleIII.mapTitle')}
      action={
        canEdit ? (
          <Button
            variant="primary"
            size="sm"
            disabled={mapped === 0}
            onClick={() => {
              setNote('')
              confirm.reset()
              setOpen(true)
            }}
          >
            {t('scheduleIII.confirmButton')}
          </Button>
        ) : null
      }
    >
      <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
        {t('scheduleIII.mapNote', { mapped, total: rows.length })} {confirmed ? t('scheduleIII.mapConfirmed') : t('scheduleIII.mapNotConfirmed')}
      </p>
      {!canEdit ? (
        <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
          {t('scheduleIII.adminOnly')}
        </p>
      ) : null}
      <div className="sf-card__pad" style={{ paddingTop: 0 }}>
        <S3ErrorBox error={set.error} />
      </div>
      <DataTable
        caption={t('scheduleIII.mapTitle')}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.account_group_id ?? ''}
        loading={map.isLoading || linesQ.isLoading}
        error={map.error ? <ErrorRef message={t('errors.loadFailed')} refId="S3-MAP" /> : undefined}
        empty={<EmptyState title={t('scheduleIII.noGroups')} body={t('scheduleIII.noGroupsBody')} />}
        minWidth={820}
      />
      <FormDialog
        open={open}
        onOpenChange={(o) => {
          if (!o) setOpen(false)
        }}
        title={t('scheduleIII.confirmTitle')}
        description={t('scheduleIII.confirmEffect', { count: mapped })}
        submitLabel={t('scheduleIII.confirmSubmit')}
        busy={confirm.isPending}
        onSubmit={() => note.trim().length >= 5 && confirm.mutate({ p_company_id: companyId, p_note: note.trim() }, { onSuccess: () => setOpen(false) })}
        error={<S3ErrorBox error={confirm.error} />}
      >
        <TextAreaField label={t('scheduleIII.caNote')} value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {t('scheduleIII.caNoteHelp')}
        </p>
      </FormDialog>
    </TableCard>
  )
}
