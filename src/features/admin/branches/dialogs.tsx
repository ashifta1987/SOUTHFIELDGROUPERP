import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApiMutation, type RpcError } from '@/data/rpc'
import type { ViewRow } from '@/data/queries'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { Button, Field, FieldGrid, FormDialog, SelectField, TextAreaField } from '@/ui'

type Gstin = ViewRow<'gstins'>
type Branch = ViewRow<'branches'>
type Place = ViewRow<'places'>

export const BRANCH_KINDS = ['factory', 'shop', 'branch', 'godown', 'office', 'unit'] as const
export const PLACE_KINDS = ['stores', 'quarantine', 'wip', 'fg_hold', 'fg_released', 'damage', 'transit', 'van', 'agent_consignment', 'other'] as const

const CODE_RE = /^[A-Z0-9-]{2,12}$/

export interface BranchDraft {
  id?: string
  company_id: string
  code: string
  name: string
  kind: string
  gstin_id: string
  address: string
  status: string
}
export interface PlaceDraft {
  id?: string
  branch_id: string
  code: string
  name: string
  kind: string
  status: string
}

export function emptyBranch(companyId: string, kind: string): BranchDraft {
  return { company_id: companyId, code: '', name: '', kind, gstin_id: '', address: '', status: 'active' }
}
export function emptyPlace(branchId: string): PlaceDraft {
  return { branch_id: branchId, code: '', name: '', kind: 'stores', status: 'active' }
}

const INVALIDATE = [['api', 'branches'], ['api', 'places'], ['api', 'companies']]

