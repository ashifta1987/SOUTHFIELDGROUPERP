import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, DataTable, EmptyState, Field, FieldGrid, KeyValue, SelectField, Tabs, type Column } from '@/ui'
import { Done, LinesEditor, NoRight, SALES_REFRESH, SalesErrorBox, SalesFrame, SalesStatus, ViewError, Warn, linesPayload, newLine, num, useCompanyProducts, useCustomers, useSalesRights, type DraftLine } from '../sales-common/sales'

type Shop = ViewRow<'shops'>
type Tab = 'counter' | 'close' | 'setup'
/** Indian notes and coins counted at the day close (denominations; the server adds them up). */
const DENOMS = ['500', '200', '100', '50', '20', '10', '5', '2', '1'] as const

/**
 * Own shops (`Outlets`): the company's retail and wholesale shops. A counter sale (api.shop_sale) is a Phase 3 tax
 * invoice from the shop branch's GSTIN, stock out of the shop place (never a batch on QC hold) and a receipt into the
 * shop's cash or bank account (cash limit applies). The day close (api.shop_day_close) counts the cash against what the
 * shop took that day; a difference goes to the Bug fixer. Shop set-up is api.upsert_shop (Admin settings).
 */
export function OwnShopsPage() {
  const { t } = useTranslation()
  return (
    <SalesFrame title={t('ownShops.title')} subtitle={t('ownShops.subtitle')}>
      {(companyId) => <Shops companyId={companyId} />}
    </SalesFrame>
  )
}

