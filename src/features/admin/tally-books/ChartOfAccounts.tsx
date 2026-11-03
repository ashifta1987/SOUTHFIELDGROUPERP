import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate } from '@/shared/format'
import { Button, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, SelectField, type Column } from '@/ui'
import type { BatchResult } from '@/features/import/runImport'
import { IMPORT_KEYS, ImportError, useWaitingRows } from '@/features/admin/import-data/ImportHistory'
import { TableCard } from '@/features/admin/import-data/layout'

type Group = ViewRow<'account_groups'>
type Bug = ViewRow<'bug_items'>
type Batch = ViewRow<'import_batches'>

const NATURES = ['asset', 'liability', 'income', 'expense', 'equity'] as const

interface Draft {
  id?: string
  name: string
  nature: string
  parent_id: string
  is_party_group: string
}

/** Chart of accounts for one company: account groups (api.account_groups) with Add/Edit via api.upsert_account_group. */
export function ChartOfAccounts({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const { t } = useTranslation()
  const groups = useApiView('account_groups', { order: 'name', eq: { company_id: companyId } })
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_account_group', [['api', 'account_groups']])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [err, setErr] = useState<string | undefined>()
  const list = rowsOf(groups)
  const nameOf = (id: string | null) => list.find((g) => g.id === id)?.name ?? null

  function open(d: Draft) {
    save.reset()
    setErr(undefined)
    setDraft(d)
  }
  function submit() {
    if (!draft) return
    if (draft.name.trim().length < 2) {
      setErr(t('tallyBooks.coa.errName'))
      return
    }
    const p: Record<string, unknown> = { company_id: companyId, name: draft.name.trim(), nature: draft.nature, is_party_group: draft.is_party_group }
    if (draft.id) p.id = draft.id
    else if (draft.parent_id) p.parent_id = draft.parent_id
    save.mutate({ p }, { onSuccess: () => setDraft(null) })
  }

  const cols: Column<Group>[] = [
    {
      key: 'name',
      header: t('tallyBooks.coa.name'),
      render: (g) => (
        <span>
          <strong style={{ fontWeight: 600 }}>{g.name}</strong>
          {g.parent_id ? <span className="muted">{` · ${nameOf(g.parent_id) ?? ''}`}</span> : null}
        </span>
      ),
    },
    { key: 'nature', header: t('tallyBooks.coa.nature'), render: (g) => t(`tallyBooks.nature.${g.nature}`, { defaultValue: g.nature }) },
    { key: 'party', header: t('tallyBooks.coa.party'), render: (g) => (g.is_party_group ? t(`tallyBooks.partyGroup.${g.is_party_group}`, { defaultValue: g.is_party_group }) : '—') },
    {
      key: 'tally',
      header: t('tallyBooks.coa.tally'),
      render: (g) =>
        (g.tally_groups ?? []).length ? (
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {(g.tally_groups ?? []).map((n) => (
              <Chip key={n} tone="neutral">
                {n}
              </Chip>
            ))}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'accounts', header: t('tallyBooks.coa.accounts'), align: 'right', render: (g) => <span className="mono">{g.account_count ?? 0}</span> },
  ]
  if (canManage) {
    cols.push({
      key: 'edit',
      header: <span className="sr-only">{t('tallyBooks.coa.edit')}</span>,
      render: (g) => (
        <Button size="sm" variant="link" aria-label={`${t('tallyBooks.coa.edit')} ${g.name}`} onClick={() => open({ id: g.id, name: g.name, nature: g.nature, parent_id: g.parent_id ?? '', is_party_group: g.is_party_group ?? '' })}>
          {t('tallyBooks.coa.edit')}
        </Button>
      ),
    })
  }

  return (
    <TableCard
      title={t('tallyBooks.coa.title')}
     
      action={
        canManage ? (
          <Button size="sm" variant="primary" onClick={() => open({ name: '', nature: 'asset', parent_id: '', is_party_group: '' })}>
            {t('tallyBooks.coa.add')}
          </Button>
        ) : null
      }
    >
      <DataTable
        caption={t('tallyBooks.coa.caption')}
        columns={cols}
        rows={list}
        rowKey={(g) => g.id}
        loading={groups.isLoading}
        minWidth={640}
        error={groups.error ? t('errors.loadFailed') : undefined}
        empty={<EmptyState title={t('tallyBooks.coa.empty')} />}
      />
      <FormDialog
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? t('tallyBooks.coa.dialogEdit') : t('tallyBooks.coa.dialogAdd')}
        description={t('tallyBooks.coa.dialogDescription')}
        submitLabel={t('common.save')}
        busy={save.isPending}
        onSubmit={submit}
        error={<RpcErrorBox error={save.error} />}
      >
        {draft ? (
          <>
            <Field label={t('tallyBooks.coa.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={err} required />
            <FieldGrid>
              <SelectField label={t('tallyBooks.coa.nature')} value={draft.nature} onChange={(e) => setDraft({ ...draft, nature: e.target.value })} options={NATURES.map((n) => ({ value: n, label: t(`tallyBooks.nature.${n}`) }))} />
              <SelectField
                label={t('tallyBooks.coa.party')}
                value={draft.is_party_group}
                onChange={(e) => setDraft({ ...draft, is_party_group: e.target.value })}
                options={[
                  { value: '', label: t('tallyBooks.coa.partyNone') },
                  { value: 'debtors', label: t('tallyBooks.partyGroup.debtors') },
                  { value: 'creditors', label: t('tallyBooks.partyGroup.creditors') },
                ]}
              />
            </FieldGrid>
            {!draft.id ? (
              <SelectField
                label={t('tallyBooks.coa.parent')}
                value={draft.parent_id}
                onChange={(e) => setDraft({ ...draft, parent_id: e.target.value })}
                options={[{ value: '', label: t('tallyBooks.coa.noParent') }, ...list.map((g) => ({ value: g.id, label: g.name }))]}
              />
            ) : null}
          </>
        ) : null}
      </FormDialog>
    </TableCard>
  )
}

/**
 * Tally group mapping: open "Map this head" Bug fixer items of the company (api.bug_items, kind map_head) → api.set_tally_group_map,
 * then "Load waiting ledgers again" = api.import_process on each batch that still has rows waiting for a mapping.
 */
export function GroupMapping({ companyId, canManage, canImport, batches }: { companyId: string; canManage: boolean; canImport: boolean; batches: Batch[] }) {
  const { t } = useTranslation()
  const bugs = useApiView('bug_items', { order: 'created_at', eq: { company_id: companyId, kind: 'map_head', status: 'open' }, limit: 200 })
  const groups = useApiView('account_groups', { order: 'name', eq: { company_id: companyId } })
  const mapped = useApiView('tally_group_map', { order: 'tally_group', eq: { company_id: companyId } })
  const setMap = useApiMutation<{ p_company_id: string; p_tally_group: string; p_account_group_id: string }>('set_tally_group_map', [['api', 'bug_items'], ['api', 'tally_group_map'], ['api', 'account_groups'], ['api', 'bug_fixer_open_count']])
  const process = useApiMutation<{ p_batch_id: string }, BatchResult>('import_process', IMPORT_KEYS)
  const processed = batches.filter((b) => b.status === 'processed')
  const waiting = useWaitingRows(processed.map((b) => b.id))
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)

  const groupList = rowsOf(groups)
  const items = rowsOf(bugs)
  const tallyGroupOf = (b: Bug) => {
    const ev = b.evidence as { tally_group?: string } | null
    return ev?.tally_group ?? ''
  }
  // One line per Tally group (several batches can point to the same group).
  const unique = items.filter((b, i) => tallyGroupOf(b) && items.findIndex((x) => tallyGroupOf(x) === tallyGroupOf(b)) === i)
  const waitingBatches = processed.filter((b) => (waiting.data?.[b.id] ?? 0) > 0)

  function summary(r: BatchResult) {
    const parts: string[] = []
    for (const [type, c] of Object.entries(r.counts ?? {})) {
      const bits = Object.entries(c)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${t(`importData.result.${k}`, { defaultValue: k }).toLowerCase()}`)
      if (bits.length) parts.push(`${t(`importData.object.${type}`, { defaultValue: type })} ${bits.join(', ')}`)
    }
    return parts.join(' · ')
  }

  const cols: Column<Bug>[] = [
    { key: 'group', header: t('tallyBooks.map.group'), render: (b) => <strong style={{ fontWeight: 600 }}>{tallyGroupOf(b)}</strong> },
    { key: 'batch', header: t('tallyBooks.map.batch'), render: (b) => <span className="mono">{b.batch_code ?? '—'}</span> },
    {
      key: 'erp',
      header: t('tallyBooks.map.erpGroup'),
      render: (b) => {
        const g = tallyGroupOf(b)
        if (!canManage) return <span className="muted">—</span>
        return (
          <span style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <span style={{ minWidth: 220 }}>
              <SelectField
                label={<span className="sr-only">{t('tallyBooks.map.selectFor', { group: g })}</span>}
                aria-label={t('tallyBooks.map.selectFor', { group: g })}
                value={choice[g] ?? ''}
                onChange={(e) => setChoice({ ...choice, [g]: e.target.value })}
                placeholder={t('tallyBooks.map.choose')}
                options={groupList.map((x) => ({ value: x.id, label: x.name }))}
              />
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={!choice[g]}
              busy={setMap.isPending && setMap.variables?.p_tally_group === g}
              aria-label={t('tallyBooks.map.mapAria', { group: g })}
              onClick={() => setMap.mutate({ p_company_id: companyId, p_tally_group: g, p_account_group_id: choice[g] as string })}
            >
              {t('tallyBooks.map.map')}
            </Button>
          </span>
        )
      },
    },
  ]

  return (
    <TableCard title={t('tallyBooks.map.title')}>
      <div className="sf-card__pad" style={{ paddingBottom: 0 }}>
        <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>
          {t('tallyBooks.map.intro')}
        </p>
        {canManage && groupList.length === 0 && unique.length > 0 ? <p style={{ margin: '0 0 8px' }}>{t('tallyBooks.map.needGroups')}</p> : null}
        <RpcErrorBox error={setMap.error} />
        <ImportError error={process.error} />
      </div>
      <DataTable
        caption={t('tallyBooks.map.caption')}
        columns={cols}
        rows={unique}
        rowKey={(b) => b.id}
        loading={bugs.isLoading}
        minWidth={600}
        error={bugs.error ? t('errors.loadFailed') : undefined}
        empty={<EmptyState title={t('tallyBooks.map.none')} />}
      />
      <div className="sf-card__pad" style={{ display: 'grid', gap: 8 }}>
        {waitingBatches.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            {t('tallyBooks.map.noReload')}
          </span>
        ) : (
          waitingBatches.map((b) => (
            <div key={b.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{t('tallyBooks.map.waiting', { code: b.code, count: waiting.data?.[b.id] ?? 0 })}</span>
              {canImport ? (
                <Button
                  size="sm"
                  variant="primary"
                  busy={process.isPending && process.variables?.p_batch_id === b.id}
                  aria-label={t('tallyBooks.map.reloadAria', { code: b.code })}
                  onClick={() => process.mutate({ p_batch_id: b.id }, { onSuccess: (r) => setDone(t('tallyBooks.map.reloaded', { code: b.code, summary: summary(r) })) })}
                >
                  {t('tallyBooks.map.reload')}
                </Button>
              ) : null}
            </div>
          ))
        )}
        {done ? (
          <p role="status" style={{ margin: 0 }}>
            {done}
          </p>
        ) : null}
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '8px 0 0' }}>{t('tallyBooks.map.mapped')}</h3>
        {rowsOf(mapped).length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            {t('tallyBooks.map.noMapped')}
          </span>
        ) : (
          <ul aria-label={t('tallyBooks.map.mappedCaption')} style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 2, fontSize: 13 }}>
            {rowsOf(mapped).map((m) => (
              <li key={m.tally_group}>
                {`${m.tally_group} → ${m.account_group_name}`} <span className="muted">{`· ${formatDate(m.mapped_at)}`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </TableCard>
  )
}
