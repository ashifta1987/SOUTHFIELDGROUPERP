import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { callApi, useApiMutation, type RpcError } from '@/data/rpc'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, FormDialog, KpiTiles, SelectField, Skeleton, type Column } from '@/ui'
import { fromPaise, moneyAccountLabel, MoneyErrorBox, sumPaise, useMoneyAccounts, useReadRpc } from '@/features/accounts/cash-book/money'
import { buildLines, FIELDS, guessMapping, readStatement, StatementReadError, type Mapping, type Sheet, type StatementField } from './parseStatement'

type Line = ViewRow<'bank_lines'>
interface Candidate {
  voucher_id: string
  doc_no: string
  voucher_date: string
  voucher_type: string
  party_name: string | null
  amount: number
}

export function Reconcile({ companyId, canImport, onSetup }: { companyId: string; canImport: boolean; onSetup: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const banks = useMoneyAccounts(companyId, 'bank')
  const [pick, setPick] = useState('')
  const account = banks.list.find((a) => a.id === pick) ?? banks.list[0]
  const lines = useApiView('bank_lines', { eq: { account_id: account?.id }, order: 'txn_date', ascending: false, limit: 1000, enabled: Boolean(account) })
  const list = rowsOf(lines)
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const [readErr, setReadErr] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<RpcError | null>(null)
  const [importRes, setImportRes] = useState<{ added: number; skipped: number } | null>(null)
  const [matchLine, setMatchLine] = useState<Line | null>(null)
  const ignore = useApiMutation<{ p_line_id: string; p_voucher_id: null; p_ignore: true }>('match_bank_line', [['api', 'bank_lines']])

  async function onFile(f: File | undefined) {
    setReadErr(null)
    setImportRes(null)
    setImportErr(null)
    setSheet(null)
    setFile(f ?? null)
    if (!f) return
    try {
      const s = await readStatement(f)
      setSheet(s)
      setMapping(guessMapping(s.headers))
    } catch (e) {
      setReadErr(e instanceof StatementReadError ? t(`bankReco.read.${e.kind}`) : t('bankReco.read.unreadable'))
    }
  }

  const built = sheet ? buildLines(sheet, mapping) : null
  const mappingOk = mapping.date !== undefined && (mapping.amount !== undefined || mapping.debit !== undefined || mapping.credit !== undefined)

  async function doImport() {
    if (!account || !built || !file) return
    setImporting(true)
    setImportErr(null)
    try {
      const res = await callApi<{ added: number; skipped: number }>('import_bank_lines', { p_account_id: account.id, p_lines: built.lines, p_import_ref: file.name.slice(0, 120) }, { idempotent: false })
      setImportRes(res)
      setSheet(null)
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      await qc.invalidateQueries({ queryKey: ['api', 'bank_lines'] })
    } catch (e) {
      setImportErr(e as RpcError)
    } finally {
      setImporting(false)
    }
  }

  if (banks.isLoading) {
    return (
      <Card>
        <Skeleton height={80} />
      </Card>
    )
  }
  if (!account) {
    return (
      <Card>
        <EmptyState
          title={t('bankReco.noBankTitle')}
          body={t('bankReco.noBankBody')}
          action={
            <Button variant="primary" onClick={onSetup}>
              {t('bankReco.toSetup')}
            </Button>
          }
        />
      </Card>
    )
  }

  const matched = list.filter((l) => l.status === 'matched')
  const unmatched = list.filter((l) => l.status === 'unmatched')
  const ignored = list.filter((l) => l.status === 'ignored')

  const columns: Column<Line>[] = [
    { key: 'date', header: t('bankReco.col.date'), render: (l) => <span className="mono">{formatDate(l.txn_date)}</span> },
    {
      key: 'desc',
      header: t('bankReco.col.narration'),
      render: (l) => (
        <div>
          <div style={{ fontWeight: 600 }}>{l.description || '—'}</div>
          {l.ref ? <div className="k mono">{l.ref}</div> : null}
        </div>
      ),
    },
    { key: 'out', header: t('bankReco.col.out'), align: 'right', render: (l) => (l.amount < 0 ? <Amount value={Math.abs(l.amount)} /> : null) },
    { key: 'in', header: t('bankReco.col.in'), align: 'right', render: (l) => (l.amount > 0 ? <Amount value={l.amount} /> : null) },
    { key: 'bal', header: t('bankReco.col.balance'), align: 'right', render: (l) => (l.balance === null ? null : <Amount value={l.balance} />) },
    {
      key: 'state',
      header: t('bankReco.col.state'),
      render: (l) =>
        l.status === 'matched' ? (
          <div>
            <Chip tone="success" icon="check">
              {t('bankReco.matched')}
            </Chip>
            <div className="k mono">{l.matched_doc_no}</div>
          </div>
        ) : l.status === 'ignored' ? (
          <Chip tone="neutral">{t('bankReco.ignored')}</Chip>
        ) : (
          <Chip tone="signal" icon="alert">
            {t('bankReco.unmatched')}
          </Chip>
        ),
    },
    {
      key: 'act',
      header: <span className="sr-only">{t('bankReco.col.action')}</span>,
      render: (l) =>
        canImport && l.status === 'unmatched' ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" onClick={() => setMatchLine(l)} aria-label={t('bankReco.matchNamed', { d: formatDate(l.txn_date), what: l.description ?? '' })}>
              {t('bankReco.match')}
            </Button>
            <Button size="sm" variant="link" busy={ignore.isPending && ignore.variables?.p_line_id === l.id} onClick={() => ignore.mutate({ p_line_id: l.id, p_voucher_id: null, p_ignore: true })} aria-label={t('bankReco.ignoreNamed', { d: formatDate(l.txn_date), what: l.description ?? '' })}>
              {t('bankReco.ignore')}
            </Button>
          </div>
        ) : null,
    },
  ]

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 320 }}>
          <SelectField label={t('bankReco.account')} value={account.id} onChange={(e) => setPick(e.target.value)} options={banks.list.map((a) => ({ value: a.id, label: moneyAccountLabel(a) }))} />
        </div>
        {account.ifsc ? <span className="k">{t('bankReco.ifsc', { ifsc: account.ifsc })}</span> : null}
      </div>

      <KpiTiles
        ariaLabel={t('bankReco.kpis')}
        items={[
          { key: 'all', label: t('bankReco.kpi.lines'), value: <span className="mono">{list.length}</span>, sub: t('bankReco.kpi.linesSub') },
          { key: 'm', label: t('bankReco.kpi.matched', { n: matched.length }), value: <Amount value={fromPaise(sumPaise(matched, (l) => Math.abs(l.amount)))} rupee />, sub: t('bankReco.kpi.matchedSub') },
          { key: 'u', label: t('bankReco.kpi.unmatched', { n: unmatched.length }), value: <Amount value={fromPaise(sumPaise(unmatched, (l) => Math.abs(l.amount)))} rupee />, sub: t('bankReco.kpi.unmatchedSub') },
          { key: 'i', label: t('bankReco.kpi.ignored', { n: ignored.length }), value: <Amount value={fromPaise(sumPaise(ignored, (l) => Math.abs(l.amount)))} rupee /> },
        ]}
      />

      {canImport ? (
        <Card title={t('bankReco.upload.title')}>
          <p className="k" style={{ marginTop: 0 }}>
            {t('bankReco.upload.body')}
          </p>
          <div className="sf-field">
            <label className="sf-field__label" htmlFor="bank-file">
              {t('bankReco.upload.file')}
            </label>
            <input id="bank-file" ref={fileRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
          {readErr ? (
            <div className="sf-alert" data-tone="danger" role="alert" style={{ marginTop: 12 }}>
              {readErr}
            </div>
          ) : null}
          {sheet && built ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              <p style={{ margin: 0, fontSize: 13 }}>{t('bankReco.upload.mapHelp')}</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                {FIELDS.map((f: StatementField) => (
                  <SelectField
                    key={f}
                    label={t(`bankReco.field.${f}`)}
                    value={mapping[f] === undefined ? '' : String(mapping[f])}
                    placeholder={t('bankReco.upload.notInFile')}
                    onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value === '' ? undefined : Number(e.target.value) }))}
                    options={sheet.headers.map((h, i) => ({ value: String(i), label: h || t('bankReco.upload.column', { n: i + 1 }) }))}
                  />
                ))}
              </div>
              <p className="k" role="status" style={{ margin: 0 }}>
                {mappingOk ? t('bankReco.upload.ready', { n: built.lines.length, skipped: built.skipped }) : t('bankReco.upload.needDate')}
              </p>
              {mappingOk && built.lines.length ? (
                <div className="sf-table-wrap" role="region" aria-label={t('bankReco.upload.preview')} tabIndex={0}>
                  <table className="sf-table">
                    <caption className="sr-only">{t('bankReco.upload.preview')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('bankReco.col.date')}</th>
                        <th scope="col">{t('bankReco.col.narration')}</th>
                        <th scope="col" className="r">
                          {t('bankReco.col.amount')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {built.lines.slice(0, 5).map((l, i) => (
                        <tr key={i}>
                          <td className="mono">{formatDate(l.date)}</td>
                          <td>{l.description}</td>
                          <td className="r">
                            <Amount value={l.amount} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <div>
                <Button variant="primary" busy={importing} disabled={!mappingOk || built.lines.length === 0} onClick={() => void doImport()}>
                  {t('bankReco.upload.import', { n: built.lines.length })}
                </Button>
              </div>
            </div>
          ) : null}
          {importErr ? (
            <div style={{ marginTop: 12 }}>
              <MoneyErrorBox error={importErr} />
            </div>
          ) : null}
          {importRes ? (
            <p role="status" style={{ marginBottom: 0 }}>
              <Chip tone="success" icon="check">
                {t('bankReco.upload.done', { added: importRes.added, skipped: importRes.skipped })}
              </Chip>
            </p>
          ) : null}
        </Card>
      ) : null}

      <TableCard title={t('bankReco.linesTitle', { n: list.length })}>
        {ignore.error ? (
          <div className="sf-card__pad">
            <MoneyErrorBox error={ignore.error} />
          </div>
        ) : null}
        <DataTable
          caption={t('bankReco.linesCaption')}
          columns={columns}
          rows={list}
          rowKey={(l) => l.id}
          loading={lines.isLoading}
          rowTone={(l) => (l.status === 'unmatched' ? 'signal' : undefined)}
          empty={<EmptyState title={t('bankReco.emptyTitle')} body={canImport ? t('bankReco.emptyBody') : t('bankReco.emptyBodyNoRight')} />}
        />
      </TableCard>

      {matchLine ? <MatchDialog line={matchLine} onClose={() => setMatchLine(null)} /> : null}
    </>
  )
}

