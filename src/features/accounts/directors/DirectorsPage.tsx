import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { ViewError } from '@/features/production/biochem-common/biochem'
import { CompanyFrame, NoteCard, OPS_REFRESH, OpsErrorBox, TwoCol, useOpsRights } from '@/features/production/ops-common/ops'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, Field, FieldGrid, FormDialog, KeyValue, SelectField, TextAreaField, type Column } from '@/ui'

type Loan = ViewRow<'v_director_loans'>
type Declaration = ViewRow<'v_director_declarations'>
type Req = ViewRow<'v_partner_requests'>

/**
 * Accounts → Directors and investment (`Directors`): who runs each company (directors from api.v_partners), money lent
 * to or by a director or partner (api.record_director_loan, posted to their loan account and the bank, with the
 * Companies Act checks: s.185 for directors, the s.186 limit the CA records, a director's declaration before the
 * company takes their money), and the declarations on file (api.record_director_declaration). Admin and finance only.
 */
export function DirectorsPage() {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const [loan, setLoan] = useState<{ request?: Req } | null>(null)
  return (
    <CompanyFrame
      title={t('directors.title')}
      subtitle={t('directors.subtitle')}
      notice={!rights.partnersView ? t('directors.noView') : rights.readOnly ? t('opsCommon.readOnly') : undefined}
      actions={(cid) => (
        <>
          <Link to={`/accounts/partners-and-profit-sharing?company=${cid}`} className="sf-btn" data-variant="secondary">
            {t('directors.shareRegister')}
          </Link>
          {rights.admin && rights.partnersManage ? (
            <Button variant="primary" onClick={() => setLoan({})}>
              {t('directors.recordMoney')}
            </Button>
          ) : null}
        </>
      )}
    >
      {(companyId) => (
        <>
          <Body companyId={companyId} onRecord={(request) => setLoan({ request })} />
          {loan ? <LoanDialog companyId={companyId} request={loan.request} onClose={() => setLoan(null)} /> : null}
        </>
      )}
    </CompanyFrame>
  )
}

