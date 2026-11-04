import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { readSheet } from 'read-excel-file/browser'
import { callApi, RpcError } from '@/data/rpc'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useCan } from '@/auth/AuthProvider'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { routeForFile } from '@/app/flows'
import { formatDate, formatIndian, formatTime } from '@/shared/format'
import { makeErrorRef } from '@/shared/supabase'
import { Button, Card, Chip, ConfirmDialog, DataTable, EmptyState, Field, FieldGrid, SelectField, type Column } from '@/ui'
import { readTallyXml, uploadOriginal } from '@/features/import/runImport'
import { decodeTallyBytes, sanitizeTallyXml, type StageRow } from '@/features/import/tally/parseTallyXml'
import {
  companyNameMatches, parseDayBook, parseReport, reportXmlToTable, ReportReadError, sha256Hex,
  type BalanceSheetParsed, type ParsedReport, type StockSummaryParsed, type TrialBalanceParsed,
} from '@/features/import/tally/reports'
import { runDayBook, stageReport, type DayBookResult, type Progress, type Rpc } from '@/features/import/tally/reports/flow'
import { TableCard } from './layout'
import { ImportError } from './ImportHistory'
import { StepBar } from './steps'

export type ReportSource = 'daybook' | 'trial_balance' | 'stock_summary' | 'balance_sheet'
export const REPORT_SOURCES: ReportSource[] = ['daybook', 'trial_balance', 'stock_summary', 'balance_sheet']
export const isReportSource = (s: string): s is ReportSource => (REPORT_SOURCES as string[]).includes(s)

const rpc: Rpc = (fn, args, opts) => callApi(fn, args, opts)
const REPORT_KEYS = [['api', 'tally_reports'], ['api', 'tally_vouchers'], ['api', 'import_batches'], ['api', 'bug_items'], ['api', 'bug_fixer_open_count'], ['api', 'accounts'], ['api', 'stock_balances'], ['api', 'account_groups']]

type StepName = 'upload' | 'check' | 'import' | 'result'

interface DayBookView {
  rows: unknown[]
  companyName: string | null
  periodFrom: string | null
  periodTo: string | null
  dateFrom: string | null
  dateTo: string | null
  byType: { type: string; count: number; dr: number; cr: number }[]
  totalDr: number | null
  totalCr: number | null
  warnings: { code: string; count: number }[]
  totals: Record<string, unknown>
}

type Loaded = { kind: 'daybook'; view: DayBookView } | { kind: 'report'; parsed: ParsedReport }

const money = (n: number | string | null | undefined) => (n === null || n === undefined ? '—' : formatIndian(n))

async function readFile(source: ReportSource, file: File): Promise<Loaded> {
  const isXml = /\.xml$/i.test(file.name)
  if (source === 'daybook') {
    if (isXml) {
      const parsed = await readTallyXml(file)
      const vouchers = parsed.rows.filter((r: StageRow) => r.object_type === 'voucher')
      if (vouchers.length === 0) throw new ReportReadError('errNoRows')
      const byType = new Map<string, { type: string; count: number; dr: number; cr: number }>()
      for (const r of vouchers) {
        const type = String(r.payload.type ?? '—')
        const t = byType.get(type) ?? { type, count: 0, dr: 0, cr: 0 }
        t.count++
        byType.set(type, t)
      }
      const dates = vouchers.map((r) => String(r.payload.date ?? '')).filter(Boolean).sort()
      return {
        kind: 'daybook',
        view: {
          rows: parsed.rows, companyName: parsed.companyName, periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, dateFrom: dates[0] ?? null, dateTo: dates[dates.length - 1] ?? null,
          byType: [...byType.values()].sort((a, b) => b.count - a.count), totalDr: null, totalCr: null, warnings: [],
          totals: { voucher_count: vouchers.length, period_from: parsed.periodFrom, period_to: parsed.periodTo },
        },
      }
    }
    const table = (await readSheet(file)) as unknown[][]
    const s = parseDayBook(table)
    return {
      kind: 'daybook',
      view: {
        rows: s.rows, companyName: s.companyName, periodFrom: s.periodFrom, periodTo: s.periodTo, dateFrom: s.dateFrom, dateTo: s.dateTo, byType: s.byType, totalDr: s.totalDr, totalCr: s.totalCr, warnings: s.warnings,
        totals: { voucher_count: s.rows.length, report_from: s.dateFrom, report_to: s.dateTo, dr_total: s.totalDr, cr_total: s.totalCr },
      },
    }
  }
  const table = isXml ? reportXmlToTable(sanitizeTallyXml(decodeTallyBytes(new Uint8Array(await file.arrayBuffer()))), source) : ((await readSheet(file)) as unknown[][])
  return { kind: 'report', parsed: parseReport(source, table) }
}

function Progressbar({ label, done, total }: { label: string; done: number; total: number }) {
  return <progress aria-label={label} value={total > 0 ? done : undefined} max={total > 0 ? total : undefined} style={{ width: '100%', height: 10, accentColor: 'var(--sf-primary)' }} />
}

