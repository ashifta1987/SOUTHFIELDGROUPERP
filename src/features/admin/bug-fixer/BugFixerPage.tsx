import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { RpcError, callApi, useApiMutation } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { routeForFile } from '@/app/flows'
import { formatDate } from '@/shared/format'
import { ApiError, makeErrorRef } from '@/shared/supabase'
import { IntegrationsCard } from '@/features/admin/integrations/IntegrationsCard'
import { Amount, Button, Card, Chip, DataTable, EmptyState, ErrorRef, KpiTiles, PageHeader, SelectField, Tabs, TextAreaField, type Column } from '@/ui'

type Bug = ViewRow<'bug_items'>
type Company = ViewRow<'companies'>
type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

const AREAS = ['ledger', 'stock', 'production', 'cash', 'tax', 'between_companies', 'masters', 'import', 'integration'] as const
const STATUSES = ['open', 'fixed', 'dismissed', 'all'] as const
type Status = (typeof STATUSES)[number]
type Action = 'keep_separate' | 'link_existing' | 'accept_change' | 'dismiss' | 'fixed'

/** Our own rule texts first (bugFixer.rules.*), then the shared ones. */
function BugErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule) {
    const key = `bugFixer.rules.${error.rule}`
    const msg = t(key)
    if (msg !== key) return <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
  }
  return <RpcErrorBox error={error} />
}

/** Tally books page for the company (by its logo key), else the import screen. */
function tallyRoute(c: Company | undefined): string {
  if (c?.logo_key === 'biochem') return routeForFile('TallyBiochem')
  if (c?.logo_key === 'plastics') return routeForFile('TallyPlastics')
  return routeForFile('DataImport')
}

function isObj(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function show(v: Json | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 160)
  return String(v)
}

/**
 * Bug fixer (`BookFixes`, §12). Every problem from Tally loads and the checks, from api.bug_items (RLS: Admin, CA and
 * bugfix.fix). Items close through api.bug_resolve (note required, logged); "Run checks again" is api.run_checks.
 * Loaded Tally data is never edited: a fix is a link, a new record or a dated entry.
 */