function Body({ companyId, onRecord }: { companyId: string; onRecord: (r: Req) => void }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const choice = useCompanyChoice()
  const company = choice.list.find((c) => c.id === companyId)
  const pq = useApiView('v_partners', { eq: { company_id: companyId }, order: 'display_name', limit: 200 })
  const lq = useApiView('v_director_loans', { eq: { company_id: companyId }, order: 'loan_date', ascending: false, limit: 300 })
  const dq = useApiView('v_director_declarations', { eq: { company_id: companyId }, order: 'declared_on', ascending: false, limit: 200 })
  const rq = useApiView('v_partner_requests', { eq: { company_id: companyId, status: 'approved' }, order: 'decided_at', limit: 100 })
  const partners = rowsOf(pq)
  const directors = partners.filter((p) => p.is_director)
  const holders = partners.filter((p) => p.is_legal_partner && p.status === 'active')
  const pendingLoans = rowsOf(rq).filter((r) => r.kind === 'loan_to_partner' || r.kind === 'loan_from_partner')
  const [declaring, setDeclaring] = useState(false)

  const loanCols: Column<Loan>[] = [
    { key: 'p', header: t('directors.loan.party'), render: (l) => <strong>{l.partner_name}</strong> },
    { key: 'd', header: t('directors.loan.direction'), render: (l) => <Chip tone={l.direction === 'given' ? 'signal' : 'teal'}>{t(`directors.loan.dir.${l.direction}`)}</Chip> },
    { key: 'm', header: t('directors.loan.movement'), render: (l) => t(`directors.loan.mov.${l.movement}`) },
    { key: 'a', header: t('directors.loan.amount'), align: 'right', render: (l) => <Amount value={l.amount} /> },
    { key: 'o', header: t('directors.loan.outstanding'), align: 'right', render: (l) => <Amount value={l.outstanding_after} /> },
    { key: 'on', header: t('directors.loan.on'), render: (l) => formatDate(l.loan_date) },
    { key: 'v', header: t('directors.loan.voucher'), render: (l) => (l.voucher_no ? <span className="mono">{l.voucher_no}</span> : '—') },
    {
      key: 'b',
      header: t('directors.loan.basis'),
      render: (l) => {
        const b = (l.legal_basis ?? {}) as { section?: string; declaration_id?: string }
        return b.section ? t('directors.loan.section', { s: b.section }) : b.declaration_id ? t('directors.loan.declared') : '—'
      },
    },
  ]
  const decCols: Column<Declaration>[] = [
    { key: 'p', header: t('directors.dec.director'), render: (d) => d.partner_name },
    { key: 'k', header: t('directors.dec.kind'), render: (d) => t(`directors.dec.kinds.${d.kind}`, { defaultValue: d.kind }) },
    { key: 'on', header: t('directors.dec.on'), render: (d) => formatDate(d.declared_on) },
    { key: 'to', header: t('directors.dec.to'), render: (d) => (d.valid_to ? formatDate(d.valid_to) : t('directors.dec.noEnd')) },
    { key: 'c', header: t('common.status'), render: (d) => (d.current ? <Chip tone="success">{t('directors.dec.current')}</Chip> : <Chip tone="neutral">{t('directors.dec.lapsed')}</Chip>) },
  ]

  return (
    <TwoCol
      main={
        <>
          <Card title={company ? company.name : t('directors.company')}>
            <KeyValue
              rows={[
                { label: t('directors.cin'), value: company?.cin ?? <span className="k">{t('directors.notRecorded')}</span> },
                { label: t('directors.pan'), value: company?.pan ?? <span className="k">{t('directors.notRecorded')}</span> },
                {
                  label: t('directors.directors'),
                  value: directors.length ? directors.map((d) => `${d.display_name}${d.din ? ` (DIN ${d.din})` : ''}`).join(' · ') : <span className="k">{t('directors.noDirectors')}</span>,
                },
                {
                  label: t('directors.shareholders'),
                  value: (
                    <span>
                      {t('directors.holders', { n: holders.length, pct: holders.reduce((a, p) => a + Number(p.share_pct), 0).toLocaleString('en-IN', { maximumFractionDigits: 4 }) })} · <Link to={`/accounts/partners-and-profit-sharing?company=${companyId}`}>{t('directors.partnersLink')}</Link>
                    </span>
                  ),
                },
              ]}
            />
          </Card>
          {pq.error ? <ViewError error={pq.error} /> : null}
          {pendingLoans.length ? (
            <Card title={t('directors.pending.title')}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pendingLoans.map((r) => (
                  <li key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <span>
                      <span className="mono">{r.doc_no}</span> · {r.partner_name} · {t(`directors.pending.kind.${r.kind}`)} · <Amount value={r.decided_amount ?? r.amount} rupee />
                    </span>
                    {rights.admin && rights.partnersManage ? (
                      <Button size="sm" onClick={() => onRecord(r)} aria-label={t('directors.pending.recordOne', { no: r.doc_no })}>
                        {t('directors.pending.record')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <TableCard title={t('directors.loan.title')}>
            <DataTable caption={t('directors.loan.title')} columns={loanCols} rows={rowsOf(lq)} rowKey={(l) => l.id} loading={lq.isLoading} minWidth={900} error={lq.error ? <ViewError error={lq.error} /> : undefined} empty={<span className="k">{t('directors.loan.none')}</span>} />
            <p className="k" style={{ margin: 0, padding: '10px 16px 14px' }}>
              {t('directors.loan.note')}
            </p>
          </TableCard>
          <TableCard
            title={t('directors.dec.title')}
            action={
              rights.partnersManage ? (
                <Button size="sm" onClick={() => setDeclaring(true)}>
                  {t('directors.dec.add')}
                </Button>
              ) : null
            }
          >
            <DataTable caption={t('directors.dec.title')} columns={decCols} rows={rowsOf(dq)} rowKey={(d) => d.id} loading={dq.isLoading} minWidth={600} error={dq.error ? <ViewError error={dq.error} /> : undefined} empty={<span className="k">{t('directors.dec.none')}</span>} />
          </TableCard>
          {declaring ? <DeclarationDialog companyId={companyId} onClose={() => setDeclaring(false)} /> : null}
        </>
      }
      side={<NoteCard title={t('directors.remind.title')} items={[{ body: t('directors.remind.one') }, { body: t('directors.remind.two') }, { body: t('directors.remind.three') }, { body: t('directors.remind.ca') }]} />}
    />
  )
}

function LoanDialog({ companyId, request, onClose }: { companyId: string; request?: Req; onClose: () => void }) {
  const { t } = useTranslation()
  const partners = useApiView('v_partners', { eq: { company_id: companyId, status: 'active' }, order: 'display_name' })
  const banks = useApiView('money_accounts', { eq: { company_id: companyId, kind: 'bank' }, order: 'name' })
  const [f, setF] = useState({
    partner: request?.partner_id ?? '',
    direction: request?.kind === 'loan_from_partner' ? 'taken' : 'given',
    movement: 'advance',
    amount: request ? String(request.decided_amount ?? request.amount ?? '') : '',
    loan_date: todayIst(),
    bank: '',
  })
  const save = useApiMutation<{ p: Record<string, unknown> }>('record_director_loan', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('directors.loanDlg.title')}
      description={t('directors.loanDlg.hint')}
      submitLabel={t('directors.loanDlg.submit')}
      busy={save.isPending}
      wide
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() => save.mutate({ p: { partner_id: f.partner || null, direction: f.direction, movement: f.movement, amount: f.amount.trim() || null, loan_date: f.loan_date, bank_account_id: f.bank || null, request_id: request?.id ?? null } }, { onSuccess: onClose })}
    >
      <FieldGrid cols={2}>
        <SelectField label={t('directors.loanDlg.partner')} value={f.partner} onChange={set('partner')} placeholder={t('directors.choose')} options={rowsOf(partners).map((p) => ({ value: p.id, label: p.display_name }))} disabled={Boolean(request)} />
        <SelectField label={t('directors.loan.direction')} value={f.direction} onChange={set('direction')} options={['given', 'taken'].map((d) => ({ value: d, label: t(`directors.loan.dir.${d}`) }))} disabled={Boolean(request)} />
        <SelectField label={t('directors.loan.movement')} value={f.movement} onChange={set('movement')} options={['advance', 'repayment'].map((m) => ({ value: m, label: t(`directors.loan.mov.${m}`) }))} />
        <Field label={t('directors.loan.amount')} inputMode="decimal" value={f.amount} onChange={set('amount')} />
        <Field label={t('directors.loan.on')} type="date" value={f.loan_date} onChange={set('loan_date')} />
        <SelectField label={t('directors.loanDlg.bank')} value={f.bank} onChange={set('bank')} placeholder={t('directors.choose')} options={rowsOf(banks).map((b) => ({ value: b.id, label: b.account_masked ? `${b.name} · ${b.account_masked}` : b.name }))} />
      </FieldGrid>
    </FormDialog>
  )
}

function DeclarationDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const partners = useApiView('v_partners', { eq: { company_id: companyId }, order: 'display_name' })
  const [f, setF] = useState({ partner: '', kind: 'not_borrowed', declared_on: todayIst(), valid_to: '', note: '' })
  const save = useApiMutation<{ p: Record<string, unknown> }>('record_director_declaration', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('directors.dec.addTitle')} description={t('directors.dec.hint')} submitLabel={t('common.save')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p: { partner_id: f.partner || null, kind: f.kind, declared_on: f.declared_on, valid_to: f.valid_to || null, note: f.note.trim() || null } }, { onSuccess: onClose })}>
      <FieldGrid cols={2}>
        <SelectField label={t('directors.dec.director')} value={f.partner} onChange={set('partner')} placeholder={t('directors.choose')} options={rowsOf(partners).filter((p) => p.is_director).map((p) => ({ value: p.id, label: p.display_name }))} />
        <SelectField label={t('directors.dec.kind')} value={f.kind} onChange={set('kind')} options={['not_borrowed', 'interest_disclosure', 'other'].map((k) => ({ value: k, label: t(`directors.dec.kinds.${k}`) }))} />
        <Field label={t('directors.dec.on')} type="date" value={f.declared_on} onChange={set('declared_on')} />
        <Field label={t('directors.dec.toLabel')} type="date" value={f.valid_to} onChange={set('valid_to')} />
      </FieldGrid>
      <TextAreaField label={t('directors.note')} value={f.note} onChange={set('note')} rows={2} />
    </FormDialog>
  )
}