/** Add or edit a branch / unit through api.upsert_branch. The code is fixed once saved. Mount it (with a key) to open it. */
export function BranchDialog({ initial, onClose, gstins, kinds, title }: { initial: BranchDraft; onClose: () => void; gstins: Gstin[]; kinds: readonly string[]; title?: { add: string; edit: string } }) {
  const { t } = useTranslation()
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_branch', INVALIDATE)
  const [draft, setDraft] = useState<BranchDraft>(initial)
  const [errors, setErrors] = useState<Partial<Record<keyof BranchDraft, string>>>({})

  function submit() {
    if (!draft) return
    const e: Partial<Record<keyof BranchDraft, string>> = {}
    if (!draft.id && !CODE_RE.test(draft.code.trim())) e.code = t('branches.err.code')
    if (draft.name.trim().length < 2) e.name = t('branches.err.name')
    setErrors(e)
    if (Object.keys(e).length) return
    const p: Record<string, unknown> = {
      company_id: draft.company_id,
      name: draft.name.trim(),
      kind: draft.kind,
      gstin_id: draft.gstin_id,
      address: draft.address.trim(),
    }
    if (draft.id) {
      p.id = draft.id
      p.status = draft.status
    } else p.code = draft.code.trim().toUpperCase()
    save.mutate({ p }, { onSuccess: onClose })
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={draft?.id ? (title?.edit ?? t('branches.branchEditTitle')) : (title?.add ?? t('branches.branchAddTitle'))}
      description={t('branches.branchFormHelp')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      onSubmit={submit}
      error={<RpcErrorBox error={save.error as RpcError | null} />}
      wide
    >
      {draft ? (
        <FieldGrid>
          <Field
            label={t('branches.f.code')}
            className="mono"
            value={draft.code}
            maxLength={12}
            disabled={Boolean(draft.id)}
            onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
            error={errors.code}
            help={t('branches.f.codeHelp')}
          />
          <Field label={t('branches.f.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={errors.name} />
          <SelectField label={t('branches.f.kind')} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} options={kinds.map((k) => ({ value: k, label: t(`branches.kind.${k}`) }))} />
          <SelectField
            label={t('branches.f.gstin')}
            value={draft.gstin_id}
            onChange={(e) => setDraft({ ...draft, gstin_id: e.target.value })}
            placeholder={t('branches.f.noGstin')}
            options={gstins.filter((g) => g.status === 'active' || g.id === draft.gstin_id).map((g) => ({ value: g.id, label: `${g.gstin}${g.trade_name ? ` · ${g.trade_name}` : ''}` }))}
            help={t('branches.f.gstinOnBranchHelp')}
          />
          {draft.id ? (
            <SelectField
              label={t('common.status')}
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              options={[
                { value: 'active', label: t('common.active') },
                { value: 'inactive', label: t('common.inactive') },
              ]}
            />
          ) : null}
          <div style={{ gridColumn: '1 / -1' }}>
            <TextAreaField label={t('branches.f.address')} value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
          </div>
        </FieldGrid>
      ) : null}
    </FormDialog>
  )
}

/** Add or edit a place (stock location) inside a branch through api.upsert_place. */
export function PlaceDialog({ initial, onClose, branches }: { initial: PlaceDraft; onClose: () => void; branches: Branch[] }) {
  const { t } = useTranslation()
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_place', INVALIDATE)
  const [draft, setDraft] = useState<PlaceDraft>(initial)
  const [errors, setErrors] = useState<Partial<Record<keyof PlaceDraft, string>>>({})

  const branch = branches.find((b) => b.id === draft?.branch_id)

  function submit() {
    if (!draft) return
    const e: Partial<Record<keyof PlaceDraft, string>> = {}
    if (!draft.id && !CODE_RE.test(draft.code.trim())) e.code = t('branches.err.code')
    if (draft.name.trim().length < 2) e.name = t('branches.err.name')
    setErrors(e)
    if (Object.keys(e).length) return
    const p: Record<string, unknown> = { branch_id: draft.branch_id, name: draft.name.trim(), kind: draft.kind }
    if (draft.id) {
      p.id = draft.id
      p.status = draft.status
    } else p.code = draft.code.trim().toUpperCase()
    save.mutate({ p }, { onSuccess: onClose })
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={draft?.id ? t('branches.placeEditTitle') : t('branches.placeAddTitle', { branch: branch?.name ?? '' })}
      description={t('branches.placeFormHelp')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      onSubmit={submit}
      error={<RpcErrorBox error={save.error as RpcError | null} />}
    >
      {draft ? (
        <FieldGrid>
          <Field
            label={t('branches.f.placeCode')}
            className="mono"
            value={draft.code}
            maxLength={12}
            disabled={Boolean(draft.id)}
            onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
            error={errors.code}
            help={t('branches.f.placeCodeHelp')}
          />
          <Field label={t('branches.f.placeName')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={errors.name} />
          <SelectField label={t('branches.f.placeKind')} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} options={PLACE_KINDS.map((k) => ({ value: k, label: t(`branches.placeKind.${k}`) }))} />
          {draft.id ? (
            <SelectField
              label={t('common.status')}
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              options={[
                { value: 'active', label: t('common.active') },
                { value: 'inactive', label: t('common.inactive') },
              ]}
            />
          ) : null}
        </FieldGrid>
      ) : null}
    </FormDialog>
  )
}

/** The places (stock locations) of one branch, with an edit link each when allowed. */
export function PlaceList({ places, onEditPlace }: { places: Place[]; onEditPlace?: (p: Place) => void }) {
  const { t } = useTranslation()
  return (
    <>
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '14px 0 6px' }}>{t('branches.placesTitle', { count: places.length })}</h3>
      {places.length === 0 ? (
        <p className="k" style={{ margin: 0 }}>
          {t('branches.noPlaces')}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {places.map((p) => (
            <li key={p.id} className="sf-row" style={{ justifyContent: 'space-between', fontSize: 13, flexWrap: 'nowrap' }}>
              <span>
                <span className="mono">{p.code}</span> · {p.name} <span className="k">· {t(`branches.placeKind.${p.kind}`)}</span>
                {p.status !== 'active' ? <span className="k"> · {t('common.inactive')}</span> : null}
              </span>
              {onEditPlace ? (
                <Button size="sm" variant="link" onClick={() => onEditPlace(p)} aria-label={`${t('common.edit')} ${p.name}`}>
                  {t('common.edit')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
