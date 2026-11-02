import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Amount,
  BottomNav,
  Button,
  Card,
  ComingInPhase,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorRef,
  Field,
  KpiTiles,
  OfflineBadge,
  PageHeader,
  PhoneHeader,
  StatusChip,
  Tabs,
  TaxClassChip,
  type StatusKind,
  type TaxClass,
} from '@/ui'

/**
 * Development-only component gallery (§UX-14 item 3). Never routed in production builds.
 * Uses obviously synthetic sample values only; nothing is taken from the design reference.
 */
const STATUSES: StatusKind[] = ['draft', 'pending', 'approved', 'posted', 'released', 'onHold', 'inTransit', 'delivered', 'failed', 'blocked', 'overdue']
const TAXES: TaxClass[] = ['taxable', 'zeroRated', 'exempt', 'nilRated', 'nonGst', 'reverseCharge', 'withoutGst']

interface DemoRow {
  id: string
  name: string
  amount: string
}
const DEMO_ROWS: DemoRow[] = [
  { id: '1', name: 'Test Customer 01', amount: '1234567.50' },
  { id: '2', name: 'Test Customer 02', amount: '-2500.00' },
]

export function UiGalleryPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'a' | 'b' | 'c'>('a')
  const [seg, setSeg] = useState<'x' | 'y'>('x')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <PageHeader title="UI components" subtitle="Development only · synthetic values · every component from §UX-6 used in Phase 0" />
      <KpiTiles
        ariaLabel="KPI demo"
        items={[
          { key: 'a', label: 'Test KPI A', value: <Amount value="1234567" rupee digits={0} />, sub: 'Synthetic' },
          { key: 'b', label: 'Test KPI B', value: <Amount value="-98765.4" rupee />, sub: 'Negative shows a minus in red ink' },
          { key: 'c', label: 'Test KPI C', value: <Amount value={null} />, sub: 'No value yet' },
        ]}
      />
      <div className="sf-gallery">
        <Card title="StatusChip">
          <div className="sf-row" style={{ marginTop: 10 }}>
            {STATUSES.map((s) => (
              <StatusChip key={s} status={s} />
            ))}
          </div>
        </Card>
        <Card title="TaxClassChip">
          <div className="sf-row" style={{ marginTop: 10 }}>
            {TAXES.map((x) => (
              <TaxClassChip key={x} taxClass={x} reason={x === 'withoutGst' ? 'Export under LUT' : undefined} />
            ))}
            <TaxClassChip taxClass="withoutGst" />
          </div>
        </Card>
        <Card title="Button">
          <div className="sf-row" style={{ marginTop: 10 }}>
            <Button variant="primary">Primary</Button>
            <Button>Secondary</Button>
            <Button variant="danger">Reverse</Button>
            <Button variant="link">Text link</Button>
            <Button variant="primary" busy>
              Posting…
            </Button>
            <Button comingInPhase={3}>Not yet</Button>
            <Button size="sm">Small</Button>
          </div>
        </Card>
        <Card title="Field">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
            <Field label="Plain field" placeholder="Type here" help="Helper text, 12 px muted" />
            <Field label="With error" defaultValue="abc" error="GSTIN must be 15 characters. Check the number on the certificate." />
            <Field label="With warning" defaultValue="250000" className="mono" warning="Takes this party past the ₹2 lakh cash limit today. Blocked." />
            <Field label="With prefix" prefix="+91" inputMode="numeric" className="mono" />
          </div>
        </Card>
        <Card title="Tabs">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
            <Tabs label="Button tabs" value={tab} onChange={setTab} tabs={[{ key: 'a', label: 'Account' }, { key: 'b', label: 'Queries' }, { key: 'c', label: 'Visit' }]} />
            <Tabs label="Segmented" variant="segmented" value={seg} onChange={setSeg} tabs={[{ key: 'x', label: 'Test Company A' }, { key: 'y', label: 'Test Company B' }]} />
          </div>
        </Card>
        <Card title="ConfirmDialog">
          <div style={{ marginTop: 10 }}>
            <Button variant="primary" onClick={() => setOpen(true)}>
              Post a test document
            </Button>
          </div>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Post TEST-0001?"
            effect="Posts test document TEST-0001 for ₹1,000.00 and reduces stock of 2 items. This cannot be deleted later, only reversed."
            confirmLabel="Post"
            busy={busy}
            onConfirm={() => {
              setBusy(true)
              setTimeout(() => {
                setBusy(false)
                setOpen(false)
              }, 800)
            }}
          />
        </Card>
        <Card title="Empty, error and coming states">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
            <EmptyState title="No goods receipts yet this month" body="Record a goods receipt when the next delivery arrives." />
            <ErrorRef message="Could not load this list." next="Check your signal and try again." refId="ERR-TEST1" onAskHelp={() => undefined} />
            <ComingInPhase phase={4} />
          </div>
        </Card>
      </div>
      <Card pad={false}>
        <div className="sf-card__pad">
          <h2 className="sf-card__title">DataTable</h2>
        </div>
        <DataTable
          caption="Demo table"
          rows={DEMO_ROWS}
          rowKey={(r) => r.id}
          columns={[
            { key: 'name', header: 'Party', render: (r) => r.name },
            { key: 'amount', header: 'Amount ₹', align: 'right', render: (r) => <Amount value={r.amount} /> },
          ]}
        />
        <DataTable caption="Empty demo" rows={[]} rowKey={(r: DemoRow) => r.id} columns={[{ key: 'name', header: 'Party', render: (r: DemoRow) => r.name }]} empty={<EmptyState title="Nothing here yet" body="Why it is empty, and the next action." />} />
        <DataTable caption="Loading demo" rows={undefined} loading rowKey={(r: DemoRow) => r.id} columns={[{ key: 'name', header: 'Party', render: (r: DemoRow) => r.name }, { key: 'a', header: 'Amount', align: 'right', render: () => null }]} />
      </Card>
      <Card title="Phone patterns: PhoneHeader, OfflineBadge, BottomNav">
        <div style={{ maxWidth: 390, border: '1px solid var(--sf-line)', borderRadius: 12, overflow: 'hidden', marginTop: 10 }}>
          <PhoneHeader initial="T" name="Test Staff 01" sub="TEST-0001 · Test company" extra={<OfflineBadge forceOffline />} onHelp={() => undefined} />
          <div className="sf-phone-body">
            <Button variant="primary" size="hero">
              {t('common.save')}
            </Button>
          </div>
          <BottomNav
            label="Demo tabs"
            items={[
              { to: '/dev/ui', label: 'Home', icon: 'home', end: true },
              { to: '/dev/ui/r', label: 'Requests', icon: 'clipboard' },
              { to: '/dev/ui/p', label: 'Payslips', icon: 'receipt' },
              { to: '/dev/ui/d', label: 'My details', icon: 'user' },
            ]}
          />
        </div>
      </Card>
    </>
  )
}