function MatchDialog({ line, onClose }: { line: Line; onClose: () => void }) {
  const { t } = useTranslation()
  const cands = useReadRpc<Candidate[]>('bank_match_candidates', { p_line_id: line.id })
  const m = useApiMutation<{ p_line_id: string; p_voucher_id: string; p_ignore: false }>('match_bank_line', [['api', 'bank_lines']])
  const [pick, setPick] = useState('')
  const list = cands.data ?? []
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={t('bankReco.matchTitle')}
      description={t('bankReco.matchBody', { d: formatDate(line.txn_date), amount: fromPaise(Math.abs(Math.round(line.amount * 100))), what: line.description ?? '' })}
      submitLabel={t('bankReco.match')}
      busy={m.isPending}
      error={<MoneyErrorBox error={(m.error as RpcError | null) ?? cands.error} />}
      onSubmit={() => pick && m.mutate({ p_line_id: line.id, p_voucher_id: pick, p_ignore: false }, { onSuccess: onClose })}
    >
      {cands.isLoading ? (
        <Skeleton height={60} />
      ) : list.length === 0 ? (
        <EmptyState title={t('bankReco.noCandTitle')} body={t('bankReco.noCandBody')} />
      ) : (
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <legend className="sf-field__label">{t('bankReco.candidates')}</legend>
          {list.map((c) => (
            <label key={c.voucher_id} className="sf-phone-line" style={{ cursor: 'pointer' }}>
              <input type="radio" name="cand" value={c.voucher_id} checked={pick === c.voucher_id} onChange={() => setPick(c.voucher_id)} />
              <span style={{ flex: 1 }}>
                <strong className="mono">{c.doc_no}</strong> · {formatDate(c.voucher_date)} · {t(`cashBook.types.${c.voucher_type}`, { defaultValue: c.voucher_type })}
                {c.party_name ? ` · ${c.party_name}` : ''}
              </span>
              <Amount value={c.amount} rupee />
            </label>
          ))}
        </fieldset>
      )}
    </FormDialog>
  )
}