function Shops({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const shops = useApiView('shops', { eq: { company_id: companyId }, order: 'branch_name' })
  const [tab, setTab] = useState<Tab>('counter')
  const [shopId, setShopId] = useState('')
  const list = rowsOf(shops)
  const shop = list.find((s) => s.id === shopId) ?? list.find((s) => s.active) ?? list[0]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewError error={shops.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        {shops.isLoading ? (
          <Card>
            <EmptyState title={t('common.loading')} />
          </Card>
        ) : list.length === 0 ? (
          <Card>
            <EmptyState title={t('ownShops.noShops')} body={rights.settings ? t('ownShops.noShopsAdmin') : t('ownShops.noShopsBody')} />
          </Card>
        ) : (
          list.map((s) => (
            <Card key={s.id} title={s.branch_name}>
              <p style={{ margin: '0 0 8px' }}>
                <SalesStatus status={s.active ? 'active' : 'inactive'} />
              </p>
              <KeyValue
                rows={[
                  { label: t('ownShops.gstin'), value: s.gstin ?? '—' },
                  { label: t('ownShops.place'), value: s.place_name ?? '—' },
                ]}
              />
            </Card>
          ))
        )}
      </div>
      <Tabs<Tab>
        label={t('ownShops.tabs')}
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'counter', label: t('ownShops.tab.counter') },
          { key: 'close', label: t('ownShops.tab.close') },
          { key: 'setup', label: t('ownShops.tab.setup') },
        ]}
      />
      {tab !== 'setup' && list.length > 1 ? (
        <div style={{ maxWidth: 420 }}>
          <SelectField label={t('ownShops.shop')} value={shop?.id ?? ''} onChange={(e) => setShopId(e.target.value)} options={list.map((s) => ({ value: s.id, label: s.branch_name }))} />
        </div>
      ) : null}
      {tab === 'counter' ? shop ? <CounterSale key={shop.id} shop={shop} /> : <Card><EmptyState title={t('ownShops.noShops')} /></Card> : null}
      {tab === 'close' ? shop ? <DayClose key={shop.id} shop={shop} /> : <Card><EmptyState title={t('ownShops.noShops')} /></Card> : null}
      {tab === 'setup' ? <ShopSetup companyId={companyId} /> : null}
      <Card title={t('ownShops.gstTitle')}>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {['same', 'other', 'sales', 'cash'].map((k) => (
            <li key={k}>
              <strong>{t(`ownShops.gst.${k}.title`)}</strong> {t(`ownShops.gst.${k}.body`)}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function CounterSale({ shop }: { shop: Shop }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const products = useCompanyProducts(shop.company_id)
  const customers = useCustomers(shop.company_id)
  const sale = useApiMutation<{ p: Record<string, unknown> }, { doc_no: string; total: number; receipt_no: string }>('shop_sale', SALES_REFRESH)
  const [party, setParty] = useState('')
  const [mode, setMode] = useState('cash')
  const [date, setDate] = useState(todayIst())
  const [lines, setLines] = useState<DraftLine[]>([newLine()])
  const [done, setDone] = useState<string | null>(null)
  const bills = useApiView('sales_documents', { eq: { company_id: shop.company_id, doc_date: date }, order: 'created_at', ascending: false, limit: 200 })
  const shopBills = rowsOf(bills).filter((b) => b.notes === 'Counter sale')
  if (!rights.shopOperate) {
    return (
      <Card title={t('ownShops.counterTitle')}>
        <NoRight>{t('ownShops.noOperate')}</NoRight>
      </Card>
    )
  }
  const billCols: Column<ViewRow<'sales_documents'>>[] = [
    { key: 'no', header: t('ownShops.bill'), render: (b) => <span className="mono">{b.doc_no ?? '—'}</span> },
    { key: 'party', header: t('ownShops.customer'), render: (b) => b.party_name ?? '—' },
    { key: 'total', header: t('ownShops.total'), align: 'right', render: (b) => <Amount value={b.total} rupee /> },
    { key: 'status', header: t('common.status'), render: (b) => <SalesStatus status={b.status} /> },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(300px, 2fr)', gap: 16, alignItems: 'start' }}>
      <Card title={t('ownShops.counterTitle')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <FieldGrid cols={3}>
            <SelectField label={t('ownShops.customer')} value={party} onChange={(e) => setParty(e.target.value)} placeholder={t('ownShops.walkIn')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
            <SelectField label={t('ownShops.mode')} value={mode} onChange={(e) => setMode(e.target.value)} options={['cash', 'upi', 'card'].map((k) => ({ value: k, label: t(`ownShops.modes.${k}`) }))} />
            <Field label={t('ownShops.date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </FieldGrid>
          <LinesEditor idBase="shop" lines={lines} onChange={setLines} products={products.list} rateHelp={t('ownShops.rateHelp')} />
          <div>
            <Button
              variant="primary"
              busy={sale.isPending}
              disabled={linesPayload(lines).length === 0}
              onClick={() =>
                sale.mutate(
                  { p: { shop_id: shop.id, party_id: party || null, doc_date: date, lines: linesPayload(lines), payment: { mode } } },
                  { onSuccess: (r) => { setLines([newLine()]); setDone(t('ownShops.sold', { no: r.doc_no, receipt: r.receipt_no })) } },
                )
              }
            >
              {t('ownShops.bill')}
            </Button>
          </div>
          <Done testId="shop-sale-msg">{done}</Done>
          <SalesErrorBox error={sale.error} />
          <p className="k" style={{ margin: 0 }}>
            {t('ownShops.counterRule')}
          </p>
        </div>
      </Card>
      <TableCard title={t('ownShops.billsToday')}>
        <DataTable caption={t('ownShops.billsToday')} columns={billCols} rows={shopBills} rowKey={(b) => b.id} loading={bills.isLoading} minWidth={420} empty={<EmptyState title={t('ownShops.noBills')} />} />
      </TableCard>
    </div>
  )
}

function DayClose({ shop }: { shop: Shop }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const days = useApiView('shop_days', { eq: { shop_id: shop.id }, order: 'day', ascending: false, limit: 60 })
  const close = useApiMutation<{ p: Record<string, unknown> }, { status: string; expected_cash: number; counted_cash: number; difference: number }>('shop_day_close', SALES_REFRESH)
  const [day, setDay] = useState(todayIst())
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [upi, setUpi] = useState('')
  const [card, setCard] = useState('')
  const [result, setResult] = useState<{ status: string; expected_cash: number; counted_cash: number; difference: number } | null>(null)
  const cols: Column<ViewRow<'shop_days'>>[] = [
    { key: 'day', header: t('ownShops.day'), render: (d) => formatDate(d.day) },
    { key: 'bills', header: t('ownShops.bills'), align: 'right', render: (d) => d.bills },
    { key: 'exp', header: t('ownShops.expected'), align: 'right', render: (d) => <Amount value={d.expected_cash} /> },
    { key: 'cnt', header: t('ownShops.counted'), align: 'right', render: (d) => <Amount value={d.counted_cash} /> },
    { key: 'upi', header: t('ownShops.upi'), align: 'right', render: (d) => <Amount value={d.upi_total} /> },
    { key: 'card', header: t('ownShops.card'), align: 'right', render: (d) => <Amount value={d.card_total} /> },
    { key: 'diff', header: t('ownShops.difference'), align: 'right', render: (d) => <Amount value={d.difference} /> },
    { key: 'status', header: t('common.status'), render: (d) => <SalesStatus status={d.status} /> },
    { key: 'by', header: t('ownShops.closedBy'), render: (d) => d.closed_by_name ?? '—' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 2fr) minmax(0, 3fr)', gap: 16, alignItems: 'start' }}>
      <Card title={t('ownShops.closeTitle')}>
        {rights.shopOperate ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Field label={t('ownShops.day')} type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="sf-field__label">{t('ownShops.notes')}</legend>
              <FieldGrid cols={3}>
                {DENOMS.map((d) => (
                  <Field key={d} label={t('ownShops.denom', { d })} inputMode="numeric" value={counts[d] ?? ''} onChange={(e) => setCounts({ ...counts, [d]: e.target.value })} />
                ))}
              </FieldGrid>
            </fieldset>
            <FieldGrid cols={2}>
              <Field label={t('ownShops.upiTotal')} inputMode="decimal" value={upi} onChange={(e) => setUpi(e.target.value)} />
              <Field label={t('ownShops.cardTotal')} inputMode="decimal" value={card} onChange={(e) => setCard(e.target.value)} />
            </FieldGrid>
            <div>
              <Button
                variant="primary"
                busy={close.isPending}
                onClick={() => {
                  const denominations: Record<string, string> = {}
                  for (const d of DENOMS) if (num(counts[d] ?? '')) denominations[d] = num(counts[d] ?? '')
                  close.mutate({ p: { shop_id: shop.id, day, denominations, upi_total: num(upi) || '0', card_total: num(card) || '0' } }, { onSuccess: (r) => setResult(r) })
                }}
              >
                {t('ownShops.closeDay')}
              </Button>
            </div>
            {result ? (
              result.status === 'closed' ? (
                <Done testId="day-close-msg">{t('ownShops.closedOk')}</Done>
              ) : (
                <Warn testId="day-close-msg">{t('ownShops.closedMismatch')}</Warn>
              )
            ) : null}
            {result ? (
              <KeyValue
                rows={[
                  { label: t('ownShops.expected'), value: <Amount value={result.expected_cash} rupee /> },
                  { label: t('ownShops.counted'), value: <Amount value={result.counted_cash} rupee /> },
                  { label: t('ownShops.difference'), value: <Amount value={result.difference} rupee />, total: true },
                ]}
              />
            ) : null}
            <SalesErrorBox error={close.error} />
            <p className="k" style={{ margin: 0 }}>
              {t('ownShops.closeRule')}
            </p>
          </div>
        ) : (
          <NoRight>{t('ownShops.noOperate')}</NoRight>
        )}
      </Card>
      <TableCard title={t('ownShops.daysTitle')}>
        <DataTable caption={t('ownShops.daysTitle')} columns={cols} rows={rowsOf(days)} rowKey={(d) => d.id} loading={days.isLoading} minWidth={820} empty={<EmptyState title={t('ownShops.noDays')} />} />
      </TableCard>
    </div>
  )
}

function ShopSetup({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const branches = useApiView('branches', { eq: { company_id: companyId, kind: 'shop' }, order: 'code' })
  const places = useApiView('places', { eq: { company_id: companyId }, order: 'code', limit: 500 })
  const money = useApiView('money_accounts', { eq: { company_id: companyId }, order: 'name' })
  const lists = useApiView('price_lists', { eq: { company_id: companyId }, order: 'name' })
  const customers = useCustomers(companyId)
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_shop', SALES_REFRESH)
  const [f, setF] = useState({ branch: '', place: '', walkIn: '', cash: '', bank: '', priceList: '' })
  const [done, setDone] = useState<string | null>(null)
  if (!rights.settings) {
    return (
      <Card title={t('ownShops.setupTitle')}>
        <NoRight>{t('ownShops.noSettings')}</NoRight>
      </Card>
    )
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <Card title={t('ownShops.setupTitle')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rowsOf(branches).length === 0 && !branches.isLoading ? <p className="k" style={{ margin: 0 }}>{t('ownShops.noShopBranch')}</p> : null}
        <FieldGrid cols={3}>
          <SelectField label={t('ownShops.branch')} value={f.branch} onChange={set('branch')} placeholder={t('salesCommon.choose')} options={rowsOf(branches).map((b) => ({ value: b.id, label: `${b.code} · ${b.name}` }))} />
          <SelectField label={t('ownShops.place')} value={f.place} onChange={set('place')} placeholder={t('salesCommon.choose')} options={rowsOf(places).filter((p) => p.branch_id === f.branch).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
          <SelectField label={t('ownShops.walkInCustomer')} value={f.walkIn} onChange={set('walkIn')} placeholder={t('salesCommon.choose')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField label={t('ownShops.cashAccount')} value={f.cash} onChange={set('cash')} placeholder={t('salesCommon.choose')} options={rowsOf(money).filter((m) => m.kind === 'cash').map((m) => ({ value: m.id, label: m.name }))} />
          <SelectField label={t('ownShops.bankAccount')} value={f.bank} onChange={set('bank')} placeholder={t('salesCommon.choose')} options={rowsOf(money).filter((m) => m.kind === 'bank').map((m) => ({ value: m.id, label: `${m.name}${m.account_masked ? ` · ${m.account_masked}` : ''}` }))} />
          <SelectField label={t('ownShops.priceList')} value={f.priceList} onChange={set('priceList')} placeholder={t('ownShops.noPriceList')} options={rowsOf(lists).map((l) => ({ value: l.id, label: l.name }))} />
        </FieldGrid>
        <div>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate({ p: { company_id: companyId, branch_id: f.branch, place_id: f.place, walk_in_party_id: f.walkIn || null, cash_account_id: f.cash || null, bank_account_id: f.bank || null, price_list_id: f.priceList || null, active: true } }, { onSuccess: () => setDone(t('ownShops.setupSaved')) })}>
            {t('ownShops.saveShop')}
          </Button>
        </div>
        <Done>{done}</Done>
        <SalesErrorBox error={save.error} />
      </div>
    </Card>
  )
}