export function BugFixerPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const can = useCan()
  const qc = useQueryClient()
  const companies = useApiView('companies', { order: 'code' })
  const items = useApiView('bug_items', { order: 'created_at', ascending: false, limit: 2000 })
  const companyList = rowsOf(companies)
  const all = rowsOf(items)
  const [scope, setScope] = useState<string>('all')
  const [area, setArea] = useState<string>('all')
  const [status, setStatus] = useState<Status>('open')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runErr, setRunErr] = useState<RpcError | null>(null)
  const [runResult, setRunResult] = useState<number | null>(null)

  const readOnly = profile?.view === 'all-readonly'
  const canFix = !readOnly && can('bugfix.fix')
  const inScope = scope === 'all' ? all : all.filter((b) => b.company_id === scope)
  const byStatus = status === 'all' ? inScope : inScope.filter((b) => b.status === status)
  const shown = area === 'all' ? byStatus : byStatus.filter((b) => b.area === area)
  const selected = all.find((b) => b.id === selectedId) ?? shown[0]
  const errRef = items.error instanceof ApiError ? items.error.ref : items.error ? makeErrorRef() : null

  const tiles = useMemo(() => {
    const open = inScope.filter((b) => b.status === 'open')
    const perCompany = new Map<string, number>()
    for (const b of open) perCompany.set(b.company_name ?? t('bugFixer.noCompany'), (perCompany.get(b.company_name ?? t('bugFixer.noCompany')) ?? 0) + 1)
    return {
      open: open.length,
      perCompany: [...perCompany.entries()].map(([n, c]) => `${n} ${c}`).join(' · '),
      ca: open.filter((b) => b.who_fixes === 'ca').length,
      fixed: inScope.filter((b) => b.status === 'fixed').length,
      dismissed: inScope.filter((b) => b.status === 'dismissed').length,
    }
  }, [inScope, t])
  const areaCounts = useMemo(() => {
    const m: Record<string, number> = { all: byStatus.length }
    for (const a of AREAS) m[a] = byStatus.filter((b) => b.area === a).length
    return m
  }, [byStatus])

  async function runChecks() {
    const targets = scope === 'all' ? companyList.map((c) => c.id) : [scope]
    setRunning(true)
    setRunErr(null)
    setRunResult(null)
    let added = 0
    try {
      for (const id of targets) {
        const r = await callApi<{ new_items: number }>('run_checks', { p_company_id: id })
        added += r?.new_items ?? 0
      }
      setRunResult(Math.max(added, 0))
    } catch (e) {
      setRunErr(e as RpcError)
    } finally {
      await qc.invalidateQueries({ queryKey: ['api', 'bug_items'] })
      await qc.invalidateQueries({ queryKey: ['api', 'bug_fixer_open_count'] })
      setRunning(false)
    }
  }

  function exportList() {
    const head = ['code', 'title', 'company', 'area', 'kind', 'found_in', 'amount', 'who_fixes', 'status']
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [head.join(',')].concat(shown.map((b) => [b.code, b.title, b.company_name, b.area, b.kind, b.batch_code, b.amount, b.who_fixes, b.status].map(esc).join(',')))
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'bug-fixer.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const columns: Column<Bug>[] = [
    {
      key: 'problem',
      header: t('bugFixer.col.problem'),
      render: (b) => (
        <span style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span className="sf-needs__dot" data-severity={b.severity} aria-hidden="true" />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <button
              type="button"
              className="sf-btn"
              data-variant="link"
              aria-pressed={b.id === selected?.id}
              onClick={() => setSelectedId(b.id)}
              style={{ fontWeight: 600, color: 'var(--sf-text)', textAlign: 'left', textDecoration: b.id === selected?.id ? 'underline' : 'none', padding: 0, minHeight: 24, height: 'auto', whiteSpace: 'normal' }}
            >
              {b.title}
            </button>
            <span className="k">
              <span className="mono">{b.code}</span> · {b.company_name ?? t('bugFixer.noCompany')} · {t(`bugFixer.area.${b.area}`)}
              <span className="sr-only"> · {t(`bugFixer.severity.${b.severity}`)}</span>
            </span>
          </span>
        </span>
      ),
    },
    { key: 'found', header: t('bugFixer.col.foundIn'), render: (b) => <span>{b.batch_code ? <span className="mono">{b.batch_code} · </span> : null}{t(`bugFixer.kind.${b.kind}`)}</span> },
    { key: 'amount', header: t('bugFixer.col.amount'), align: 'right', render: (b) => (b.amount === null ? <span className="muted">—</span> : <Amount value={b.amount} />) },
    { key: 'who', header: t('bugFixer.col.who'), render: (b) => <WhoChip who={b.who_fixes} /> },
  ]
  if (status === 'all') columns.push({ key: 'status', header: t('common.status'), render: (b) => <StatusChipFor status={b.status} /> })

  return (
    <>
      <PageHeader
        title={t('bugFixer.title')}
        subtitle={t('bugFixer.subtitle')}
        actions={
          <>
            <Button onClick={exportList} disabled={shown.length === 0}>
              {t('bugFixer.export')}
            </Button>
            {canFix ? (
              <Button variant="primary" busy={running} onClick={() => void runChecks()} disabled={companyList.length === 0}>
                {t('bugFixer.runChecks')}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="sf-row" style={{ justifyContent: 'space-between' }}>
        {companyList.length > 1 ? (
          companyList.length > 4 ? (
            <div style={{ maxWidth: 420 }}>
              <SelectField
                label={t('common.company')}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                options={[{ value: 'all', label: t('bugFixer.allCompanies') }, ...companyList.map((c) => ({ value: c.id, label: `${c.code} · ${c.short_name || c.name}` }))]}
              />
            </div>
          ) : (
            <div style={{ display: 'flex' }}>
              <Tabs variant="segmented" label={t('common.company')} value={scope} onChange={setScope} tabs={[{ key: 'all', label: t('bugFixer.allCompanies') }, ...companyList.map((c) => ({ key: c.id, label: c.short_name || c.name }))]} />
            </div>
          )
        ) : (
          <span />
        )}
        <span className="k">{readOnly ? t('views.readOnly') : canFix ? t('bugFixer.whoNote') : t('bugFixer.noRight')}</span>
      </div>

      {runErr ? <BugErrorBox error={runErr} /> : null}
      {runResult !== null ? (
        <p className="k" role="status" style={{ margin: 0 }}>
          {t('bugFixer.checked', { count: runResult })}
        </p>
      ) : null}

      <KpiTiles
        ariaLabel={t('bugFixer.tilesLabel')}
        items={[
          { key: 'open', label: t('bugFixer.tiles.open'), value: <span className="mono">{tiles.open}</span>, sub: tiles.perCompany || t('bugFixer.tiles.openNone') },
          { key: 'ca', label: t('bugFixer.tiles.ca'), value: <span className="mono">{tiles.ca}</span>, sub: t('bugFixer.tiles.caSub') },
          { key: 'fixed', label: t('bugFixer.tiles.fixed'), value: <span className="mono">{tiles.fixed}</span>, sub: t('bugFixer.tiles.fixedSub', { count: tiles.dismissed }) },
        ]}
      />

      <div className="sf-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Tabs label={t('bugFixer.areaFilter')} value={area} onChange={setArea} tabs={[{ key: 'all', label: `${t('common.all')} ${areaCounts.all}` }, ...AREAS.map((a) => ({ key: a, label: `${t(`bugFixer.area.${a}`)} ${areaCounts[a]}` }))]} />
        <Tabs label={t('bugFixer.statusFilter')} value={status} onChange={setStatus} tabs={STATUSES.map((s) => ({ key: s, label: t(`bugFixer.status.${s}`) }))} />
      </div>

      {errRef ? <ErrorRef message={t('errors.loadFailed')} next={t('errors.tryAgain')} refId={errRef} /> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(320px, 1fr)', gap: 16, alignItems: 'start' }}>
        <Card pad={false}>
          <DataTable
            caption={t('bugFixer.tableCaption')}
            columns={columns}
            rows={shown}
            rowKey={(b) => b.id}
            loading={items.isLoading}
            minWidth={720}
            empty={
              <EmptyState
                title={all.length === 0 ? t('bugFixer.emptyTitle') : t('bugFixer.emptyFiltered')}
                body={all.length === 0 ? t('bugFixer.emptyBody') : undefined}
                action={
                  all.length === 0 && canFix ? (
                    <Button variant="primary" busy={running} onClick={() => void runChecks()}>
                      {t('bugFixer.runChecks')}
                    </Button>
                  ) : null
                }
              />
            }
          />
        </Card>
        {selected ? (
          <BugDetail key={selected.id} b={selected} company={companyList.find((c) => c.id === selected.company_id)} canFix={canFix} />
        ) : (
          <Card>
            <p className="k" style={{ margin: 0 }}>
              {t('bugFixer.pickOne')}
            </p>
          </Card>
        )}
      </div>

      {profile?.view === 'all' ? <IntegrationsCard /> : null}

      <Card title={t('bugFixer.how.title')}>
        <div className="sf-grid-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i}>
              <strong style={{ fontSize: 13 }}>{t(`bugFixer.how.h${i}`)}</strong>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                {t(`bugFixer.how.p${i}`)}
              </p>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

function WhoChip({ who }: { who: string }) {
  const { t } = useTranslation()
  const tone = who === 'ca' ? 'signal' : who === 'both_books' ? 'transit' : who === 'admin' ? 'info' : 'neutral'
  return <Chip tone={tone}>{t(`bugFixer.who.${who}`)}</Chip>
}

function StatusChipFor({ status }: { status: string }) {
  const { t } = useTranslation()
  if (status === 'fixed')
    return (
      <Chip tone="success" icon="check">
        {t('bugFixer.status.fixed')}
      </Chip>
    )
  if (status === 'dismissed')
    return (
      <Chip tone="neutral" icon="ban">
        {t('bugFixer.status.dismissed')}
      </Chip>
    )
  return (
    <Chip tone="signal" icon="alert">
      {t('bugFixer.status.open')}
    </Chip>
  )
}

function EvidenceList({ data }: { data: Record<string, Json> }) {
  const { t } = useTranslation()
  const entries = Object.entries(data).filter(([k]) => k !== 'row_id')
  if (entries.length === 0) return <p className="k">{t('bugFixer.noEvidence')}</p>
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, auto) 1fr', gap: '4px 12px', margin: 0, fontSize: 13 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt className="muted">{t(`bugFixer.ev.${k}`, { defaultValue: k.replace(/_/g, ' ') })}</dt>
          <dd className={typeof v === 'number' || /gstin|pan|guid|id$|code|batch/.test(k) ? 'mono' : undefined} style={{ margin: 0, wordBreak: 'break-word' }}>
            {show(v)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function BugDetail({ b, company, canFix }: { b: Bug; company: Company | undefined; canFix: boolean }) {
  const { t } = useTranslation()
  const resolve = useApiMutation<{ p_bug_id: string; p_action: Action; p_note: string }>('bug_resolve', [['api', 'bug_items'], ['api', 'bug_fixer_open_count'], ['api', 'parties'], ['api', 'products']])
  const [note, setNote] = useState('')
  const [noteErr, setNoteErr] = useState<string | undefined>()
  const ev = isObj(b.evidence) ? b.evidence : {}
  const open = b.status === 'open'

  function act(action: Action) {
    if (note.trim().length < 5) {
      setNoteErr(t('bugFixer.noteRequired'))
      return
    }
    setNoteErr(undefined)
    resolve.mutate({ p_bug_id: b.id, p_action: action, p_note: note.trim() })
  }

  let evidence: ReactNode
  if (b.kind === 'possible_duplicate' && isObj(ev.incoming)) {
    const existing = isObj(ev.existing) ? ev.existing : ev.existing_id ? { id: ev.existing_id } : {}
    const inc = Object.fromEntries(Object.entries(ev.incoming).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object'))
    evidence = (
      <div className="sf-grid-3" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 10 }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('bugFixer.incoming')}</h4>
          <EvidenceList data={inc} />
        </div>
        <div style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 10 }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('bugFixer.existing')}</h4>
          <EvidenceList data={Object.fromEntries(Object.entries(existing).filter(([k]) => k !== 'id'))} />
          {typeof ev.score === 'number' ? <p className="k" style={{ margin: '6px 0 0' }}>{t('bugFixer.similarity', { pct: Math.round(ev.score * 100) })}</p> : null}
        </div>
      </div>
    )
  } else if (b.kind === 'changed_in_tally') {
    const before = isObj(ev.before) ? ev.before : {}
    const after = isObj(ev.after) ? ev.after : {}
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
    evidence = (
      <div className="sf-table-wrap">
        <table className="sf-table">
          <caption className="sr-only">{t('bugFixer.diffCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('bugFixer.field')}</th>
              <th scope="col">{t('bugFixer.before')}</th>
              <th scope="col">{t('bugFixer.after')}</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted">
                  {t('bugFixer.noDiff')}
                </td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k}>
                  <td>{t(`bugFixer.ev.${k}`, { defaultValue: k.replace(/_/g, ' ') })}</td>
                  <td className="mono" style={{ wordBreak: 'break-word' }}>
                    {show(before[k])}
                  </td>
                  <td className="mono" style={{ wordBreak: 'break-word' }}>
                    → {show(after[k])}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    )
  } else {
    evidence = <EvidenceList data={ev} />
  }

  return (
    <section className="sf-card sf-card__pad" style={{ borderTop: '4px solid var(--sf-primary)', position: 'sticky', top: 16 }} aria-labelledby={`bug-${b.id}`}>
      <div className="sf-row" style={{ justifyContent: 'space-between' }}>
        <span className="k mono">
          {b.code} · {b.company_name ?? t('bugFixer.noCompany')}
        </span>
        <WhoChip who={b.who_fixes} />
      </div>
      <h2 id={`bug-${b.id}`} className="sf-card__title" style={{ fontSize: 17, margin: '8px 0 12px' }}>
        {b.title}
      </h2>
      <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>{t('bugFixer.found')}</h3>
      {evidence}
      {b.kind === 'map_head' || b.kind === 'classify_bills' ? (
        <p style={{ margin: '10px 0 0' }}>
          <Link to={tallyRoute(company)} style={{ fontWeight: 600 }}>
            {b.kind === 'map_head' ? t('bugFixer.toMapping') : t('bugFixer.toClassify')}
          </Link>
        </p>
      ) : null}
      {b.suggested_fix ? (
        <>
          <h3 style={{ fontSize: 13, margin: '14px 0 4px' }}>{t('bugFixer.suggested')}</h3>
          <p style={{ margin: 0 }}>{b.suggested_fix}</p>
        </>
      ) : null}
      <p className="k" style={{ margin: '10px 0 0' }}>
        {t('bugFixer.raised', { date: formatDate(b.created_at) })}
        {b.batch_code ? ` · ${t('bugFixer.fromBatch', { batch: b.batch_code })}` : ''}
        {b.amount !== null ? (
          <>
            {' · '}
            <Amount value={b.amount} />
          </>
        ) : null}
      </p>

      {open ? (
        canFix ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
            <TextAreaField label={t('common.reason')} placeholder={t('bugFixer.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} error={noteErr} />
            <BugErrorBox error={resolve.error} />
            <div className="sf-row" style={{ gap: 8 }}>
              {b.kind === 'possible_duplicate' ? (
                <>
                  <Button variant="primary" busy={resolve.isPending && resolve.variables?.p_action === 'link_existing'} onClick={() => act('link_existing')}>
                    {t('bugFixer.merge')}
                  </Button>
                  <Button busy={resolve.isPending && resolve.variables?.p_action === 'keep_separate'} onClick={() => act('keep_separate')}>
                    {t('bugFixer.keepSeparate')}
                  </Button>
                </>
              ) : null}
              {b.kind === 'changed_in_tally' ? (
                <Button variant="primary" busy={resolve.isPending && resolve.variables?.p_action === 'accept_change'} onClick={() => act('accept_change')}>
                  {t('bugFixer.acceptChange')}
                </Button>
              ) : null}
              <Button variant={b.kind === 'possible_duplicate' || b.kind === 'changed_in_tally' ? 'secondary' : 'primary'} busy={resolve.isPending && resolve.variables?.p_action === 'fixed'} onClick={() => act('fixed')}>
                {t('bugFixer.markFixed')}
              </Button>
              <Button busy={resolve.isPending && resolve.variables?.p_action === 'dismiss'} onClick={() => act('dismiss')}>
                {t('bugFixer.dismiss')}
              </Button>
            </div>
            <p className="k" style={{ margin: 0 }}>
              {t('bugFixer.signNote')}
            </p>
          </div>
        ) : (
          <p className="k" style={{ marginTop: 14 }}>
            {t('bugFixer.noRight')}
          </p>
        )
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <StatusChipFor status={b.status} />
          <p style={{ margin: 0 }}>{b.resolution}</p>
          <p className="k" style={{ margin: 0 }}>
            {t('bugFixer.closedBy', { who: b.fixed_by_name ?? '—', date: b.fixed_at ? formatDate(b.fixed_at) : '—' })}
          </p>
        </div>
      )}
    </section>
  )
}
