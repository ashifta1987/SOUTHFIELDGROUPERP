import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Button, Card, DataTable, EmptyState, Field, FieldGrid, SelectField, type Column } from '@/ui'
import { InventoryErrorBox, Qty, STOCK_REFRESH, StockStatus, useInventoryRights } from '../common/inventory'

type Lot = ViewRow<'lots'>
type Test = ViewRow<'lab_tests'>

/**
 * QC quarantine: lots waiting in QC hold (api.lots status quarantine). The incoming test is recorded by someone other
 * than the person who received the goods (api.record_incoming_test, rule sod.tester_receiver); a passing lot is then
 * released into stock (api.release_from_quarantine) and a failed one rejected (api.reject_from_quarantine), again never
 * by the receiver. The screen never hides these buttons to enforce the rule: the server refuses and we say why.
 */
export function Quarantine({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const q = useApiView('lots', { eq: { company_id: companyId, status: 'quarantine' }, order: 'received_at', limit: 500 })
  const lots = rowsOf(q)
  const open = params.get('lot')
  // Keep the lot open after it leaves QC hold (released or rejected), so the result stays on screen.
  const [kept, setKept] = useState<Lot | null>(null)
  const found = lots.find((l) => l.id === open) ?? null
  if (found && kept?.id !== found.id) setKept(found)
  const selected = found ?? (kept?.id === open ? kept : null)
  const tq = useApiView('lab_tests', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 50 })

  function choose(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('lot', id)
    else next.delete('lot')
    setParams(next, { replace: true })
  }

  const columns: Column<Lot>[] = [
    { key: 'lot', header: t('warehouse.qc.col.lot'), render: (l) => <span className="mono">{l.lot_no}</span> },
    { key: 'item', header: t('warehouse.qc.col.item'), render: (l) => `${l.product_code} · ${l.product_name}` },
    { key: 'from', header: t('warehouse.qc.col.from'), render: (l) => [l.grn_no, l.supplier_name].filter(Boolean).join(' · ') || t(`warehouse.qc.source.${l.source}`, { defaultValue: l.source }) },
    { key: 'qty', header: t('warehouse.qc.col.qty'), align: 'right', render: (l) => <Qty value={l.qty_quarantine} uom={l.uom} /> },
    { key: 'by', header: t('warehouse.qc.col.receivedBy'), render: (l) => `${l.received_by_name ?? '—'} · ${formatDate(l.received_at)}` },
    { key: 'test', header: t('warehouse.qc.col.lastTest'), render: (l) => (l.last_test_result ? <StockStatus status={l.last_test_result} /> : <span className="k">{t('warehouse.qc.notTested')}</span>) },
    {
      key: 'open',
      header: <span className="sr-only">{t('warehouse.qc.col.open')}</span>,
      render: (l) => (
        <Button size="sm" variant="link" aria-label={t('warehouse.qc.openAria', { lot: l.lot_no })} onClick={() => choose(l.id)}>
          {t('warehouse.qc.open')}
        </Button>
      ),
    },
  ]
  const testCols: Column<Test>[] = [
    { key: 'date', header: t('warehouse.qc.col.date'), render: (r) => <span className="mono">{formatDate(r.test_date)}</span> },
    { key: 'lot', header: t('warehouse.qc.col.lot'), render: (r) => <span className="mono">{r.lot_no}</span> },
    { key: 'item', header: t('warehouse.qc.col.item'), render: (r) => r.product_name },
    { key: 'result', header: t('warehouse.qc.col.result'), render: (r) => <StockStatus status={r.result} /> },
    { key: 'by', header: t('warehouse.qc.col.testedBy'), render: (r) => r.tested_by_name ?? '—' },
    { key: 'remarks', header: t('warehouse.qc.col.remarks'), render: (r) => <span className="k">{r.remarks ?? ''}</span> },
  ]
  return (
    <>
      {selected ? <LotPanel key={selected.id} lot={selected} onClose={() => choose(null)} /> : null}
      <TableCard title={t('warehouse.qc.title')}>
        <p className="k" style={{ margin: 0, padding: '0 16px 10px' }}>
          {t('warehouse.qc.rule')}
        </p>
        <DataTable caption={t('warehouse.qc.title')} columns={columns} rows={lots} rowKey={(l) => l.id} loading={q.isLoading} minWidth={900} empty={<EmptyState title={t('warehouse.qc.emptyTitle')} body={t('warehouse.qc.emptyBody')} />} />
      </TableCard>
      <TableCard title={t('warehouse.qc.testsTitle')}>
        <DataTable caption={t('warehouse.qc.testsTitle')} columns={testCols} rows={rowsOf(tq)} rowKey={(r) => r.id} loading={tq.isLoading} minWidth={760} empty={<EmptyState title={t('warehouse.qc.testsEmpty')} />} />
      </TableCard>
    </>
  )
}

