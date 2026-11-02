import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { BranchDialog, PlaceDialog, PlaceList, emptyBranch, emptyPlace, type BranchDraft, type PlaceDraft } from '@/features/admin/branches/dialogs'
import { Button, Card, Chip, EmptyState, Field, FormDialog, PageHeader, SelectField, Skeleton } from '@/ui'

type Branch = ViewRow<'branches'>
type Place = ViewRow<'places'>
type Department = ViewRow<'departments'>

/** Branch kinds that are production / storage units (the rest are shown on Branches and GSTINs). */
const UNIT_KINDS = ['unit', 'factory', 'godown'] as const

function accentFor(kind: string) {
  if (kind === 'godown') return 'var(--sf-signal)'
  if (kind === 'factory') return 'var(--sf-navy)'
  return 'var(--sf-primary)'
}

interface DeptDraft {
  id?: string
  name: string
  status: string
}

/**
 * Units (`Units`): the company's production and storage units (branches of kind unit, factory or godown)
 * with their stock places, plus departments. Reads api.branches / api.places / api.departments;
 * Admin changes them through api.upsert_branch, api.upsert_place and api.upsert_department.
 */
export function UnitsPage() {
  const { t } = useTranslation()
  const can = useCan()
  const canManage = can('org.manage')
  const { list, company, companyId, choose, isLoading, notReady } = useCompanyChoice()
  const on = Boolean(companyId)
  const branches = useApiView('branches', { order: 'code', eq: { company_id: companyId }, enabled: on })
  const places = useApiView('places', { order: 'code', eq: { company_id: companyId }, enabled: on })
  const gstins = useApiView('gstins', { order: 'gstin', eq: { company_id: companyId }, enabled: on })
  const departments = useApiView('departments', { order: 'name', eq: { company_id: companyId }, enabled: on })
  const saveDept = useApiMutation<{ p: Record<string, unknown> }>('upsert_department', [['api', 'departments']])

  const [bDraft, setBDraft] = useState<BranchDraft | null>(null)
  const [pDraft, setPDraft] = useState<PlaceDraft | null>(null)
  const [dDraft, setDDraft] = useState<DeptDraft | null>(null)
  const [dError, setDError] = useState<string | undefined>()

  const allBranches = rowsOf(branches)
  const units = allBranches.filter((b) => (UNIT_KINDS as readonly string[]).includes(b.kind))
  const pList = rowsOf(places)
  const dList = rowsOf(departments)
  const activeUnits = units.filter((u) => u.status === 'active').length

  function openDept(d?: Department) {
    saveDept.reset()
    setDError(undefined)
    setDDraft(d ? { id: d.id, name: d.name, status: d.status } : { name: '', status: 'active' })
  }
  function submitDept() {
    if (!dDraft || !companyId) return
    if (dDraft.name.trim().length < 2) {
      setDError(t('units.err.deptName'))
      return
    }
    const p: Record<string, unknown> = { company_id: companyId, name: dDraft.name.trim() }
    if (dDraft.id) {
      p.id = dDraft.id
      p.status = dDraft.status
    }
    saveDept.mutate({ p }, { onSuccess: () => setDDraft(null) })
  }

  const loading = isLoading || (on && branches.isLoading)

  return (
    <>
      <PageHeader
        title={t('units.title')}
        subtitle={company && activeUnits > 0 ? t('units.subtitle', { count: activeUnits, company: company.name }) : t('units.subtitleNone')}
        actions={
          canManage && companyId ? (
            <Button variant="primary" onClick={() => setBDraft(emptyBranch(companyId, 'unit'))}>
              {t('units.add')}
            </Button>
          ) : null
        }
      />

      <CompanyPicker list={list} value={companyId} onChange={choose} />

      {!canManage && !loading && company ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('units.readOnly')}
        </p>
      ) : null}

      {loading ? (
        <div className="sf-grid-3">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <Skeleton height={160} />
            </Card>
          ))}
        </div>
      ) : !company ? (
        <Card>
          <EmptyState title={t('branches.noCompanyTitle')} body={notReady ? t('branches.notReady') : t('branches.noCompanyBody')} />
        </Card>
      ) : units.length === 0 ? (
        <Card>
          <EmptyState
            title={t('units.emptyTitle')}
            body={canManage ? t('units.emptyBodyAdmin') : t('units.emptyBody')}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setBDraft(emptyBranch(company.id, 'unit'))}>
                  {t('units.add')}
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="sf-grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          {units.map((u) => (
            <UnitCard
              key={u.id}
              u={u}
              places={pList.filter((p) => p.branch_id === u.id)}
              onEdit={canManage ? () => setBDraft({ id: u.id, company_id: u.company_id, code: u.code, name: u.name, kind: u.kind, gstin_id: u.gstin_id ?? '', address: u.address ?? '', status: u.status }) : undefined}
              onAddPlace={canManage ? () => setPDraft(emptyPlace(u.id)) : undefined}
              onEditPlace={canManage ? (p) => setPDraft({ id: p.id, branch_id: p.branch_id, code: p.code, name: p.name, kind: p.kind, status: p.status }) : undefined}
            />
          ))}
        </div>
      )}

      <div className="sf-grid-2">
        <Card title={t('units.moving.title')} labelledBy="units-moving" style={{ flex: '2 1 560px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {['note', 'price', 'moulds', 'gstin'].map((k) => (
              <p key={k} style={{ margin: 0 }}>
                <strong>{t(`units.moving.${k}Lead`)}</strong> {t(`units.moving.${k}`)}
              </p>
            ))}
          </div>
        </Card>
        <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {company ? (
            <Card
              title={t('units.depts.title')}
              labelledBy="units-depts"
              action={
                canManage ? (
                  <Button size="sm" onClick={() => openDept()}>
                    {t('units.depts.add')}
                  </Button>
                ) : null
              }
            >
              {departments.isLoading ? (
                <Skeleton height={60} />
              ) : dList.length === 0 ? (
                <p className="k" style={{ margin: 0 }}>
                  {canManage ? t('units.depts.emptyAdmin') : t('units.depts.empty')}
                </p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dList.map((d) => (
                    <li key={d.id} className="sf-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                      <span>
                        <strong>{d.name}</strong>
                        {d.status !== 'active' ? <span className="k"> · {t('common.inactive')}</span> : null}
                      </span>
                      {canManage ? (
                        <Button size="sm" variant="link" onClick={() => openDept(d)} aria-label={`${t('common.edit')} ${d.name}`}>
                          {t('common.edit')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
          <Card title={t('units.reports.title')} labelledBy="units-reports">
            <p style={{ margin: 0 }}>{t('units.reports.body')}</p>
          </Card>
        </div>
      </div>

      {bDraft ? (
        <BranchDialog
          key={bDraft.id ?? 'new'}
          initial={bDraft}
          onClose={() => setBDraft(null)}
          gstins={rowsOf(gstins)}
          kinds={UNIT_KINDS}
          title={{ add: t('units.addTitle'), edit: t('units.editTitle') }}
        />
      ) : null}
      {pDraft ? <PlaceDialog key={pDraft.id ?? `new-${pDraft.branch_id}`} initial={pDraft} onClose={() => setPDraft(null)} branches={allBranches} /> : null}

      <FormDialog
        open={dDraft !== null}
        onOpenChange={(o) => !o && setDDraft(null)}
        title={dDraft?.id ? t('units.depts.editTitle') : t('units.depts.addTitle')}
        description={t('units.depts.help')}
        submitLabel={t('common.save')}
        busy={saveDept.isPending}
        onSubmit={submitDept}
        error={<RpcErrorBox error={saveDept.error as RpcError | null} />}
      >
        {dDraft ? (
          <>
            <Field label={t('units.depts.name')} value={dDraft.name} onChange={(e) => setDDraft({ ...dDraft, name: e.target.value })} error={dError} />
            {dDraft.id ? (
              <SelectField
                label={t('common.status')}
                value={dDraft.status}
                onChange={(e) => setDDraft({ ...dDraft, status: e.target.value })}
                options={[
                  { value: 'active', label: t('common.active') },
                  { value: 'inactive', label: t('common.inactive') },
                ]}
              />
            ) : null}
          </>
        ) : null}
      </FormDialog>
    </>
  )
}

function UnitCard({ u, places, onEdit, onAddPlace, onEditPlace }: { u: Branch; places: Place[]; onEdit?: () => void; onAddPlace?: () => void; onEditPlace?: (p: Place) => void }) {
  const { t } = useTranslation()
  const headId = `unit-${u.id}`
  return (
    <section className="sf-card sf-card__pad" style={{ borderTop: `4px solid ${accentFor(u.kind)}` }} aria-labelledby={headId}>
      <div className="sf-card__head" style={{ alignItems: 'flex-start' }}>
        <h2 id={headId} className="sf-card__title" style={{ fontSize: 17 }}>
          {u.name}
        </h2>
        <span className="mono k">{u.code}</span>
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '6px 12px', margin: '10px 0 0', fontSize: 13 }}>
        <dt className="muted">{t('units.k.kind')}</dt>
        <dd style={{ margin: 0 }}>{t(`branches.kind.${u.kind}`)}</dd>
        <dt className="muted">{t('branches.k.gstin')}</dt>
        <dd style={{ margin: 0 }}>{u.gstin ? <span className="mono">{u.gstin}</span> : <span className="muted">{t('branches.noGstinOnBranch')}</span>}</dd>
        <dt className="muted">{t('branches.k.address')}</dt>
        <dd style={{ margin: 0 }}>{u.address ?? '—'}</dd>
        <dt className="muted">{t('units.k.machines')}</dt>
        <dd className="muted" style={{ margin: 0 }}>
          {t('units.machinesLater')}
        </dd>
      </dl>
      <PlaceList places={places} onEditPlace={onEditPlace} />
      <div className="sf-row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
        {u.status !== 'active' ? (
          <Chip tone="neutral" icon="ban">
            {t('common.inactive')}
          </Chip>
        ) : (
          <span />
        )}
        <span className="sf-row">
          {onAddPlace ? (
            <Button size="sm" onClick={onAddPlace} aria-label={`${t('branches.addPlace')} · ${u.name}`}>
              {t('branches.addPlace')}
            </Button>
          ) : null}
          {onEdit ? (
            <Button size="sm" onClick={onEdit} aria-label={`${t('common.edit')} ${u.name}`}>
              {t('common.edit')}
            </Button>
          ) : null}
        </span>
      </div>
    </section>
  )
}