/** Upload → Check rows → Import → Result for one of the four Tally reports. The file is only converted here; Postgres decides everything. */
export function ReportImport({ source, companyId, companyNames, companyLabel }: { source: ReportSource; companyId: string; companyNames: string[]; companyLabel: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [step, setStep] = useState<StepName>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [asOf, setAsOf] = useState('')
  const [reading, setReading] = useState(false)
  const [readErr, setReadErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ label: string; done: number; total: number }>({ label: '', done: 0, total: 0 })
  const [runErr, setRunErr] = useState<RpcError | Error | null>(null)
  const [dayResult, setDayResult] = useState<DayBookResult | null>(null)
  const [stagedId, setStagedId] = useState<{ id: string; duplicate: boolean; status: string } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function reset() {
    setStep('upload')
    setFile(null)
    setLoaded(null)
    setAsOf('')
    setReadErr(null)
    setRunErr(null)
    setDayResult(null)
    setStagedId(null)
    setConfirm(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function onFile(f: File | null) {
    setFile(f)
    setLoaded(null)
    setReadErr(null)
    if (!f) return
    setReading(true)
    try {
      const r = await readFile(source, f)
      setLoaded(r)
      if (r.kind === 'report') setAsOf(r.parsed.asOf ?? '')
      setStep('check')
    } catch (e) {
      setReadErr(e instanceof ReportReadError ? t(`importData.reports.${e.code}`) : /\.xml$/i.test(f.name) ? t('importData.reports.errXml') : t('importData.reports.errExcel'))
    } finally {
      setReading(false)
    }
  }

  const onProgress: Progress = (s, done, total) => setProgress({ label: t(`importData.reports.progress.${s}`, { done, total }), done: done ?? 0, total: total ?? 0 })

  async function start() {
    if (!file || !loaded) return
    setConfirm(false)
    setStep('import')
    setRunErr(null)
    try {
      if (loaded.kind === 'daybook') {
        onProgress('batch')
        const storagePath = await uploadOriginal(companyId, file)
        const r = await runDayBook(rpc, { companyId, fileName: file.name, storagePath, rows: loaded.view.rows, totals: loaded.view.totals, onProgress })
        setDayResult(r)
      } else {
        const sha = await sha256Hex(await file.arrayBuffer())
        const r = await stageReport(rpc, { companyId, parsed: loaded.parsed, asOf, fileName: file.name, sha256: sha, onProgress })
        setStagedId({ id: r.id, duplicate: r.duplicate, status: r.status })
      }
      setStep('result')
    } catch (e) {
      setRunErr(e instanceof Error ? e : new Error(String(e)))
    } finally {
      await Promise.all(REPORT_KEYS.map((k) => qc.invalidateQueries({ queryKey: k })))
    }
  }

  const kindLabel = t(`importData.reports.kindTitle.${source}`)
  const blocked = loaded?.kind === 'report' && (loaded.parsed.kind === 'trial_balance' ? loaded.parsed.grain === 'group' : false)
  const needsDate = loaded?.kind === 'report' && !asOf

  return (
    <>
      <StepBar step={step} />
      <Card title={t('importData.reports.howTitle')} style={{ marginBottom: 16 }}>
        <p style={{ margin: '0 0 8px' }}>{t(`importData.reports.what.${source}`)}</p>
        <p style={{ margin: '0 0 8px' }}>{t(`importData.reports.how.${source}`)}</p>
        <p className="muted" style={{ margin: '0 0 4px', fontSize: 13 }}>{t('importData.reports.xmlToo')}</p>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          <strong>{t('importData.reports.orderTitle')}:</strong> {t('importData.reports.order')}
        </p>
      </Card>

      {step === 'upload' ? (
        <Card title={t('importData.upload.title')} style={{ marginBottom: 16 }}>
          <Field
            ref={inputRef}
            label={t('importData.reports.file')}
            type="file"
            accept=".xlsx,.xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/xml,application/xml"
            help={source === 'daybook' ? t('importData.reports.fileHelpDayBook') : t('importData.reports.fileHelpXlsx')}
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            disabled={reading}
            error={readErr ?? undefined}
          />
          {reading ? (
            <p role="status" className="muted" style={{ margin: '8px 0 0' }}>
              {t('importData.reports.reading')}
            </p>
          ) : null}
        </Card>
      ) : null}

      {step === 'check' && loaded && file ? (
        <Card title={t('importData.reports.check.title', { file: file.name, count: loaded.kind === 'daybook' ? (loaded.view.totals.voucher_count as number) : loaded.parsed.lines.length })} style={{ marginBottom: 16 }}>
          {loaded.kind === 'daybook' ? <DayBookCheck view={loaded.view} companyNames={companyNames} companyLabel={companyLabel} /> : <ReportCheck parsed={loaded.parsed} companyNames={companyNames} companyLabel={companyLabel} />}
          {loaded.kind === 'report' ? (
            <div style={{ marginTop: 12, maxWidth: 280 }}>
              <Field label={t('importData.reports.asOf')} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} help={t('importData.reports.asOfHelp')} error={needsDate ? t('importData.reports.asOfRequired') : undefined} />
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <span className="muted" style={{ fontSize: 13, flex: '1 1 320px' }}>{t('importData.check.serverDecides')}</span>
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <Button onClick={reset}>{t('importData.reports.check.back')}</Button>
              <Button variant="primary" disabled={blocked || needsDate} onClick={() => setConfirm(true)}>
                {loaded.kind === 'daybook' ? t('importData.reports.check.load', { count: loaded.view.totals.voucher_count as number }) : t('importData.reports.check.stage')}
              </Button>
            </span>
          </div>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title={loaded.kind === 'daybook' ? t('importData.reports.check.confirmTitle', { company: companyLabel }) : t('importData.reports.check.confirmStage')}
            effect={
              loaded.kind === 'daybook'
                ? t('importData.reports.check.confirmEffect', { count: loaded.view.totals.voucher_count as number, from: loaded.view.dateFrom ? formatDate(loaded.view.dateFrom) : '—', to: loaded.view.dateTo ? formatDate(loaded.view.dateTo) : '—', company: companyLabel })
                : t('importData.reports.what.' + source)
            }
            confirmLabel={loaded.kind === 'daybook' ? t('importData.reports.check.load', { count: loaded.view.totals.voucher_count as number }) : t('importData.reports.check.stage')}
            onConfirm={start}
          />
        </Card>
      ) : null}

      {step === 'import' ? (
        <Card title={t('importData.progress.title')} style={{ marginBottom: 16 }}>
          {runErr ? (
            <>
              <p style={{ margin: '0 0 8px' }}>{t('importData.result.failed')}</p>
              {runErr instanceof RpcError ? <ImportError error={runErr} /> : <RpcErrorBox error={new RpcError(runErr.message, makeErrorRef())} />}
              <div style={{ marginTop: 12 }}>
                <Button onClick={reset}>{t('importData.reports.result.another')}</Button>
              </div>
            </>
          ) : (
            <div role="status" aria-live="polite" style={{ display: 'grid', gap: 8 }}>
              <p style={{ margin: 0 }}>{progress.label || t('common.loading')}</p>
              <Progressbar label={kindLabel} done={progress.done} total={progress.total} />
            </div>
          )}
        </Card>
      ) : null}

      {step === 'result' && dayResult ? <DayBookResultCard result={dayResult} onAgain={reset} /> : null}
      {step === 'result' && stagedId ? (
        <>
          <Card
            title={t('importData.reports.result.reportTitle', { kind: kindLabel })}
            style={{ marginBottom: 16 }}
            action={
              <Button size="sm" onClick={reset}>
                {t('importData.reports.result.another')}
              </Button>
            }
          >
            <p role="status" style={{ margin: 0 }}>
              {stagedId.duplicate ? t('importData.reports.result.duplicate', { status: t(`importData.reports.list.status.${stagedId.status}`) }) : t('importData.reports.result.stored', { asOf: formatDate(asOf) })}
            </p>
          </Card>
          <ReportPanel reportId={stagedId.id} companyLabel={companyLabel} />
        </>
      ) : null}
    </>
  )
}

function CompanyLine({ fileName, companyNames, companyLabel }: { fileName: string | null; companyNames: string[]; companyLabel: string }) {
  const { t } = useTranslation()
  if (!fileName) return null
  const ok = companyNameMatches(fileName, companyNames)
  return (
    <div style={{ margin: '0 0 8px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>{t('importData.reports.check.company', { name: fileName })}</span>
      {ok ? null : (
        <span role="alert">
          <Chip tone="signal" icon="info">
            {t('importData.reports.check.companyMismatch', { file: fileName, chosen: companyLabel })}
          </Chip>
        </span>
      )}
    </div>
  )
}

function Warnings({ items }: { items: { code: string; count?: number; detail?: string }[] }) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <ul style={{ margin: '8px 0', paddingLeft: 20, display: 'grid', gap: 4 }}>
      {items.map((w) => (
        <li key={w.code}>{t(`importData.reports.check.warn.${w.code}`, { count: w.count ?? 0, detail: w.detail ?? '' })}</li>
      ))}
    </ul>
  )
}

function DayBookCheck({ view, companyNames, companyLabel }: { view: DayBookView; companyNames: string[]; companyLabel: string }) {
  const { t } = useTranslation()
  const rows = view.byType
  const hasMoney = view.totalDr !== null
  const cols: Column<(typeof rows)[number]>[] = [
    { key: 'type', header: t('importData.reports.check.type'), render: (r) => <strong style={{ fontWeight: 600 }}>{r.type}</strong> },
    { key: 'count', header: t('importData.reports.check.count'), align: 'right', render: (r) => <span className="mono">{formatIndian(r.count, 0)}</span> },
    ...(hasMoney
      ? [
          { key: 'dr', header: t('importData.reports.check.dr'), align: 'right' as const, render: (r: (typeof rows)[number]) => <span className="mono">{money(r.dr)}</span> },
          { key: 'cr', header: t('importData.reports.check.cr'), align: 'right' as const, render: (r: (typeof rows)[number]) => <span className="mono">{money(r.cr)}</span> },
        ]
      : []),
  ]
  return (
    <>
      <CompanyLine fileName={view.companyName} companyNames={companyNames} companyLabel={companyLabel} />
      <p className="muted" style={{ margin: '0 0 4px', fontSize: 13 }}>
        {[
          view.periodFrom && view.periodTo ? t('importData.reports.check.period', { from: formatDate(view.periodFrom), to: formatDate(view.periodTo) }) : null,
          view.dateFrom && view.dateTo ? t('importData.reports.check.dates', { from: formatDate(view.dateFrom), to: formatDate(view.dateTo) }) : null,
        ].filter(Boolean).join(' · ')}
      </p>
      {hasMoney ? <p style={{ margin: '0 0 8px' }}>{t('importData.reports.check.totals', { dr: money(view.totalDr), cr: money(view.totalCr) })}</p> : null}
      <Warnings items={view.warnings} />
      <DataTable
        caption={t('importData.reports.check.byType')}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.type}
        minWidth={420}
        footer={
          <tr>
            <th scope="row">{t('importData.reports.check.total')}</th>
            <td style={{ textAlign: 'right' }} className="mono">{formatIndian(rows.reduce((s, r) => s + r.count, 0), 0)}</td>
            {hasMoney ? (
              <>
                <td style={{ textAlign: 'right' }} className="mono">{money(view.totalDr)}</td>
                <td style={{ textAlign: 'right' }} className="mono">{money(view.totalCr)}</td>
              </>
            ) : null}
          </tr>
        }
      />
    </>
  )
}

function ReportCheck({ parsed, companyNames, companyLabel }: { parsed: ParsedReport; companyNames: string[]; companyLabel: string }) {
  const { t } = useTranslation()
  return (
    <>
      <CompanyLine fileName={parsed.companyName} companyNames={companyNames} companyLabel={companyLabel} />
      <Warnings items={parsed.warnings} />
      {parsed.kind === 'trial_balance' ? <TbCheck d={parsed.detail as TrialBalanceParsed} /> : null}
      {parsed.kind === 'stock_summary' ? <StockCheck d={parsed.detail as StockSummaryParsed} /> : null}
      {parsed.kind === 'balance_sheet' ? <BsCheck d={parsed.detail as BalanceSheetParsed} /> : null}
      <span className="sr-only">{t('importData.reports.check.lines')}</span>
    </>
  )
}

function TbCheck({ d }: { d: TrialBalanceParsed }) {
  const { t } = useTranslation()
  const diff = Math.round((d.ledgerDr - d.ledgerCr) * 100) / 100
  const rows = d.lines.slice(0, 12)
  return (
    <>
      <p style={{ margin: '0 0 4px' }}>{t('importData.reports.check.ledgers', { count: d.ledgerCount, groups: d.groupCount })}</p>
      <p style={{ margin: '0 0 4px' }}>{t('importData.reports.check.ledgerTotals', { dr: money(d.ledgerDr), cr: money(d.ledgerCr) })}</p>
      {d.tallyDr !== null ? <p className="muted" style={{ margin: '0 0 4px' }}>{t('importData.reports.check.tallyTotals', { dr: money(d.tallyDr), cr: money(d.tallyCr) })}</p> : null}
      <p role={diff === 0 ? 'status' : 'alert'} style={{ margin: '0 0 8px' }}>
        {diff === 0 ? t('importData.reports.check.balanced') : t('importData.reports.check.notBalanced', { diff: money(Math.abs(diff)) })}
      </p>
      {d.grain === 'group' ? <p role="alert" style={{ margin: '0 0 8px' }}><Chip tone="danger" icon="cross">{t('importData.reports.check.groupOnly')}</Chip></p> : null}
      <DataTable
        caption={t('importData.reports.check.lines')}
        columns={[
          { key: 'name', header: t('importData.reports.check.name'), render: (l: (typeof rows)[number]) => <span style={{ fontWeight: l.is_group ? 600 : 400 }}>{l.name}</span> },
          { key: 'kind', header: t('importData.reports.check.kind'), render: (l: (typeof rows)[number]) => <span className="muted">{l.is_group ? t('importData.reports.check.groupRow') : t('importData.reports.check.ledger')}</span> },
          { key: 'dr', header: t('importData.reports.check.dr'), align: 'right', render: (l: (typeof rows)[number]) => <span className="mono">{l.dr ? money(l.dr) : ''}</span> },
          { key: 'cr', header: t('importData.reports.check.cr'), align: 'right', render: (l: (typeof rows)[number]) => <span className="mono">{l.cr ? money(l.cr) : ''}</span> },
        ]}
        rows={rows}
        rowKey={(l) => `${l.name}|${l.dr}|${l.cr}|${l.is_group}`}
        minWidth={520}
      />
    </>
  )
}

function StockCheck({ d }: { d: StockSummaryParsed }) {
  const { t } = useTranslation()
  const rows = d.lines.slice(0, 12)
  return (
    <>
      <p style={{ margin: '0 0 4px' }}>{t('importData.reports.check.items', { count: d.itemCount, groups: d.groupCount })}</p>
      <p style={{ margin: '0 0 4px' }}>{t('importData.reports.check.stockTotals', { value: money(d.itemValue) })}</p>
      {d.tallyValue !== null ? <p className="muted" style={{ margin: '0 0 4px' }}>{t('importData.reports.check.stockTally', { value: money(d.tallyValue) })}</p> : null}
      {d.negativeOrZero > 0 ? <p role="status" style={{ margin: '0 0 8px' }}>{t('importData.reports.check.negative', { count: d.negativeOrZero })}</p> : null}
      <DataTable
        caption={t('importData.reports.check.lines')}
        columns={[
          { key: 'name', header: t('importData.reports.check.name'), render: (l: (typeof rows)[number]) => <span style={{ fontWeight: l.is_group ? 600 : 400 }}>{l.name}</span> },
          { key: 'qty', header: t('importData.reports.check.qty'), align: 'right', render: (l: (typeof rows)[number]) => <span className="mono">{l.qty === null ? '' : `${formatIndian(l.qty, 3)} ${l.unit ?? ''}`}</span> },
          { key: 'rate', header: t('importData.reports.check.rate'), align: 'right', render: (l: (typeof rows)[number]) => <span className="mono">{l.rate === null ? '' : money(l.rate)}</span> },
          { key: 'value', header: t('importData.reports.check.value'), align: 'right', render: (l: (typeof rows)[number]) => <span className="mono">{money(l.value)}</span> },
        ]}
        rows={rows}
        rowKey={(l) => `${l.name}|${l.value}|${l.qty}`}
        minWidth={520}
      />
    </>
  )
}

function BsCheck({ d }: { d: BalanceSheetParsed }) {
  const { t } = useTranslation()
  const rows = d.lines.filter((l) => l.depth === 0).slice(0, 14)
  return (
    <>
      <p style={{ margin: '0 0 8px' }}>{t('importData.reports.check.bsTotals', { l: money(d.liabilitiesTotal), a: money(d.assetsTotal), layout: t(`importData.reports.check.${d.layout}`) })}</p>
      <DataTable
        caption={t('importData.reports.check.lines')}
        columns={[
          { key: 'side', header: t('importData.reports.check.side'), render: (l: (typeof rows)[number]) => (l.side === 'L' ? t('importData.reports.compare.liab') : t('importData.reports.compare.asset')) },
          { key: 'name', header: t('importData.reports.check.name'), render: (l: (typeof rows)[number]) => <span style={{ fontWeight: l.is_group || l.is_total ? 600 : 400 }}>{l.name}</span> },
          { key: 'amount', header: t('importData.reports.check.amount'), align: 'right', render: (l: (typeof rows)[number]) => <span className="mono">{money(l.amount)}</span> },
        ]}
        rows={rows}
        rowKey={(l) => `${l.side}|${l.name}|${l.amount}`}
        minWidth={420}
      />
    </>
  )
}

function DayBookResultCard({ result, onAgain }: { result: DayBookResult; onAgain: () => void }) {
  const { t } = useTranslation()
  const counts = result.counts?.voucher ?? {}
  const keys = ['created', 'skipped', 'changed', 'bug', 'error'] as const
  return (
    <Card
      title={t('importData.reports.result.dayBookTitle', { code: result.code })}
      style={{ marginBottom: 16 }}
      action={
        <Button size="sm" onClick={onAgain}>
          {t('importData.reports.result.another')}
        </Button>
      }
    >
      <DataTable
        caption={t('importData.result.caption')}
        columns={keys.map((k) => ({ key: k, header: t(`importData.result.${k}`), align: 'right' as const, render: (r: Record<string, number>) => <span className="mono">{r[k] ?? 0}</span> }))}
        rows={[counts]}
        rowKey={() => 'v'}
        minWidth={420}
      />
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }} role="status">
        {(result.open_bugs ?? 0) > 0 ? t('importData.result.openBugs', { count: result.open_bugs ?? 0 }) : t('importData.result.noBugs')}
      </p>
    </Card>
  )
}

/* ───────────────────────── Reports from Tally (history) ───────────────────────── */
type ReportRow = ViewRow<'tally_reports'>

export function ReportsList({ companyId, companyLabel }: { companyId: string; companyLabel: string }) {
  const { t } = useTranslation()
  const q = useApiView('tally_reports', { eq: { company_id: companyId }, order: 'uploaded_at', ascending: false, limit: 100 })
  const list = rowsOf(q)
  const [openId, setOpenId] = useState<string | null>(null)
  const totalsText = (r: ReportRow) => {
    const tt = r.totals as Record<string, number | null>
    if (r.kind === 'trial_balance') return t('importData.reports.list.tbTotals', { dr: money(tt.dr), cr: money(tt.cr) })
    if (r.kind === 'stock_summary') return t('importData.reports.list.stockTotals', { items: tt.items ?? 0, value: money(tt.value) })
    return t('importData.reports.list.bsTotals', { l: money(tt.liabilities), a: money(tt.assets) })
  }
  const columns: Column<ReportRow>[] = [
    { key: 'kind', header: t('importData.reports.list.kind'), render: (r) => <strong style={{ fontWeight: 600 }}>{t(`importData.reports.kindTitle.${r.kind}`)}</strong> },
    { key: 'asOf', header: t('importData.reports.list.asOf'), render: (r) => formatDate(r.as_of) },
    { key: 'file', header: t('importData.reports.list.file'), render: (r) => <span className="muted">{r.file_name ?? '—'}</span> },
    { key: 'totals', header: t('importData.reports.list.totals'), render: (r) => <span className="mono">{totalsText(r)}</span> },
    { key: 'status', header: t('importData.reports.list.colStatus'), render: (r) => <Chip tone={r.status === 'applied' ? 'success' : r.status === 'superseded' ? 'neutral' : 'info'} icon={r.status === 'applied' ? 'check' : 'info'}>{t(`importData.reports.list.status.${r.status}`)}</Chip> },
    { key: 'by', header: t('importData.reports.list.by'), render: (r) => <span className="muted">{`${formatDate(r.uploaded_at)} ${formatTime(r.uploaded_at)} · ${r.uploaded_by_name ?? '—'}`}</span> },
    {
      key: 'actions',
      header: t('importData.reports.list.actions'),
      render: (r) => (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {r.kind !== 'stock_summary' ? (
            <Button size="sm" onClick={() => setOpenId(r.id)} aria-label={`${t('importData.reports.list.compare')} ${t(`importData.reports.kindTitle.${r.kind}`)} ${formatDate(r.as_of)}`}>
              {t('importData.reports.list.compare')}
            </Button>
          ) : null}
          <Button size="sm" variant="link" onClick={() => setOpenId(openId === r.id ? null : r.id)} aria-expanded={openId === r.id} aria-label={`${t('importData.reports.list.open')} ${t(`importData.reports.kindTitle.${r.kind}`)} ${formatDate(r.as_of)}`}>
            {t('importData.reports.list.open')}
          </Button>
        </span>
      ),
    },
  ]
  return (
    <>
      <TableCard title={t('importData.reports.list.title')}>
        <DataTable caption={t('importData.reports.list.caption')} columns={columns} rows={list} rowKey={(r) => r.id} loading={q.isLoading} minWidth={980} error={q.error ? t('errors.loadFailed') : undefined} empty={<EmptyState title={t('importData.reports.list.empty')} />} />
      </TableCard>
      {openId ? <ReportPanel key={openId} reportId={openId} companyLabel={companyLabel} onClose={() => setOpenId(null)} /> : null}
    </>
  )
}

/* ───────────────────────── One report: apply and compare ───────────────────────── */
interface ApplyResult {
  applied: boolean
  refused?: string
  message?: string
  dr?: number
  cr?: number
  difference?: number
  groups?: string[]
  unmatched?: { name: string; qty: number; unit: string | null; rate: number | null; value: number }[]
}

export function ReportPanel({ reportId, companyLabel, onClose }: { reportId: string; companyLabel: string; onClose?: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const can = useCan()
  const q = useApiView('tally_reports', { eq: { id: reportId }, limit: 1 })
  const report = rowsOf(q)[0]
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [err, setErr] = useState<RpcError | null>(null)
  const [placeId, setPlaceId] = useState('')
  const [showCompare, setShowCompare] = useState(false)
  const places = useApiView('places', { eq: { company_id: report?.company_id }, order: 'code', limit: 500, enabled: Boolean(report?.company_id) })
  if (!report) return null
  const label = t(`importData.reports.kindTitle.${report.kind}`)
  const canApplyTb = report.kind === 'trial_balance' && report.status === 'staged' && can('data.import')
  const canApplyStock = report.kind === 'stock_summary' && report.status === 'staged' && can('inventory.approve')
  const tt = report.totals as Record<string, number | null>

  async function run(fn: string, args: Record<string, unknown>) {
    setBusy(true)
    setErr(null)
    setResult(null)
    try {
      setResult(await callApi<ApplyResult>(fn, args))
    } catch (e) {
      setErr(e instanceof RpcError ? e : new RpcError(String(e), makeErrorRef()))
    } finally {
      setBusy(false)
      setConfirm(false)
      await qc.invalidateQueries({ queryKey: ['api'] })
    }
  }

  return (
    <Card
      title={t('importData.reports.panel.title', { kind: label, asOf: formatDate(report.as_of) })}
      style={{ marginBottom: 16 }}
      action={onClose ? <Button size="sm" onClick={onClose}>{t('importData.reports.panel.close')}</Button> : undefined}
    >
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
        {report.file_name ?? ''} · <Chip tone={report.status === 'applied' ? 'success' : 'info'}>{t(`importData.reports.list.status.${report.status}`)}</Chip>
      </p>

      {report.kind === 'trial_balance' ? (
        <>
          <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>{t('importData.reports.panel.applyTbTitle')}</h3>
          <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>{t('importData.reports.panel.applyTbHelp')}</p>
          <p style={{ margin: '0 0 8px' }} className="mono">{t('importData.reports.list.tbTotals', { dr: money(tt.dr), cr: money(tt.cr) })}</p>
          {canApplyTb ? <Button variant="primary" onClick={() => (setResult(null), setErr(null), setConfirm(true))}>{t('importData.reports.panel.applyTb')}</Button> : null}
          <ConfirmDialog
            open={confirm && report.kind === 'trial_balance'}
            onOpenChange={setConfirm}
            title={t('importData.reports.panel.applyTbConfirmTitle')}
            effect={t('importData.reports.panel.applyTbConfirmEffect', { count: (tt.ledgers as number) ?? 0, company: companyLabel, asOf: formatDate(report.as_of) })}
            confirmLabel={t('importData.reports.panel.applyTb')}
            busy={busy}
            onConfirm={() => run('apply_trial_balance_as_opening', { p_report_id: report.id })}
          />
        </>
      ) : null}

      {report.kind === 'stock_summary' ? (
        <>
          <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>{t('importData.reports.panel.applyStockTitle')}</h3>
          <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>{t('importData.reports.panel.applyStockHelp')}</p>
          <p style={{ margin: '0 0 8px' }} className="mono">{t('importData.reports.list.stockTotals', { items: tt.items ?? 0, value: money(tt.value) })}</p>
          {canApplyStock ? (
            <FieldGrid>
              <SelectField label={t('importData.reports.panel.place')} value={placeId} onChange={(e) => setPlaceId(e.target.value)} placeholder={t('importData.reports.panel.choosePlace')} options={rowsOf(places).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
              <div style={{ alignSelf: 'end' }}>
                <Button variant="primary" disabled={!placeId} onClick={() => (setResult(null), setErr(null), setConfirm(true))}>{t('importData.reports.panel.applyStock')}</Button>
              </div>
            </FieldGrid>
          ) : null}
          <ConfirmDialog
            open={confirm && report.kind === 'stock_summary'}
            onOpenChange={setConfirm}
            title={t('importData.reports.panel.applyStockConfirmTitle')}
            effect={t('importData.reports.panel.applyStockConfirmEffect', { count: (tt.items as number) ?? 0, asOf: formatDate(report.as_of) })}
            confirmLabel={t('importData.reports.panel.applyStock')}
            busy={busy}
            onConfirm={() => run('apply_stock_summary_as_opening_stock', { p_report_id: report.id, p_place_id: placeId })}
          />
        </>
      ) : null}

      {report.kind === 'balance_sheet' ? <p className="muted" style={{ margin: '0 0 8px' }}>{t('importData.reports.panel.balanceHelp')}</p> : null}

      {err ? <div style={{ marginTop: 12 }}><ImportError error={err} /></div> : null}
      {result ? <ApplyResultView result={result} reportId={report.id} /> : null}

      {report.kind !== 'stock_summary' ? (
        <div style={{ marginTop: 16 }}>
          <Button onClick={() => setShowCompare((v) => !v)} aria-expanded={showCompare}>
            {t('importData.reports.list.compare')}
          </Button>
          {showCompare ? <CompareView report={report} /> : null}
        </div>
      ) : null}
    </Card>
  )
}

function ApplyResultView({ result, reportId }: { result: ApplyResult; reportId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const products = useApiView('products', { order: 'code', limit: 3000, enabled: Boolean(result.unmatched?.length) })
  const [pick, setPick] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [mapErr, setMapErr] = useState<RpcError | null>(null)
  async function map(name: string) {
    setMapErr(null)
    try {
      await callApi('map_tally_stock_item', { p_report_id: reportId, p_tally_name: name, p_product_id: pick[name] })
      setMsg(t('importData.reports.panel.mapped', { name }))
      await qc.invalidateQueries({ queryKey: ['api'] })
    } catch (e) {
      setMapErr(e instanceof RpcError ? e : new RpcError(String(e), makeErrorRef()))
    }
  }
  return (
    <div role="status" style={{ marginTop: 12, display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t('importData.reports.panel.resultTitle')}</h3>
      <p style={{ margin: 0 }}>
        <Chip tone={result.applied ? 'success' : 'danger'} icon={result.applied ? 'check' : 'cross'}>
          {result.message ?? ''}
        </Chip>
      </p>
      {result.refused === 'total_mismatch' ? <p style={{ margin: 0 }}>{t('importData.reports.panel.refusedTotal', { dr: money(result.dr), cr: money(result.cr), diff: money(Math.abs(result.difference ?? 0)) })}</p> : null}
      {result.refused === 'unmapped' ? (
        <p style={{ margin: 0 }}>
          {t('importData.reports.panel.refusedUnmapped', { groups: (result.groups ?? []).join(', ') })}{' '}
          <Link to={routeForFile('BookFixes')}>{t('importData.reports.panel.openBugFixer')}</Link> · <Link to={routeForFile('TallyBiochem')}>{t('importData.reports.panel.openCompanies')}</Link>
        </p>
      ) : null}
      {result.refused === 'total_mismatch' ? <Link to={routeForFile('BookFixes')}>{t('importData.reports.panel.openBugFixer')}</Link> : null}
      {result.unmatched?.length ? (
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>{t('importData.reports.panel.unmatchedTitle')}</h3>
          <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>{t('importData.reports.panel.unmatchedHelp')}</p>
          {msg ? <p style={{ margin: '0 0 8px' }}>{msg}</p> : null}
          {mapErr ? <ImportError error={mapErr} /> : null}
          <DataTable
            caption={t('importData.reports.panel.unmatchedTitle')}
            columns={[
              { key: 'item', header: t('importData.reports.panel.item'), render: (u: NonNullable<ApplyResult['unmatched']>[number]) => <strong style={{ fontWeight: 600 }}>{u.name}</strong> },
              {
                key: 'map',
                header: t('importData.reports.panel.mapTo'),
                render: (u: NonNullable<ApplyResult['unmatched']>[number]) => (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <select className="sf-input" aria-label={`${t('importData.reports.panel.mapTo')} ${u.name}`} value={pick[u.name] ?? ''} onChange={(e) => setPick({ ...pick, [u.name]: e.target.value })}>
                      <option value="">{t('importData.reports.panel.choose')}</option>
                      {rowsOf(products).map((p) => (
                        <option key={p.id} value={p.id}>{`${p.code} · ${p.name}`}</option>
                      ))}
                    </select>
                    <Button size="sm" disabled={!pick[u.name]} onClick={() => map(u.name)} aria-label={`${t('importData.reports.panel.map')} ${u.name}`}>{t('importData.reports.panel.map')}</Button>
                  </span>
                ),
              },
              { key: 'create', header: '', render: () => <Link to={routeForFile('ProductMaster')}>{t('importData.reports.panel.createProduct')}</Link> },
            ]}
            rows={result.unmatched}
            rowKey={(u) => u.name}
            minWidth={620}
          />
        </div>
      ) : null}
    </div>
  )
}

function CompareView({ report }: { report: ReportRow }) {
  const { t } = useTranslation()
  const isTb = report.kind === 'trial_balance'
  const tb = useApiView('tally_report_diffs', { eq: { report_id: report.id }, limit: 5000, enabled: isTb })
  const bs = useApiView('tally_report_bs_diffs', { eq: { report_id: report.id }, limit: 5000, enabled: !isTb })
  const loading = isTb ? tb.isLoading : bs.isLoading
  type Diff = { key: string; name: string; sub: string; tally: number | null; erp: number | null; diff: number | null; status: string }
  const rows: Diff[] = isTb
    ? rowsOf(tb).map((r, i) => ({ key: `${i}`, name: r.ledger ?? '', sub: r.tally_group ?? r.erp_group ?? '', tally: r.tally_net, erp: r.erp_net, diff: r.diff, status: r.status ?? '' }))
    : rowsOf(bs).filter((r) => !r.is_total || true).map((r, i) => ({ key: `${i}`, name: r.line ?? '', sub: r.side === 'L' ? t('importData.reports.compare.liab') : t('importData.reports.compare.asset'), tally: r.tally_amount, erp: r.erp_amount, diff: r.diff, status: r.status ?? '' }))
  const good = (s: string) => s === 'match' || s === 'total' || s === 'detail' || s === 'zero_in_erp'
  const sorted = [...rows].sort((a, b) => Number(good(a.status)) - Number(good(b.status)))
  const bad = rows.filter((r) => !good(r.status)).length
  const cols: Column<Diff>[] = [
    { key: 'name', header: isTb ? t('importData.reports.compare.ledger') : t('importData.reports.compare.group'), render: (r) => <strong style={{ fontWeight: 600 }}>{r.name}</strong> },
    { key: 'sub', header: isTb ? t('importData.reports.compare.group') : t('importData.reports.compare.side'), render: (r) => <span className="muted">{r.sub}</span> },
    { key: 'tally', header: t('importData.reports.compare.tally'), align: 'right', render: (r) => <span className="mono">{money(r.tally)}</span> },
    { key: 'erp', header: t('importData.reports.compare.erp'), align: 'right', render: (r) => <span className="mono">{money(r.erp)}</span> },
    { key: 'diff', header: t('importData.reports.compare.diff'), align: 'right', render: (r) => <span className="mono">{money(r.diff)}</span> },
    { key: 'status', header: t('importData.reports.compare.status'), render: (r) => <Chip tone={r.status === 'match' ? 'success' : good(r.status) ? 'neutral' : 'signal'} icon={r.status === 'match' ? 'check' : 'info'}>{t(`importData.reports.compare.st.${r.status}`, { defaultValue: r.status })}</Chip> },
  ]
  return (
    <div style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>{t('importData.reports.compare.title')}</h3>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>{t('importData.reports.compare.help')}</p>
      <p role="status" style={{ margin: '0 0 8px' }}>{t('importData.reports.compare.summary', { ok: rows.length - bad, bad })}</p>
      <DataTable caption={isTb ? t('importData.reports.compare.tbCaption') : t('importData.reports.compare.bsCaption')} columns={cols} rows={sorted.slice(0, 400)} rowKey={(r) => r.key} loading={loading} minWidth={760} empty={<EmptyState title={t('importData.reports.compare.empty')} />} />
    </div>
  )
}