function LotPanel({ lot, onClose }: { lot: Lot; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const [result, setResult] = useState('pass')
  const [remarks, setRemarks] = useState('')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const test = useApiMutation<{ p_lot_id: string; p_result: Record<string, unknown> }, { id: string; result: string }>('record_incoming_test', STOCK_REFRESH)
  const release = useApiMutation<{ p_lot_id: string; p_note: string | null }, { lot_id: string; released_qty: number }>('release_from_quarantine', STOCK_REFRESH)
  const reject = useApiMutation<{ p_lot_id: string; p_reason: string }, { lot_id: string; rejected_qty: number }>('reject_from_quarantine', STOCK_REFRESH)
  const err = (test.error ?? release.error ?? reject.error) as RpcError | null
  function resetAll() {
    setDone(null)
    test.reset()
    release.reset()
    reject.reset()
  }
  return (
    <Card
      title={t('warehouse.qc.lotTitle', { lot: lot.lot_no, item: lot.product_name })}
      action={
        <Button size="sm" variant="link" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {t('warehouse.qc.lotMeta', { qty: lot.qty_quarantine, uom: lot.uom, by: lot.received_by_name ?? '—', date: formatDate(lot.received_at) })}
      </p>
      {rights.qcTest || rights.qcRelease ? (
        <>
          <FieldGrid cols={2}>
            <SelectField
              label={t('warehouse.qc.result')}
              value={result}
              options={['pass', 'fail', 'hold'].map((k) => ({ value: k, label: t(`warehouse.qc.results.${k}`) }))}
              onChange={(e) => setResult(e.target.value)}
            />
            <Field label={t('warehouse.qc.remarks')} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </FieldGrid>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Button
              variant="primary"
              busy={test.isPending}
              onClick={() => {
                resetAll()
                test.mutate({ p_lot_id: lot.id, p_result: { result, remarks: remarks.trim() || null, parameters: {} } }, { onSuccess: (r) => setDone(t('warehouse.qc.tested', { result: t(`warehouse.qc.results.${r.result}`) })) })
              }}
            >
              {t('warehouse.qc.recordTest')}
            </Button>
            <Button
              busy={release.isPending}
              onClick={() => {
                resetAll()
                release.mutate({ p_lot_id: lot.id, p_note: remarks.trim() || null }, { onSuccess: (r) => setDone(t('warehouse.qc.released', { qty: r.released_qty, uom: lot.uom })) })
              }}
            >
              {t('warehouse.qc.release')}
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
            <div style={{ flex: '1 1 240px' }}>
              <Field label={t('warehouse.qc.rejectReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button
              variant="danger"
              busy={reject.isPending}
              onClick={() => {
                resetAll()
                reject.mutate({ p_lot_id: lot.id, p_reason: reason.trim() }, { onSuccess: (r) => setDone(t('warehouse.qc.rejected', { qty: r.rejected_qty, uom: lot.uom })) })
              }}
            >
              {t('warehouse.qc.reject')}
            </Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <InventoryErrorBox error={err} />
            {done ? (
              <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
                {done}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {rights.readOnly ? t('warehouse.readOnly') : t('warehouse.qc.noRight')}
        </p>
      )}
    </Card>
  )
}
