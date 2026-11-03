import { useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { routeForFile } from '@/app/flows'
import { formatDate } from '@/shared/format'
import { makeErrorRef } from '@/shared/supabase'
import { runImport, type BatchResult } from '@/features/import/runImport'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import type { StageRow } from '@/features/import/tally/parseTallyXml'
import { acceptFor, isExcel, readSource, ReadError, rowDetail, SOURCES, type ReadResult, type SourceKey } from './readSource'
import { IMPORT_KEYS, ImportError, ImportHistory, ResultChip } from './ImportHistory'
import { TWO_COLS } from './layout'

type Step = 'upload' | 'check' | 'import' | 'result'
const STEPS: Step[] = ['upload', 'check', 'import', 'result']
const RESULTS = ['created', 'linked', 'aliased', 'skipped', 'bug', 'changed', 'error', 'pending'] as const
const PREVIEW = 8

/**
 * Import data (`DataImport`): Tally XML, Excel lists and Tally backups for one company, in four steps
 * (upload → check rows → import batch → result). The browser only converts the file; api.import_create_batch,
 * api.import_stage_rows and api.import_process decide every match, creation and Bug fixer item in Postgres.
 */
export function DataImportPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const qc = useQueryClient()
  const readOnly = profile?.view === 'all-readonly'
  const isAdmin = profile?.view === 'all'
  const canImport = can('data.import') && !readOnly
  const canSee = canImport || readOnly || isAdmin
  const { list, company, companyId, choose, isLoading } = useCompanyChoice()

  const [source, setSource] = useState<SourceKey>('tally_xml')
  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [asOf, setAsOf] = useState('')
  const [partyGroup, setPartyGroup] = useState('Sundry Debtors')
  const [read, setRead] = useState<ReadResult | null>(null)
  const [reading, setReading] = useState(false)
  const [readErr, setReadErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<string>('')
  const [result, setResult] = useState<BatchResult | null>(null)
  const [runErr, setRunErr] = useState<RpcError | Error | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function reset(next: SourceKey = source) {
    setSource(next)
    setStep('upload')
    setFile(null)
    setRead(null)
    setReadErr(null)
    setResult(null)
    setRunErr(null)
    setProgress('')
    if (inputRef.current) inputRef.current.value = ''
  }

  async function onFile(f: File | null) {
    setFile(f)
    setRead(null)
    setReadErr(null)
    if (!f) return
    setReading(true)
    try {
      const r = await readSource(source, f, partyGroup)
      setRead(r)
      setStep('check')
    } catch (e) {
      setReadErr(e instanceof ReadError ? t(`importData.upload.${e.message}`) : t('importData.upload.errNotXml'))
    } finally {
      setReading(false)
    }
  }

  async function start() {
    if (!file || !read || !companyId) return
    setStep('import')
    setRunErr(null)
    try {
      const r = await runImport({
        companyId,
        file,
        source: source === 'tally_xml' ? 'tally_xml' : source === 'tbk' ? 'tbk' : 'excel',
        kind: read.kind,
        asOf: asOf || null,
        rows: read.rows,
        totals: read.totals,
        onProgress: (s, done, total) => setProgress(s === 'stage' ? t('importData.progress.stage', { done, total }) : t(`importData.progress.${s}`)),
      })
      setResult(r)
      setStep('result')
    } catch (e) {
      setRunErr(e instanceof Error ? e : new Error(String(e)))
    } finally {
      await Promise.all(IMPORT_KEYS.map((k) => qc.invalidateQueries({ queryKey: k })))
    }
  }

  function showResult(r: BatchResult) {
    setResult(r)
    setRead(null)
    setFile(null)
    setStep('result')
  }

  if (!canSee) {
    return (
      <>
        <PageHeader title={t('importData.title')} subtitle={t('importData.subtitle')} />
        <Card>
          <p className="muted" style={{ margin: 0 }}>
            {t('importData.noRight')}
          </p>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader title={t('importData.title')} subtitle={t('importData.subtitle')} />

      {isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !company ? (
        <Card>
          <EmptyState title={t('importData.noCompany')} action={<Link to={routeForFile('Companies')}>{t('importData.openCompanies')}</Link>} />
        </Card>
      ) : (
        <>
          <div style={{ marginBottom: 16 }}>
            <CompanyPicker list={list} value={companyId} onChange={(id) => (choose(id), reset())} />
          </div>

          {readOnly ? (
            <p className="muted" style={{ margin: '0 0 16px' }}>
              {t('importData.readOnly')}
            </p>
          ) : null}

          {canImport ? (
            <>
              <SourceCards value={source} onChange={(s) => reset(s)} disabled={step === 'import'} />
              <StepBar step={step} />

              {step === 'upload' || step === 'check' ? (
                <Card title={step === 'upload' ? t('importData.upload.title') : undefined} style={{ marginBottom: 16 }}>
                  {step === 'upload' ? (
                    <UploadForm
                      source={source}
                      inputRef={inputRef}
                      onFile={onFile}
                      asOf={asOf}
                      setAsOf={setAsOf}
                      partyGroup={partyGroup}
                      setPartyGroup={setPartyGroup}
                      reading={reading}
                      error={readErr}
                    />
                  ) : read && file ? (
                    <CheckRows source={source} file={file} read={read} onBack={() => reset()} onImport={start} />
                  ) : null}
                </Card>
              ) : null}

              {step === 'import' ? (
                <Card title={t('importData.progress.title')} style={{ marginBottom: 16 }}>
                  {runErr ? (
                    <>
                      <p style={{ margin: '0 0 8px' }}>{t('importData.result.failed')}</p>
                      {runErr instanceof RpcError ? <ImportError error={runErr} /> : <RpcErrorBox error={new RpcError(runErr.message, makeErrorRef())} />}
                      <div style={{ marginTop: 12 }}>
                        <Button onClick={() => reset()}>{t('importData.result.another')}</Button>
                      </div>
                    </>
                  ) : (
                    <p role="status" aria-live="polite" style={{ margin: 0 }}>
                      {progress || t('common.loading')}
                    </p>
                  )}
                </Card>
              ) : null}
            </>
          ) : null}

          {step === 'result' && result ? <ResultCard result={result} tbk={source === 'tbk' && !result.counts} onAgain={() => reset()} /> : null}

          {source === 'tbk' && canImport ? <BridgeChecklist /> : null}

          <div style={TWO_COLS}>
            <TemplateCard />
            <TallyCard />
          </div>

          <ImportHistory companyId={companyId} canImport={canImport} isAdmin={isAdmin} onResult={showResult} />
        </>
      )}
    </>
  )
}

/* ── Source cards ── */
function SourceCards({ value, onChange, disabled }: { value: SourceKey; onChange: (s: SourceKey) => void; disabled: boolean }) {
  const { t } = useTranslation()
  const base: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    textAlign: 'left',
    padding: '14px 16px',
    minHeight: 72,
    borderRadius: 'var(--sf-radius-card)',
    border: '1px solid var(--sf-line)',
    background: 'var(--sf-surface)',
    color: 'var(--sf-text)',
    font: 'inherit',
    cursor: 'pointer',
  }
  return (
    <div role="group" aria-label={t('importData.sources.label')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 16 }}>
      {SOURCES.map((s) => {
        const on = s === value
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(s)}
            style={{ ...base, ...(on ? { border: '2px solid var(--sf-primary)', background: 'var(--sf-primary-tint)', padding: '13px 15px' } : {}) }}
          >
            <strong style={{ fontWeight: 600 }}>{t(`importData.sources.${s}`)}</strong>
            <span className="muted" style={{ fontSize: 13 }}>
              {t(`importData.sources.${s}Note`)}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ── Step bar ── */
function StepBar({ step }: { step: Step }) {
  const { t } = useTranslation()
  const at = STEPS.indexOf(step)
  return (
    <ol aria-label={t('importData.steps.label')} style={{ listStyle: 'none', margin: '0 0 16px', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
      {STEPS.map((s, i) => {
        const done = i < at || (s === 'result' && step === 'result')
        const current = i === at && !done
        return (
          <li key={s} aria-current={current ? 'step' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span aria-hidden="true" style={{ height: 5, borderRadius: 3, background: done ? 'var(--sf-success)' : current ? 'var(--sf-info)' : 'var(--sf-line)' }} />
            <span style={{ fontSize: 13, fontWeight: done || current ? 600 : 400, color: done ? 'var(--sf-success-ink)' : current ? 'var(--sf-info-ink)' : 'var(--sf-text-muted)' }}>
              {done ? '✓ ' : current ? '● ' : ''}
              {`${i + 1} · ${t(`importData.steps.${s}`)}`}
              <span className="sr-only">{done ? ` (${t('importData.steps.done')})` : current ? ` (${t('importData.steps.current')})` : ''}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/* ── Step 1 ── */
function UploadForm({
  source,
  inputRef,
  onFile,
  asOf,
  setAsOf,
  partyGroup,
  setPartyGroup,
  reading,
  error,
}: {
  source: SourceKey
  inputRef: React.RefObject<HTMLInputElement | null>
  onFile: (f: File | null) => void
  asOf: string
  setAsOf: (v: string) => void
  partyGroup: string
  setPartyGroup: (v: string) => void
  reading: boolean
  error: string | null
}) {
  const { t } = useTranslation()
  const help = source === 'tally_xml' ? t('importData.upload.fileHelpXml') : isExcel(source) ? t('importData.upload.fileHelpExcel') : t('importData.upload.fileHelpTbk')
  return (
    <>
      <FieldGrid>
        {source === 'tally_xml' || source === 'parties' ? (
          <Field label={t('importData.upload.asOf')} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} help={t('importData.upload.asOfHelp')} />
        ) : null}
        {source === 'parties' ? (
          <SelectField
            label={t('importData.upload.partyGroup')}
            value={partyGroup}
            onChange={(e) => setPartyGroup(e.target.value)}
            options={[
              { value: 'Sundry Debtors', label: t('importData.upload.debtors') },
              { value: 'Sundry Creditors', label: t('importData.upload.creditors') },
            ]}
          />
        ) : null}
      </FieldGrid>
      <Field ref={inputRef} label={t('importData.upload.file')} type="file" accept={acceptFor(source)} help={help} onChange={(e) => onFile(e.target.files?.[0] ?? null)} disabled={reading} error={error ?? undefined} />
      {reading ? (
        <p role="status" className="muted" style={{ margin: '8px 0 0' }}>
          {t('importData.upload.reading')}
        </p>
      ) : null}
    </>
  )
}

/* ── Step 2 ── */
function CheckRows({ source, file, read, onBack, onImport }: { source: SourceKey; file: File; read: ReadResult; onBack: () => void; onImport: () => void }) {
  const { t } = useTranslation()
  const preview = read.rows.slice(0, PREVIEW).map((r, i) => ({ r, i }))
  const cols: Column<{ r: StageRow; i: number }>[] = [
    { key: 'row', header: t('importData.check.row'), align: 'right', render: ({ i }) => <span className="mono">{i + 1}</span> },
    { key: 'type', header: t('importData.check.type'), render: ({ r }) => t(`importData.object.${r.object_type}`, { defaultValue: r.object_type }) },
    { key: 'name', header: t('importData.check.name'), render: ({ r }) => <strong style={{ fontWeight: 600 }}>{r.name ?? '—'}</strong> },
    { key: 'under', header: t('importData.check.under'), render: ({ r }) => <span className="muted">{rowDetail(r)}</span> },
    { key: 'guid', header: t('importData.check.guid'), render: ({ r }) => <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{r.guid ?? '—'}</span> },
  ]
  if (source === 'tbk') {
    return (
      <>
        <div className="sf-card__head" style={{ padding: 0, marginBottom: 8 }}>
          <h2 className="sf-card__title">{t('importData.check.titleTbk', { file: file.name })}</h2>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button onClick={onBack}>{t('importData.check.back')}</Button>
          <Button variant="primary" onClick={onImport}>
            {t('importData.check.storeTbk')}
          </Button>
        </div>
      </>
    )
  }
  return (
    <>
      <div className="sf-card__head" style={{ padding: 0, marginBottom: 4 }}>
        <h2 className="sf-card__title">{t('importData.check.title', { file: file.name, count: read.rows.length })}</h2>
      </div>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
        {[read.companyName ? t('importData.check.company', { name: read.companyName }) : null, read.periodFrom && read.periodTo ? t('importData.check.period', { from: formatDate(read.periodFrom), to: formatDate(read.periodTo) }) : null]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <div aria-label={t('importData.check.counts')} role="list" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {Object.entries(read.counts).map(([k, n]) => (
          <span role="listitem" key={k}>
            <Chip tone="neutral">{`${t(`importData.object.${k}`, { defaultValue: k })} · ${n}`}</Chip>
          </span>
        ))}
      </div>
      {read.mapping ? (
        <div style={{ marginBottom: 12 }}>
          <DataTable
            caption={t('importData.check.mappingCaption')}
            columns={[
              { key: 'field', header: t('importData.check.field'), render: (m: { field: string; column: string | null }) => t(`importData.field.${m.field}`) },
              { key: 'column', header: t('importData.check.column'), render: (m: { field: string; column: string | null }) => (m.column ? <span className="mono">{m.column}</span> : <span className="muted">{t('importData.check.notFound')}</span>) },
            ]}
            rows={read.mapping}
            rowKey={(m) => m.field}
            minWidth={360}
          />
        </div>
      ) : null}
      <DataTable caption={t('importData.check.previewCaption')} columns={cols} rows={preview} rowKey={({ i }) => String(i)} minWidth={720} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginTop: 12 }}>
        <span className="muted" style={{ fontSize: 13, flex: '1 1 320px' }}>
          {t('importData.check.serverDecides')}
        </span>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <Button onClick={onBack}>{t('importData.check.back')}</Button>
          <Button variant="primary" onClick={onImport}>
            {t('importData.check.importN', { count: read.rows.length })}
          </Button>
        </span>
      </div>
    </>
  )
}

/* ── Step 4 ── */
function ResultCard({ result, tbk, onAgain }: { result: BatchResult; tbk: boolean; onAgain: () => void }) {
  const { t } = useTranslation()
  const counts = result.counts ?? {}
  const types = Object.keys(counts)
  const rows = types.map((type) => ({ type, c: counts[type] ?? {} }))
  const hasWaiting = rows.some((r) => (r.c.bug ?? 0) > 0)
  const cols: Column<{ type: string; c: Record<string, number> }>[] = [
    { key: 'type', header: t('importData.result.type'), render: (r) => t(`importData.object.${r.type}`, { defaultValue: r.type }) },
    ...RESULTS.map((k) => ({
      key: k,
      header: t(`importData.result.${k}`),
      align: 'right' as const,
      render: (r: { c: Record<string, number> }) => <span className="mono">{r.c[k] ?? 0}</span>,
    })),
  ]
  return (
    <Card
      title={t('importData.result.title', { code: result.code })}
      style={{ marginBottom: 16 }}
      action={
        <Button size="sm" onClick={onAgain}>
          {t('importData.result.another')}
        </Button>
      }
    >
      {tbk ? (
        <p style={{ margin: 0 }} role="status">
          {t('importData.result.tbkStored')}
        </p>
      ) : (
        <>
          <DataTable caption={t('importData.result.caption')} columns={cols} rows={rows} rowKey={(r) => r.type} minWidth={760} />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }} role="status">
            {(result.open_bugs ?? 0) > 0 ? (
              <>
                <ResultChip result="bug" />
                <span>{t('importData.result.openBugs', { count: result.open_bugs ?? 0 })}</span>
                <Link to={routeForFile('BookFixes')}>{t('importData.result.openBugFixer')}</Link>
              </>
            ) : (
              <span className="muted">{t('importData.result.noBugs')}</span>
            )}
          </div>
          {hasWaiting ? (
            <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
              {t('importData.result.mapHint')}
            </p>
          ) : null}
        </>
      )}
    </Card>
  )
}

/* ── Help cards ── */
function BridgeChecklist() {
  const { t } = useTranslation()
  return (
    <Card
      title={t('importData.bridge.title')}
      style={{ marginBottom: 16 }}
      action={
        <Chip tone="signal" icon="clock">
          {t('importData.bridge.notDeployed')}
        </Chip>
      }
    >
      <ol style={{ margin: '0 0 8px', paddingLeft: 20, display: 'grid', gap: 4 }}>
        {['s1', 's2', 's3', 's4', 's5', 's6'].map((k) => (
          <li key={k}>{t(`importData.bridge.${k}`)}</li>
        ))}
      </ol>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {t('importData.bridge.owner')}
      </p>
    </Card>
  )
}

function TemplateCard() {
  const { t } = useTranslation()
  return (
    <Card title={t('importData.template.title')}>
      <ul style={{ margin: '0 0 8px', paddingLeft: 20, display: 'grid', gap: 6 }}>
        <li>{t('importData.template.products')}</li>
        <li>{t('importData.template.parties')}</li>
        <li>{t('importData.template.employees')}</li>
      </ul>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {t('importData.template.synonyms')}
      </p>
    </Card>
  )
}

function TallyCard() {
  const { t } = useTranslation()
  return (
    <Card title={t('importData.sources.tally_xml')}>
      <p style={{ margin: '0 0 8px' }}>{t('importData.template.tally')}</p>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {t('importData.check.serverDecides')}
      </p>
    </Card>
  )
}
