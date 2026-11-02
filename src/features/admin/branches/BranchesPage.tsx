import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate } from '@/shared/format'
import { Button, Card, Checkbox, Chip, ComingInPhase, DataTable, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import { CompanyPicker } from './CompanyPicker'
import { useCompanyChoice, type CompanyRow } from './company'
import { BRANCH_KINDS, BranchDialog, PlaceDialog, PlaceList, emptyBranch, emptyPlace, type BranchDraft, type PlaceDraft } from './dialogs'

type Gstin = ViewRow<'gstins'>
type Branch = ViewRow<'branches'>
type Place = ViewRow<'places'>
type Series = ViewRow<'doc_series'>

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

interface GstinDraft {
  id?: string
  gstin: string
  legal_name: string
  trade_name: string
  registered_on: string
  is_principal: boolean
  einvoice_enabled: boolean
  status: string
}

/** Top rule colour per card (reference: principal place amber, shop teal, branch navy). */
function accentFor(kind: string, principal: boolean) {
  if (principal) return 'var(--sf-signal)'
  if (kind === 'shop') return 'var(--sf-primary)'
  return 'var(--sf-navy)'
}

/**
 * Branches and GSTINs (`Branches`): one card per branch of the chosen company with its GST registration,
 * address, places and next invoice number. Reads api.branches / api.gstins / api.places / api.doc_series;
 * Admin adds and edits through api.upsert_branch, api.upsert_gstin and api.upsert_place.
 */
export function BranchesPage() {
  const { t } = useTranslation()
  const can = useCan()
  const canManage = can('org.manage')
  const { list, company, companyId, choose, isLoading, notReady } = useCompanyChoice()
  const on = Boolean(companyId)
  const branches = useApiView('branches', { order: 'code', eq: { company_id: companyId }, enabled: on })
  const gstins = useApiView('gstins', { order: 'gstin', eq: { company_id: companyId }, enabled: on })
  const places = useApiView('places', { order: 'code', eq: { company_id: companyId }, enabled: on })
  const series = useApiView('doc_series', { order: 'doc_type', eq: { company_id: companyId }, enabled: on })

  const saveGstin = useApiMutation<{ p: Record<string, unknown> }>('upsert_gstin', [['api', 'gstins'], ['api', 'branches'], ['api', 'companies']])
  const [gDraft, setGDraft] = useState<GstinDraft | null>(null)
  const [gErrors, setGErrors] = useState<Partial<Record<keyof GstinDraft, string>>>({})
  const [bDraft, setBDraft] = useState<BranchDraft | null>(null)
  const [pDraft, setPDraft] = useState<PlaceDraft | null>(null)

  const gList = rowsOf(gstins)
  const bList = rowsOf(branches)
  const pList = rowsOf(places)
  const sList = rowsOf(series)
  const principalId = gList.find((g) => g.is_principal)?.id

  function openGstin(g?: Gstin) {
    saveGstin.reset()
    setGErrors({})
    setGDraft(
      g
        ? {
            id: g.id,
            gstin: g.gstin,
            legal_name: g.legal_name ?? '',
            trade_name: g.trade_name ?? '',
            registered_on: g.registered_on ?? '',
            is_principal: g.is_principal,
            einvoice_enabled: g.einvoice_enabled,
            status: g.status,
          }
        : { gstin: '', legal_name: company?.name ?? '', trade_name: '', registered_on: '', is_principal: gList.length === 0, einvoice_enabled: false, status: 'active' },
    )
  }
  function submitGstin() {
    if (!gDraft || !companyId) return
    const e: Partial<Record<keyof GstinDraft, string>> = {}
    const g = gDraft.gstin.trim().toUpperCase()
    if (!gDraft.id) {
      if (!GSTIN_RE.test(g)) e.gstin = t('branches.err.gstin')
      else if (company?.pan && g.slice(2, 12) !== company.pan) e.gstin = t('branches.err.gstinPan', { pan: company.pan })
    }
    setGErrors(e)
    if (Object.keys(e).length) return
    const p: Record<string, unknown> = {
      company_id: companyId,
      legal_name: gDraft.legal_name.trim(),
      trade_name: gDraft.trade_name.trim(),
      registered_on: gDraft.registered_on,
      is_principal: gDraft.is_principal,
      einvoice_enabled: gDraft.einvoice_enabled,
    }
    if (gDraft.id) {
      p.id = gDraft.id
      p.status = gDraft.status
    } else p.gstin = g
    saveGstin.mutate({ p }, { onSuccess: () => setGDraft(null) })
  }

  const gstinCols: Column<Gstin>[] = [
    { key: 'gstin', header: t('branches.k.gstin'), render: (g) => <span className="mono">{g.gstin}</span> },
    { key: 'state', header: t('branches.k.state'), render: (g) => <span className="mono">{g.state_code}</span> },
    { key: 'name', header: t('branches.k.tradeName'), render: (g) => g.trade_name || g.legal_name || '—' },
    { key: 'since', header: t('branches.k.since'), render: (g) => (g.registered_on ? formatDate(g.registered_on) : '—') },
    {
      key: 'flags',
      header: t('branches.k.flags'),
      render: (g) => (
        <span className="sf-row">
          {g.is_principal ? (
            <Chip tone="signal" icon="check">
              {t('branches.principal')}
            </Chip>
          ) : null}
          {g.einvoice_enabled ? <Chip tone="info">{t('branches.einvoice')}</Chip> : null}
          {g.status !== 'active' ? (
            <Chip tone="neutral" icon="ban">
              {t(`branches.gstinStatus.${g.status}`)}
            </Chip>
          ) : null}
        </span>
      ),
    },
    ...(canManage
      ? [
          {
            key: 'edit',
            header: <span className="sr-only">{t('common.edit')}</span>,
            align: 'right' as const,
            render: (g: Gstin) => (
              <Button size="sm" onClick={() => openGstin(g)} aria-label={`${t('common.edit')} ${g.gstin}`}>
                {t('common.edit')}
              </Button>
            ),
          },
        ]
      : []),
  ]

  const loading = isLoading || (on && branches.isLoading)

  return (
    <>
      <PageHeader
        title={t('branches.title')}
        subtitle={company ? t('branches.subtitle', { company: company.name }) : t('branches.subtitleNone')}
        actions={
          canManage && companyId ? (
            <>
              <Button onClick={() => setBDraft(emptyBranch(companyId, 'branch'))}>{t('branches.addBranch')}</Button>
              <Button variant="primary" onClick={() => openGstin()}>
                {t('branches.addGstin')}
              </Button>
            </>
          ) : null
        }
      />

      <CompanyPicker list={list} value={companyId} onChange={choose} />

      {!canManage && !loading && company ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('branches.readOnly')}
        </p>
      ) : null}

      {loading ? (
        <div className="sf-grid-3">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <Skeleton height={140} />
            </Card>
          ))}
        </div>
      ) : !company ? (
        <Card>
          <EmptyState title={t('branches.noCompanyTitle')} body={notReady ? t('branches.notReady') : t('branches.noCompanyBody')} />
        </Card>
      ) : bList.length === 0 ? (
        <Card>
          <EmptyState
            title={t('branches.emptyTitle')}
            body={canManage ? t('branches.emptyBodyAdmin') : t('branches.emptyBody')}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setBDraft(emptyBranch(company.id, 'branch'))}>
                  {t('branches.addBranch')}
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="sf-grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          {bList.map((b) => (
            <BranchCard
              key={b.id}
              b={b}
              gstin={gList.find((g) => g.id === b.gstin_id)}
              principal={Boolean(b.gstin_id && b.gstin_id === principalId)}
              places={pList.filter((p) => p.branch_id === b.id)}
              series={sList.filter((s) => s.doc_type === 'sales_invoice' && s.status === 'active' && Boolean(b.gstin_id) && s.gstin_id === b.gstin_id)}
              onEdit={
                canManage
                  ? () => setBDraft({ id: b.id, company_id: b.company_id, code: b.code, name: b.name, kind: b.kind, gstin_id: b.gstin_id ?? '', address: b.address ?? '', status: b.status })
                  : undefined
              }
              onAddPlace={canManage ? () => setPDraft(emptyPlace(b.id)) : undefined}
              onEditPlace={canManage ? (p) => setPDraft({ id: p.id, branch_id: p.branch_id, code: p.code, name: p.name, kind: p.kind, status: p.status }) : undefined}
            />
          ))}
        </div>
      )}

      {company ? (
        <section className="sf-card" aria-labelledby="gst-regs">
          <div className="sf-card__pad" style={{ paddingBottom: 8 }}>
            <h2 id="gst-regs" className="sf-card__title">
              {t('branches.gstinsTitle')}
            </h2>
            <p className="k" style={{ margin: '4px 0 0' }}>
              {company.pan ? t('branches.gstinsHelpPan', { pan: company.pan }) : t('branches.gstinsHelp')}
            </p>
          </div>
          <DataTable
            caption={t('branches.gstinsTitle')}
            columns={gstinCols}
            rows={gList}
            rowKey={(g) => g.id}
            loading={gstins.isLoading}
            empty={canManage ? t('branches.noGstinAdmin') : t('branches.noGstin')}
            minWidth={640}
          />
        </section>
      ) : null}

      <div className="sf-grid-2">
        <TransferRules />
        <Card title={t('branches.bank.title')} style={{ flex: '1 1 300px' }}>
          <p style={{ marginTop: 0 }}>{t('branches.bank.body')}</p>
          <ComingInPhase phase={3} />
        </Card>
      </div>

      <FormDialog
        open={gDraft !== null}
        onOpenChange={(o) => !o && setGDraft(null)}
        title={gDraft?.id ? t('branches.gstinEditTitle') : t('branches.gstinAddTitle')}
        description={t('branches.gstinFormHelp')}
        submitLabel={t('common.save')}
        busy={saveGstin.isPending}
        onSubmit={submitGstin}
        error={<RpcErrorBox error={saveGstin.error as RpcError | null} />}
        wide
      >
        {gDraft ? <GstinFields draft={gDraft} setDraft={setGDraft} errors={gErrors} company={company} /> : null}
      </FormDialog>

      {bDraft ? <BranchDialog key={bDraft.id ?? 'new'} initial={bDraft} onClose={() => setBDraft(null)} gstins={gList} kinds={BRANCH_KINDS} /> : null}
      {pDraft ? <PlaceDialog key={pDraft.id ?? `new-${pDraft.branch_id}`} initial={pDraft} onClose={() => setPDraft(null)} branches={bList} /> : null}
    </>
  )
}

