import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { currentFyStartYear, fyLabel, todayIst } from '@/features/admin/branches/company'
import { formatDate, formatIndian } from '@/shared/format'
import { Button, Chip, DataTable, Field, FieldGrid, FormDialog, PageHeader, SelectField, TextAreaField, type Column } from '@/ui'

type Fy = ViewRow<'financial_years'>
type Setting = ViewRow<'settings_current'>
type History = ViewRow<'settings_history'>

/**
 * Group-wide limits Admin fixes for everyone. Values are never written here: each one comes from
 * api.settings_current, and the ones the owner or CA has not decided yet show as "Not set".
 */
const GROUP_LIMITS = [
  { key: 'grants.max_days', label: 'grantsMaxDays' },
  { key: 'cash.receipt_block_amount', label: 'cashReceiptBlock' },
  { key: 'cash.payment_warn_amount', label: 'cashPaymentWarn' },
  { key: 'entries.backdate_days', label: 'entriesBackdate' },
  { key: 'work.hours', label: 'workHours' },
] as const

const KEY_RE = /^[a-z_.]+$/

type ValueKind = 'number' | 'text' | 'json'

interface SetDraft {
  company_id: string
  key: string
  fixedKey: boolean
  kind: ValueKind
  value: string
  effective_from: string
  note: string
}

interface FyDraft {
  company_id: string
  start_year: string
}

function showValue(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? formatIndian(String(v), 0) : String(v)
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}
function kindOf(v: unknown): ValueKind {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'string') return 'text'
  return 'json'
}
function rawValue(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'string') return String(v)
  return JSON.stringify(v)
}

/**
 * Settings (/admin/settings): financial years per company and versioned settings. A setting is never edited:
 * each change is a new row with its effective date (api.set_setting), and the earlier values stay in history
 * (api.settings_history). Financial years open through api.open_financial_year.
 */
