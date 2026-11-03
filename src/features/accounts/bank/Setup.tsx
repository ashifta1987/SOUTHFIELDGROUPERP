import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { Amount, Button, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, SelectField, type Column } from '@/ui'
import { cleanAmount, MoneyErrorBox, useCompanyAccounts, useMoneyAccounts, type MoneyAccount } from '@/features/accounts/cash-book/money'

/** Every posting event the RPCs look up (app.rule_account). Posting refuses until each one used is set. */
export const POSTING_EVENTS = [
  'sales.taxable',
  'sales.without_gst',
  'sales.returns',
  'gst.output_cgst',
  'gst.output_sgst',
  'gst.output_igst',
  'gst.input_cgst',
  'gst.input_sgst',
  'gst.input_igst',
  'round_off',
  'purchase.taxable',
  'payroll.salary_expense',
  'payroll.salary_payable',
  'payroll.advances',
  'payroll.deductions',
] as const

interface Draft {
  kind: 'cash' | 'bank'
  name: string
  group_id: string
  bank_name: string
  account_last4: string
  ifsc: string
  opening_balance: string
  opening_dc: 'D' | 'C'
  opening_as_of: string
}

export function Setup({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const { t } = useTranslation()
  const money = useMoneyAccounts(companyId)
  const groups = useApiView('account_groups', { eq: { company_id: companyId }, order: 'name' })
  const rules = useApiView('posting_rules', { eq: { company_id: companyId }, order: 'event' })
  const accounts = useCompanyAccounts(companyId)
  const add = useApiMutation<{ p: Record<string, unknown> }>('add_money_account', [['api', 'money_accounts'], ['api', 'accounts']])
  const setRule = useApiMutation<{ p_company_id: string; p_event: string; p_account_id: string; p_note: string | null }>('set_posting_rule', [['api', 'posting_rules']])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [errs, setErrs] = useState<Partial<Record<keyof Draft, string>>>({})
  const ruleMap = new Map(rowsOf(rules).map((r) => [r.event, r]))
  const missing = POSTING_EVENTS.filter((e) => !ruleMap.has(e)).length

  function open(kind: 'cash' | 'bank') {
    add.reset()
    setErrs({})
    setDraft({ kind, name: '', group_id: '', bank_name: '', account_last4: '', ifsc: '', opening_balance: '', opening_dc: 'D', opening_as_of: todayIst() })
  }

  function submit() {
    if (!draft) return
    const e: Partial<Record<keyof Draft, string>> = {}
    if (draft.name.trim().length < 2) e.name = t('bankReco.setup.errName')
    if (!draft.group_id) e.group_id = t('bankReco.setup.errGroup')
    if (draft.kind === 'bank') {
      if (draft.bank_name.trim().length < 2) e.bank_name = t('bankReco.setup.errBank')
      if (!/^\d{4}$/.test(draft.account_last4.trim())) e.account_last4 = t('bankReco.setup.errLast4')
      if (draft.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(draft.ifsc.trim().toUpperCase())) e.ifsc = t('bankReco.setup.errIfsc')
    }
    const opening = draft.opening_balance ? cleanAmount(draft.opening_balance) : '0.00'
    if (opening === null) e.opening_balance = t('bankReco.setup.errAmount')
    setErrs(e)
    if (Object.keys(e).length) return
    add.mutate(
      {
        p: {
          company_id: companyId,
          kind: draft.kind,
          name: draft.name.trim(),
          group_id: draft.group_id,
          bank_name: draft.kind === 'bank' ? draft.bank_name.trim() : null,
          account_last4: draft.kind === 'bank' ? draft.account_last4.trim() : null,
          ifsc: draft.kind === 'bank' ? draft.ifsc.trim().toUpperCase() : null,
          opening_balance: opening,
          opening_dc: draft.opening_dc,
          opening_as_of: draft.opening_as_of || null,
        },
      },
      { onSuccess: () => setDraft(null) },
    )
  }

  const moneyCols: Column<MoneyAccount>[] = [
    { key: 'name', header: t('bankReco.setup.col.name'), render: (a) => <strong>{a.name}</strong> },
    { key: 'kind', header: t('bankReco.setup.col.kind'), render: (a) => <Chip tone={a.kind === 'bank' ? 'info' : 'teal'}>{t(`bankReco.setup.kind.${a.kind}`)}</Chip> },
    { key: 'bank', header: t('bankReco.setup.col.bank'), render: (a) => (a.kind === 'bank' ? [a.bank_name, a.account_masked].filter(Boolean).join(' · ') : '—') },
    { key: 'ifsc', header: t('bankReco.setup.col.ifsc'), render: (a) => <span className="mono">{a.ifsc ?? '—'}</span> },
    {
      key: 'open',
      header: t('bankReco.setup.col.opening'),
      align: 'right',
      render: (a) => (
        <>
          <Amount value={a.opening_balance} /> <span className="k">{a.opening_dc === 'C' ? 'Cr' : 'Dr'}</span>
        </>
      ),
    },
  ]

  return (
    <>
      <TableCard
        title={t('bankReco.setup.moneyTitle')}
        action={
          canManage ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => open('cash')}>{t('bankReco.setup.addCash')}</Button>
              <Button variant="primary" onClick={() => open('bank')}>
                {t('bankReco.setup.addBank')}
              </Button>
            </div>
          ) : null
        }
      >
        <DataTable
          caption={t('bankReco.setup.moneyTitle')}
          columns={moneyCols}
          rows={money.list}
          rowKey={(a) => a.id}
          loading={money.isLoading}
          empty={<EmptyState title={t('bankReco.setup.moneyEmpty')} body={canManage ? t('bankReco.setup.moneyEmptyBody') : t('bankReco.setup.askAdmin')} />}
        />
      </TableCard>

      <TableCard
        title={t('bankReco.setup.rulesTitle')}
        action={
          missing ? (
            <Chip tone="danger" icon="alert">
              {t('bankReco.setup.missingN', { n: missing })}
            </Chip>
          ) : (
            <Chip tone="success" icon="check">
              {t('bankReco.setup.allSet')}
            </Chip>
          )
        }
      >
        <p className="sf-card__pad k" style={{ margin: 0, paddingTop: 0 }}>
          {t('bankReco.setup.rulesBody')}
        </p>
        {!canManage ? (
          <p className="sf-card__pad k" style={{ margin: 0, paddingTop: 0 }}>
            {t('bankReco.setup.askAdmin')}
          </p>
        ) : null}
        {setRule.error ? (
          <div className="sf-card__pad" style={{ paddingTop: 0 }}>
            <MoneyErrorBox error={setRule.error as RpcError} />
          </div>
        ) : null}
        <DataTable
          caption={t('bankReco.setup.rulesTitle')}
          columns={[
            {
              key: 'event',
              header: t('bankReco.setup.col.event'),
              render: (e: string) => (
                <div>
                  <div style={{ fontWeight: 600 }}>{t(`bankReco.events.${e}`)}</div>
                  <div className="k mono">{e}</div>
                </div>
              ),
            },
            {
              key: 'account',
              header: t('bankReco.setup.col.account'),
              render: (e: string) => {
                const current = ruleMap.get(e)
                if (!canManage) return current?.account_name ?? '—'
                return (
                  <SelectField
                    label={t('bankReco.setup.accountFor', { event: t(`bankReco.events.${e}`) })}
                    value={current?.account_id ?? ''}
                    placeholder={t('bankReco.setup.choose')}
                    disabled={setRule.isPending && setRule.variables?.p_event === e}
                    onChange={(ev) => ev.target.value && setRule.mutate({ p_company_id: companyId, p_event: e, p_account_id: ev.target.value, p_note: null })}
                    options={accounts.list.map((a) => ({ value: a.id, label: `${a.name} · ${a.group_name}` }))}
                  />
                )
              },
            },
            {
              key: 'state',
              header: t('bankReco.setup.col.state'),
              render: (e: string) =>
                ruleMap.has(e) ? (
                  <Chip tone="success" icon="check">
                    {t('bankReco.setup.set')}
                  </Chip>
                ) : (
                  <Chip tone="danger" icon="alert">
                    {t('bankReco.setup.missing')}
                  </Chip>
                ),
            },
          ]}
          rows={[...POSTING_EVENTS]}
          rowKey={(e) => e}
          loading={rules.isLoading || accounts.isLoading}
        />
        {accounts.list.length === 0 && !accounts.isLoading ? (
          <div className="sf-card__pad">
            <EmptyState title={t('bankReco.setup.noAccounts')} body={t('bankReco.setup.noAccountsBody')} />
          </div>
        ) : null}
      </TableCard>

      {draft ? (
        <FormDialog
          open
          onOpenChange={(o) => !o && setDraft(null)}
          title={draft.kind === 'bank' ? t('bankReco.setup.addBank') : t('bankReco.setup.addCash')}
          description={draft.kind === 'bank' ? t('bankReco.setup.bankNote') : undefined}
          submitLabel={t('common.save')}
          busy={add.isPending}
          error={<MoneyErrorBox error={add.error as RpcError | null} />}
          onSubmit={submit}
        >
          <Field label={t('bankReco.setup.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={errs.name} />
          <SelectField
            label={t('bankReco.setup.group')}
            value={draft.group_id}
            placeholder={t('bankReco.setup.choose')}
            onChange={(e) => setDraft({ ...draft, group_id: e.target.value })}
            error={errs.group_id}
            help={rowsOf(groups).length === 0 ? t('bankReco.setup.noGroups') : undefined}
            options={rowsOf(groups).map((g) => ({ value: g.id, label: `${g.name} · ${g.nature}` }))}
          />
          {draft.kind === 'bank' ? (
            <FieldGrid cols={3}>
              <Field label={t('bankReco.setup.bankName')} value={draft.bank_name} onChange={(e) => setDraft({ ...draft, bank_name: e.target.value })} error={errs.bank_name} />
              <Field label={t('bankReco.setup.last4')} inputMode="numeric" maxLength={4} value={draft.account_last4} onChange={(e) => setDraft({ ...draft, account_last4: e.target.value.replace(/\D/g, '') })} error={errs.account_last4} />
              <Field label={t('bankReco.setup.ifsc')} value={draft.ifsc} onChange={(e) => setDraft({ ...draft, ifsc: e.target.value.toUpperCase() })} error={errs.ifsc} />
            </FieldGrid>
          ) : null}
          <FieldGrid cols={3}>
            <Field label={t('bankReco.setup.opening')} prefix="₹" inputMode="decimal" value={draft.opening_balance} onChange={(e) => setDraft({ ...draft, opening_balance: e.target.value })} error={errs.opening_balance} />
            <SelectField
              label={t('bankReco.setup.dc')}
              value={draft.opening_dc}
              onChange={(e) => setDraft({ ...draft, opening_dc: e.target.value as 'D' | 'C' })}
              options={[
                { value: 'D', label: t('bankReco.setup.dr') },
                { value: 'C', label: t('bankReco.setup.cr') },
              ]}
            />
            <Field type="date" label={t('bankReco.setup.asOf')} value={draft.opening_as_of} onChange={(e) => setDraft({ ...draft, opening_as_of: e.target.value })} />
          </FieldGrid>
        </FormDialog>
      ) : null}
    </>
  )
}
