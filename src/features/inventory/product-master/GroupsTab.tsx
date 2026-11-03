import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { Button, Card, DataTable, EmptyState, Field, FieldGrid, FormDialog, SelectField, type Column } from '@/ui'
import { KINDS } from './shared'

type Group = ViewRow<'product_groups'>
interface Draft {
  id?: string
  name: string
  kind: string
  parent_id: string
  company_id: string
}

/** Groups tab: api.product_groups; Admin adds and edits through api.upsert_product_group. */
export function GroupsTab({ canManage, draft, setDraft }: { canManage: boolean; draft: Draft | null; setDraft: (d: Draft | null) => void }) {
  const { t } = useTranslation()
  const groupsQ = useApiView('product_groups', { order: 'name' })
  const companies = rowsOf(useApiView('companies', { order: 'code' }))
  const groups = rowsOf(groupsQ)
  const byId = new Map(groups.map((g) => [g.id, g.name]))
  const companyName = new Map(companies.map((c) => [c.id, c.short_name || c.name]))

  const columns: Column<Group>[] = [
    { key: 'name', header: t('productMaster.g.name'), render: (g) => <strong style={{ fontWeight: 600 }}>{g.name}</strong> },
    { key: 'kind', header: t('productMaster.g.kind'), render: (g) => t(`productMaster.kind.${g.kind}`) },
    { key: 'parent', header: t('productMaster.g.parent'), render: (g) => (g.parent_id ? byId.get(g.parent_id) : <span className="muted">—</span>) },
    { key: 'company', header: t('productMaster.g.company'), render: (g) => (g.company_id ? companyName.get(g.company_id) : t('productMaster.g.shared')) },
    { key: 'tally', header: t('productMaster.g.tally'), render: (g) => (g.tally_name ? <span className="mono">{g.tally_name}</span> : <span className="muted">—</span>) },
    { key: 'count', header: t('productMaster.g.count'), align: 'right', render: (g) => <span className="mono">{g.product_count ?? 0}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">{t('productMaster.col.actions')}</span>,
      render: (g) =>
        canManage ? (
          <Button size="sm" aria-label={t('productMaster.editFor', { name: g.name })} onClick={() => setDraft({ id: g.id, name: g.name, kind: g.kind, parent_id: g.parent_id ?? '', company_id: g.company_id ?? '' })}>
            {t('common.edit')}
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      <Card pad={false}>
        <div className="sf-card__pad" style={{ paddingBottom: 8 }}>
          <div className="sf-card__head">
            <h2 className="sf-card__title">{t('productMaster.g.title')}</h2>
          </div>
          <p className="k" style={{ margin: 0, fontSize: 13 }}>
            {t('productMaster.g.help')}
          </p>
        </div>
        <DataTable
          caption={t('productMaster.g.title')}
          columns={columns}
          rows={groups}
          rowKey={(g) => g.id}
          loading={groupsQ.isLoading}
          empty={
            <EmptyState
              title={t('productMaster.g.emptyTitle')}
              body={canManage ? t('productMaster.g.emptyBodyAdmin') : t('productMaster.g.emptyBody')}
              action={
                canManage ? (
                  <Button variant="primary" onClick={() => setDraft({ name: '', kind: 'finished', parent_id: '', company_id: '' })}>
                    {t('productMaster.newGroup')}
                  </Button>
                ) : null
              }
            />
          }
        />
      </Card>
      {draft ? <GroupDialog draft={draft} groups={groups} companies={companies} onClose={() => setDraft(null)} /> : null}
    </>
  )
}

export type GroupDraft = Draft

function GroupDialog({ draft: initial, groups, companies, onClose }: { draft: Draft; groups: Group[]; companies: ViewRow<'companies'>[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(initial)
  const [err, setErr] = useState<string | undefined>()
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_product_group', [['api', 'product_groups'], ['api', 'products']])

  function submit() {
    if (draft.name.trim().length < 2) {
      setErr(t('productMaster.err.name'))
      return
    }
    setErr(undefined)
    const p: Record<string, unknown> = { name: draft.name.trim(), kind: draft.kind, parent_id: draft.parent_id }
    if (draft.id) p.id = draft.id
    else p.company_id = draft.company_id
    save.mutate({ p }, { onSuccess: onClose })
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={draft.id ? t('productMaster.g.editTitle') : t('productMaster.g.addTitle')}
      description={t('productMaster.g.formHelp')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      onSubmit={submit}
      error={<RpcErrorBox error={save.error as RpcError | null} />}
    >
      <FieldGrid>
        <Field label={t('productMaster.g.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={err} />
        <SelectField
          label={t('productMaster.g.kind')}
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
          options={KINDS.map((k) => ({ value: k, label: t(`productMaster.kind.${k}`) }))}
        />
        <SelectField
          label={t('productMaster.g.parent')}
          value={draft.parent_id}
          onChange={(e) => setDraft({ ...draft, parent_id: e.target.value })}
          placeholder={t('common.none')}
          options={groups.filter((g) => g.id !== draft.id).map((g) => ({ value: g.id, label: g.name }))}
        />
        <SelectField
          label={t('productMaster.g.company')}
          value={draft.company_id}
          disabled={Boolean(draft.id)}
          onChange={(e) => setDraft({ ...draft, company_id: e.target.value })}
          placeholder={t('productMaster.g.shared')}
          options={companies.map((c) => ({ value: c.id, label: c.short_name || c.name }))}
        />
      </FieldGrid>
    </FormDialog>
  )
}