function GstinFields({
  draft,
  setDraft,
  errors,
  company,
}: {
  draft: GstinDraft
  setDraft: (d: GstinDraft) => void
  errors: Partial<Record<keyof GstinDraft, string>>
  company: CompanyRow | undefined
}) {
  const { t } = useTranslation()
  return (
    <FieldGrid>
      <Field label={t('common.company')} value={company?.name ?? ''} disabled readOnly />
      <Field
        label={t('branches.f.gstin')}
        className="mono"
        value={draft.gstin}
        maxLength={15}
        disabled={Boolean(draft.id)}
        onChange={(e) => setDraft({ ...draft, gstin: e.target.value.toUpperCase().replace(/\s/g, '') })}
        error={errors.gstin}
        help={draft.id ? t('branches.f.gstinLocked') : t('branches.f.gstinHelp')}
      />
      <Field label={t('branches.f.legalName')} value={draft.legal_name} onChange={(e) => setDraft({ ...draft, legal_name: e.target.value })} />
      <Field label={t('branches.f.tradeName')} value={draft.trade_name} onChange={(e) => setDraft({ ...draft, trade_name: e.target.value })} />
      <Field label={t('branches.f.registeredOn')} type="date" value={draft.registered_on} onChange={(e) => setDraft({ ...draft, registered_on: e.target.value })} />
      {draft.id ? (
        <SelectField
          label={t('common.status')}
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          options={['active', 'inactive', 'cancelled'].map((s) => ({ value: s, label: t(`branches.gstinStatus.${s}`) }))}
        />
      ) : null}
      <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Checkbox label={t('branches.f.principal')} hint={t('branches.f.principalHint')} checked={draft.is_principal} onChange={(e) => setDraft({ ...draft, is_principal: e.target.checked })} />
        <Checkbox label={t('branches.f.einvoice')} hint={t('branches.f.einvoiceHint')} checked={draft.einvoice_enabled} onChange={(e) => setDraft({ ...draft, einvoice_enabled: e.target.checked })} />
      </div>
    </FieldGrid>
  )
}

