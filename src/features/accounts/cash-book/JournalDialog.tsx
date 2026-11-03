import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { Amount, Button, Field, FieldGrid, FormDialog, SelectField } from '@/ui'
import { cleanAmount, fromPaise, MoneyErrorBox, sumPaise, useCompanyAccounts, useMoneyAccounts } from './money'

interface Line {
  account_id: string
  dr: string
  cr: string
}
const EMPTY: Line = { account_id: '', dr: '', cr: '' }

/**
 * Journal or contra voucher (api.post_journal). Contra moves money between cash and bank accounts only; the server
 * refuses an unbalanced voucher. The Dr/Cr totals shown are only the sum of what was typed.
 */
export function JournalDialog({ companyId, date: initialDate, onClose }: { companyId: string; date: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [type, setType] = useState<'journal' | 'contra'>('journal')
  const [date, setDate] = useState(initialDate)
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }, { ...EMPTY }])
  const [err, setErr] = useState<string | undefined>()
  const accounts = useCompanyAccounts(companyId)
  const money = useMoneyAccounts(companyId)
  const m = useApiMutation<{ p: Record<string, unknown> }>('post_journal', [['api', 'account_ledger'], ['api', 'vouchers']])
  const options = (type === 'contra' ? money.list.map((a) => ({ id: a.id, name: a.name })) : accounts.list.map((a) => ({ id: a.id, name: `${a.name} · ${a.group_name}` }))).map((a) => ({
    value: a.id,
    label: a.name,
  }))

  function set(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  function submit() {
    const out = []
    for (const l of lines) {
      if (!l.account_id && !l.dr && !l.cr) continue
      const dr = l.dr ? cleanAmount(l.dr) : '0.00'
      const cr = l.cr ? cleanAmount(l.cr) : '0.00'
      if (!l.account_id || dr === null || cr === null) return setErr(t('cashBook.journalDlg.errLine'))
      out.push({ account_id: l.account_id, dr, cr })
    }
    if (out.length < 2) return setErr(t('cashBook.journalDlg.errLines'))
    setErr(undefined)
    m.mutate({ p: { company_id: companyId, date, type, narration: narration.trim() || null, lines: out } }, { onSuccess: onClose })
  }

  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={t('cashBook.journalDlg.title')}
      description={t('cashBook.journalDlg.body')}
      submitLabel={t('cashBook.journalDlg.post')}
      busy={m.isPending}
      error={
        <>
          {err ? (
            <p className="sf-field__msg" role="alert">
              {err}
            </p>
          ) : null}
          <MoneyErrorBox error={m.error as RpcError | null} />
        </>
      }
      onSubmit={submit}
    >
      <FieldGrid cols={3}>
        <SelectField
          label={t('cashBook.journalDlg.type')}
          value={type}
          onChange={(e) => setType(e.target.value as 'journal' | 'contra')}
          options={[
            { value: 'journal', label: t('cashBook.types.journal') },
            { value: 'contra', label: t('cashBook.types.contra') },
          ]}
        />
        <Field type="date" label={t('cashBook.entry.date')} value={date} onChange={(e) => setDate(e.target.value)} />
        <Field label={t('cashBook.entry.narration')} value={narration} onChange={(e) => setNarration(e.target.value)} />
      </FieldGrid>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) 1fr 1fr', gap: 8 }}>
          <SelectField label={t('cashBook.journalDlg.account', { n: i + 1 })} value={l.account_id} placeholder={t('cashBook.entry.choose')} onChange={(e) => set(i, { account_id: e.target.value })} options={options} />
          <Field label={t('cashBook.journalDlg.dr', { n: i + 1 })} inputMode="decimal" value={l.dr} onChange={(e) => set(i, { dr: e.target.value, cr: e.target.value ? '' : l.cr })} />
          <Field label={t('cashBook.journalDlg.cr', { n: i + 1 })} inputMode="decimal" value={l.cr} onChange={(e) => set(i, { cr: e.target.value, dr: e.target.value ? '' : l.dr })} />
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button size="sm" onClick={() => setLines((ls) => [...ls, { ...EMPTY }])}>
          {t('cashBook.journalDlg.addLine')}
        </Button>
        <span className="k">
          {t('cashBook.journalDlg.typed')} <Amount value={fromPaise(sumPaise(lines, (l) => cleanAmount(l.dr) ?? 0))} /> / <Amount value={fromPaise(sumPaise(lines, (l) => cleanAmount(l.cr) ?? 0))} />
        </span>
      </div>
    </FormDialog>
  )
}