export function SettingsPage() {
  const { t } = useTranslation()
  const can = useCan()
  const canManage = can('settings.manage')
  const companies = useApiView('companies', { order: 'code' })
  const fys = useApiView('financial_years', { order: 'starts_on', ascending: false })
  const current = useApiView('settings_current', { order: 'key' })
  const setSetting = useApiMutation<{ p_company_id: string | null; p_key: string; p_value: unknown; p_effective_from: string; p_note: string }>('set_setting', [
    ['api', 'settings_current'],
    ['api', 'settings_history'],
  ])
  const openFy = useApiMutation<{ p_company_id: string; p_start_year: number }>('open_financial_year', [['api', 'financial_years'], ['api', 'doc_series']])

  const [sDraft, setSDraft] = useState<SetDraft | null>(null)
  const [sErrors, setSErrors] = useState<Partial<Record<keyof SetDraft, string>>>({})
  const [fDraft, setFDraft] = useState<FyDraft | null>(null)
  const [fError, setFError] = useState<string | undefined>()
  const [hist, setHist] = useState<{ company_id: string | null; key: string } | null>(null)

  const coList = rowsOf(companies)
  const coName = (id: string | null) => (id ? (coList.find((c) => c.id === id)?.short_name ?? '—') : t('settings.group'))
  const settings = rowsOf(current)
  const groupRows = settings.filter((s) => s.company_id === null)
  const extraGroup = groupRows.filter((s) => !GROUP_LIMITS.some((g) => g.key === s.key))
  const companyRows = settings.filter((s) => s.company_id !== null)

  const history = useApiView('settings_history', { order: 'set_at', ascending: false, eq: { key: hist?.key }, enabled: Boolean(hist) })
  const histRows = rowsOf(history)
    .filter((h) => h.company_id === (hist?.company_id ?? null))
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : a.effective_from > b.effective_from ? -1 : a.set_at < b.set_at ? 1 : -1))

  function openSet(company_id: string | null, key: string, existing?: Setting) {
    setSetting.reset()
    setSErrors({})
    setSDraft({
      company_id: company_id ?? '',
      key,
      fixedKey: Boolean(key),
      kind: existing ? kindOf(existing.value) : 'number',
      value: existing ? rawValue(existing.value) : '',
      effective_from: todayIst(),
      note: '',
    })
  }
  function submitSet() {
    if (!sDraft) return
    const e: Partial<Record<keyof SetDraft, string>> = {}
    if (!KEY_RE.test(sDraft.key)) e.key = t('settings.err.key')
    let value: unknown = sDraft.value
    if (sDraft.kind === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(sDraft.value.trim())) e.value = t('settings.err.number')
      else value = Number(sDraft.value.trim())
    } else if (sDraft.kind === 'json') {
      try {
        value = JSON.parse(sDraft.value)
      } catch {
        e.value = t('settings.err.json')
      }
    } else if (!sDraft.value.trim()) e.value = t('settings.err.text')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sDraft.effective_from)) e.effective_from = t('settings.err.date')
    if (sDraft.note.trim().length < 3) e.note = t('settings.err.note')
    setSErrors(e)
    if (Object.keys(e).length) return
    setSetting.mutate(
      { p_company_id: sDraft.company_id || null, p_key: sDraft.key, p_value: value, p_effective_from: sDraft.effective_from, p_note: sDraft.note.trim() },
      {
        onSuccess: () => {
          setHist({ company_id: sDraft.company_id || null, key: sDraft.key })
          setSDraft(null)
        },
      },
    )
  }
  function openFyDialog() {
    openFy.reset()
    setFError(undefined)
    setFDraft({ company_id: coList[0]?.id ?? '', start_year: String(currentFyStartYear()) })
  }
  function submitFy() {
    if (!fDraft) return
    const y = Number(fDraft.start_year)
    if (!fDraft.company_id || !Number.isInteger(y) || y < 2000 || y > 2100) {
      setFError(t('settings.err.year'))
      return
    }
    openFy.mutate({ p_company_id: fDraft.company_id, p_start_year: y }, { onSuccess: () => setFDraft(null) })
  }

  const actions = (company_id: string | null, key: string, s: Setting | undefined, label: string) => (
    <span className="sf-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
      <Button size="sm" variant="link" onClick={() => setHist({ company_id, key })} aria-label={`${t('settings.history')} · ${label}`}>
        {t('settings.history')}
      </Button>
      {canManage ? (
        <Button size="sm" onClick={() => openSet(company_id, key, s)} aria-label={`${s ? t('settings.change') : t('settings.set')} · ${label}`}>
          {s ? t('settings.change') : t('settings.set')}
        </Button>
      ) : null}
    </span>
  )

  type LimitRow = { key: string; label: string; s: Setting | undefined }
  const limitRows: LimitRow[] = [
    ...GROUP_LIMITS.map((g) => ({ key: g.key, label: t(`settings.limits.${g.label}`), s: groupRows.find((r) => r.key === g.key) })),
    ...extraGroup.map((s) => ({ key: s.key, label: s.key, s })),
  ]
  const limitCols: Column<LimitRow>[] = [
    {
      key: 'setting',
      header: t('settings.k.setting'),
      render: (r) => (
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <strong>{r.label}</strong>
          <span className="mono k">{r.key}</span>
        </span>
      ),
    },
    {
      key: 'value',
      header: t('settings.k.value'),
      render: (r) =>
        r.s ? (
          <span className="mono">{showValue(r.s.value)}</span>
        ) : (
          <Chip tone="signal" icon="clock">
            {t('settings.notSet')}
          </Chip>
        ),
    },
    { key: 'from', header: t('settings.k.from'), render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{r.s ? formatDate(r.s.effective_from) : '—'}</span> },
    { key: 'note', header: t('settings.k.note'), render: (r) => r.s?.note ?? '—' },
    { key: 'act', header: <span className="sr-only">{t('settings.k.actions')}</span>, align: 'right', render: (r) => actions(null, r.key, r.s, r.label) },
  ]

  const companyCols: Column<Setting>[] = [
    { key: 'company', header: t('common.company'), render: (s) => coName(s.company_id) },
    { key: 'key', header: t('settings.k.key'), render: (s) => <span className="mono">{s.key}</span> },
    { key: 'value', header: t('settings.k.value'), render: (s) => <span className="mono">{showValue(s.value)}</span> },
    { key: 'from', header: t('settings.k.from'), render: (s) => <span style={{ whiteSpace: 'nowrap' }}>{formatDate(s.effective_from)}</span> },
    { key: 'note', header: t('settings.k.note'), render: (s) => s.note ?? '—' },
    { key: 'act', header: <span className="sr-only">{t('settings.k.actions')}</span>, align: 'right', render: (s) => actions(s.company_id, s.key, s, `${coName(s.company_id)} ${s.key}`) },
  ]

  const fyCols: Column<Fy>[] = [
    { key: 'company', header: t('common.company'), render: (f) => coName(f.company_id) },
    { key: 'label', header: t('settings.k.fy'), render: (f) => <span className="mono">{f.label}</span> },
    { key: 'from', header: t('common.from'), render: (f) => formatDate(f.starts_on) },
    { key: 'to', header: t('common.to'), render: (f) => formatDate(f.ends_on) },
    {
      key: 'status',
      header: t('common.status'),
      render: (f) =>
        f.status === 'open' ? (
          <Chip tone="teal" icon="check">
            {t('settings.fyOpen')}
          </Chip>
        ) : (
          <Chip tone="neutral" icon="lock">
            {t('settings.fyClosed')}
          </Chip>
        ),
    },
    { key: 'closed', header: t('settings.k.closedPeriods'), align: 'right', render: (f) => <span className="mono">{t('settings.periods', { count: f.closed_periods ?? 0 })}</span> },
  ]

  const histCols: Column<History>[] = [
    { key: 'value', header: t('settings.k.value'), render: (h) => <span className="mono">{showValue(h.value)}</span> },
    {
      key: 'from',
      header: t('settings.k.from'),
      render: (h) => (
        <span className="sf-row">
          {formatDate(h.effective_from)}
          {h.effective_from > todayIst() ? <Chip tone="info">{t('settings.future')}</Chip> : null}
        </span>
      ),
    },
    { key: 'note', header: t('settings.k.note'), render: (h) => h.note ?? '—' },
    { key: 'who', header: t('common.who'), render: (h) => h.set_by_name ?? '—' },
    { key: 'when', header: t('common.when'), render: (h) => formatDate(h.set_at) },
  ]

  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />

      {!canManage ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.readOnly')}
        </p>
      ) : null}

      <section className="sf-card" aria-labelledby="set-limits">
        <div className="sf-card__pad" style={{ paddingBottom: 8 }}>
          <h2 id="set-limits" className="sf-card__title">
            {t('settings.limits.title')}
          </h2>
          <p className="k" style={{ margin: '4px 0 0' }}>
            {t('settings.limits.help')}
          </p>
        </div>
        <DataTable caption={t('settings.limits.title')} columns={limitCols} rows={limitRows} rowKey={(r) => r.key} loading={current.isLoading} minWidth={760} />
      </section>

      {hist ? (
        <section className="sf-card" aria-labelledby="set-hist">
          <div className="sf-card__pad sf-card__head" style={{ paddingBottom: 8 }}>
            <div>
              <h2 id="set-hist" className="sf-card__title">
                {t('settings.historyTitle', { key: hist.key, scope: coName(hist.company_id) })}
              </h2>
              <p className="k" style={{ margin: '4px 0 0' }}>
                {t('settings.historyHelp')}
              </p>
            </div>
            <Button size="sm" onClick={() => setHist(null)}>
              {t('common.close')}
            </Button>
          </div>
          <DataTable caption={t('settings.historyTitle', { key: hist.key, scope: coName(hist.company_id) })} columns={histCols} rows={histRows} rowKey={(h) => h.id} loading={history.isLoading} empty={t('settings.historyEmpty')} minWidth={680} />
        </section>
      ) : null}

      <section className="sf-card" aria-labelledby="set-company">
        <div className="sf-card__pad sf-card__head" style={{ paddingBottom: 8 }}>
          <div>
            <h2 id="set-company" className="sf-card__title">
              {t('settings.company.title')}
            </h2>
            <p className="k" style={{ margin: '4px 0 0' }}>
              {t('settings.company.help')}
            </p>
          </div>
          {canManage && coList.length > 0 ? (
            <Button size="sm" onClick={() => openSet(coList[0]?.id ?? null, '')}>
              {t('settings.company.add')}
            </Button>
          ) : null}
        </div>
        <DataTable caption={t('settings.company.title')} columns={companyCols} rows={companyRows} rowKey={(s) => s.id} loading={current.isLoading} empty={t('settings.company.empty')} minWidth={760} />
      </section>

      <section className="sf-card" aria-labelledby="set-fy">
        <div className="sf-card__pad sf-card__head" style={{ paddingBottom: 8 }}>
          <div>
            <h2 id="set-fy" className="sf-card__title">
              {t('settings.fy.title')}
            </h2>
            <p className="k" style={{ margin: '4px 0 0' }}>
              {t('settings.fy.help')}
            </p>
          </div>
          {canManage && coList.length > 0 ? (
            <Button size="sm" onClick={openFyDialog}>
              {t('settings.fy.open')}
            </Button>
          ) : null}
        </div>
        <DataTable caption={t('settings.fy.title')} columns={fyCols} rows={rowsOf(fys)} rowKey={(f) => f.id} loading={fys.isLoading} empty={canManage ? t('settings.fy.emptyAdmin') : t('settings.fy.empty')} minWidth={680} />
      </section>

      <FormDialog
        open={sDraft !== null}
        onOpenChange={(o) => !o && setSDraft(null)}
        title={sDraft?.fixedKey ? t('settings.setTitle', { key: sDraft.key }) : t('settings.addTitle')}
        description={t('settings.formHelp')}
        submitLabel={t('common.save')}
        busy={setSetting.isPending}
        onSubmit={submitSet}
        error={<RpcErrorBox error={setSetting.error as RpcError | null} />}
        wide
      >
        {sDraft ? (
          <FieldGrid>
            <SelectField
              label={t('settings.f.scope')}
              value={sDraft.company_id}
              disabled={sDraft.fixedKey}
              onChange={(e) => setSDraft({ ...sDraft, company_id: e.target.value })}
              options={[{ value: '', label: t('settings.group') }, ...coList.map((c) => ({ value: c.id, label: `${c.code} · ${c.short_name || c.name}` }))]}
            />
            <Field
              label={t('settings.f.key')}
              className="mono"
              value={sDraft.key}
              disabled={sDraft.fixedKey}
              onChange={(e) => setSDraft({ ...sDraft, key: e.target.value.toLowerCase() })}
              error={sErrors.key}
              help={t('settings.f.keyHelp')}
            />
            <SelectField
              label={t('settings.f.kind')}
              value={sDraft.kind}
              onChange={(e) => setSDraft({ ...sDraft, kind: e.target.value as ValueKind })}
              options={(['number', 'text', 'json'] as const).map((k) => ({ value: k, label: t(`settings.kind.${k}`) }))}
            />
            <Field
              label={t('settings.f.value')}
              className="mono"
              value={sDraft.value}
              inputMode={sDraft.kind === 'number' ? 'decimal' : undefined}
              onChange={(e) => setSDraft({ ...sDraft, value: e.target.value })}
              error={sErrors.value}
            />
            <Field
              label={t('settings.f.from')}
              type="date"
              value={sDraft.effective_from}
              onChange={(e) => setSDraft({ ...sDraft, effective_from: e.target.value })}
              error={sErrors.effective_from}
              help={t('settings.f.fromHelp')}
            />
            <div style={{ gridColumn: '1 / -1' }}>
              <TextAreaField label={t('settings.f.note')} value={sDraft.note} onChange={(e) => setSDraft({ ...sDraft, note: e.target.value })} error={sErrors.note} />
            </div>
          </FieldGrid>
        ) : null}
      </FormDialog>

      <FormDialog
        open={fDraft !== null}
        onOpenChange={(o) => !o && setFDraft(null)}
        title={t('settings.fy.openTitle')}
        description={t('settings.fy.openHelp')}
        submitLabel={fDraft && /^\d{4}$/.test(fDraft.start_year) ? t('settings.fy.openLabel', { fy: fyLabel(Number(fDraft.start_year)) }) : t('settings.fy.open')}
        busy={openFy.isPending}
        onSubmit={submitFy}
        error={<RpcErrorBox error={openFy.error as RpcError | null} />}
      >
        {fDraft ? (
          <FieldGrid>
            <SelectField label={t('common.company')} value={fDraft.company_id} onChange={(e) => setFDraft({ ...fDraft, company_id: e.target.value })} options={coList.map((c) => ({ value: c.id, label: `${c.code} · ${c.short_name || c.name}` }))} />
            <Field label={t('settings.fy.startYear')} type="number" inputMode="numeric" value={fDraft.start_year} onChange={(e) => setFDraft({ ...fDraft, start_year: e.target.value })} error={fError} help={t('settings.fy.startYearHelp')} />
          </FieldGrid>
        ) : null}
      </FormDialog>
    </>
  )
}