function BranchCard({
  b,
  gstin,
  principal,
  places,
  series,
  onEdit,
  onAddPlace,
  onEditPlace,
}: {
  b: Branch
  gstin: Gstin | undefined
  principal: boolean
  places: Place[]
  series: Series[]
  onEdit?: () => void
  onAddPlace?: () => void
  onEditPlace?: (p: Place) => void
}) {
  const { t } = useTranslation()
  const headId = `br-${b.id}`
  return (
    <section className="sf-card sf-card__pad" style={{ borderTop: `4px solid ${accentFor(b.kind, principal)}` }} aria-labelledby={headId}>
      <div className="sf-card__head" style={{ alignItems: 'flex-start' }}>
        <h2 id={headId} className="sf-card__title" style={{ fontSize: 17 }}>
          {b.name}
        </h2>
        <span className="sf-row">
          {b.status !== 'active' ? (
            <Chip tone="neutral" icon="ban">
              {t('common.inactive')}
            </Chip>
          ) : null}
          <Chip tone={principal ? 'signal' : b.kind === 'shop' ? 'teal' : 'neutral'}>{principal ? t('branches.principal') : t(`branches.kind.${b.kind}`)}</Chip>
        </span>
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: '6px 12px', margin: '10px 0 0', fontSize: 13 }}>
        <dt className="muted">{t('common.code')}</dt>
        <dd className="mono" style={{ margin: 0 }}>
          {b.code}
        </dd>
        <dt className="muted">{t('branches.k.gstin')}</dt>
        <dd style={{ margin: 0 }}>{b.gstin ? <span className="mono">{b.gstin}</span> : <span className="muted">{t('branches.noGstinOnBranch')}</span>}</dd>
        <dt className="muted">{t('branches.k.since')}</dt>
        <dd style={{ margin: 0 }}>{gstin?.registered_on ? formatDate(gstin.registered_on) : '—'}</dd>
        <dt className="muted">{t('branches.k.address')}</dt>
        <dd style={{ margin: 0 }}>{b.address ?? '—'}</dd>
        <dt className="muted">{t('branches.k.bank')}</dt>
        <dd className="muted" style={{ margin: 0 }}>
          {t('common.comingInPhase', { phase: 3 })}
        </dd>
        <dt className="muted">{t('branches.k.invoices')}</dt>
        <dd style={{ margin: 0 }}>
          {series.length === 0 ? (
            <span className="muted">{t('branches.noSeries')}</span>
          ) : (
            series.map((s) => (
              <div key={s.id} className="mono">
                {s.next_number}
              </div>
            ))
          )}
        </dd>
      </dl>
      <PlaceList places={places} onEditPlace={onEditPlace} />
      {onEdit || onAddPlace ? (
        <div className="sf-row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          {onAddPlace ? (
            <Button size="sm" onClick={onAddPlace} aria-label={`${t('branches.addPlace')} · ${b.name}`}>
              {t('branches.addPlace')}
            </Button>
          ) : null}
          {onEdit ? (
            <Button size="sm" onClick={onEdit} aria-label={`${t('common.edit')} ${b.name}`}>
              {t('common.edit')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function TransferRules() {
  const { t } = useTranslation()
  return (
    <section className="sf-card" style={{ flex: '2 1 560px' }} aria-labelledby="gst-moves">
      <div className="sf-card__pad" style={{ paddingBottom: 6 }}>
        <h2 id="gst-moves" className="sf-card__title">
          {t('branches.rules.title')}
        </h2>
      </div>
      <div className="sf-table-wrap">
        <table className="sf-table">
          <caption className="sr-only">{t('branches.rules.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('branches.rules.move')}</th>
              <th scope="col">{t('branches.rules.document')}</th>
              <th scope="col">{t('branches.rules.otherSide')}</th>
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3].map((i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600 }}>{t(`branches.rules.m${i}`)}</td>
                <td>{t(`branches.rules.d${i}`)}</td>
                <td>{t(`branches.rules.o${i}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sf-card__pad" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--sf-text-2)' }}>
        {[1, 2, 3, 4].map((i) => (
          <p key={i} style={{ margin: 0 }}>
            {t(`branches.rules.n${i}`)}
          </p>
        ))}
      </div>
    </section>
  )
}
