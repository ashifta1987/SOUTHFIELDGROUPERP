import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { useCompanyChoice, todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Skeleton, StatusChip, type Column } from '@/ui'
import { formatDate } from '@/shared/format'
import { useDocBundle, type SalesDoc } from './docs'
import { DocumentPreview, printDocument } from './DocumentPreview'
import { InvoiceEditor, initialFromDoc, newLine, type EditorInitial, type HeaderDraft } from './InvoiceEditor'

/**
 * Invoices (`Invoice`, /sales/invoices): document entry for tax invoices, credit notes and — Admin only, with a
 * lawful reason — bills of supply and delivery challans. `?doc=<id>` opens a saved document. Tax, numbers and
 * postings are decided by Postgres (api.preview_tax / save_sales_draft / post_sales_document / cancel_sales_document).
 */
export function InvoicePage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const isAdmin = profile?.view === 'all'
  const canCreate = can('sales_invoices.create') && !readOnly
  const canCancel = can('sales_invoices.cancel') && !readOnly
  const [params, setParams] = useSearchParams()
  const docId = params.get('doc')
  const choice = useCompanyChoice()
  const products = useApiView('products', { order: 'name', limit: 2000 })
  const bundle = useDocBundle(docId)
  const [session, setSession] = useState(0)
  const [adopted, setAdopted] = useState<string | null>(null)
  const [preset, setPreset] = useState<Partial<HeaderDraft> | null>(null)
  const [printing, setPrinting] = useState(false)

  function openDoc(id: string) {
    setAdopted(null)
    setPrinting(false)
    const next = new URLSearchParams(params)
    next.set('doc', id)
    setParams(next)
  }
  function newDoc(p?: Partial<HeaderDraft>) {
    setSession((s) => s + 1)
    setAdopted(null)
    setPreset(p ?? null)
    setPrinting(false)
    const next = new URLSearchParams(params)
    next.delete('doc')
    if (p?.companyId) next.set('company', p.companyId)
    setParams(next)
  }
  function onCreated(id: string) {
    setAdopted(id)
    const next = new URLSearchParams(params)
    next.set('doc', id)
    setParams(next, { replace: true })
  }

  const companyId = bundle.doc?.company_id ?? choice.companyId
  const foreign = Boolean(docId) && docId !== adopted
  const editorKey = foreign ? `doc-${docId}` : `new-${session}`
  const waiting = choice.isLoading || products.isLoading || (foreign && bundle.isLoading)

  let body
  if (waiting) {
    body = (
      <Card>
        <Skeleton height={28} width="40%" />
        <div style={{ height: 12 }} />
        <Skeleton height={160} />
      </Card>
    )
  } else if (choice.list.length === 0) {
    body = (
      <Card>
        <EmptyState title={t('invoice.empty.noCompanyTitle')} body={t('invoice.empty.noCompanyBody')} />
      </Card>
    )
  } else if (foreign && bundle.notFound) {
    body = (
      <Card>
        <EmptyState title={t('invoice.empty.notFoundTitle')} body={t('invoice.empty.notFoundBody')} action={<Button onClick={() => newDoc()}>{t('invoice.actions.new')}</Button>} />
      </Card>
    )
  } else if (printing && docId && bundle.doc) {
    body = (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 'var(--sf-fs-page)' }}>{t('invoice.print.heading', { no: bundle.doc.doc_no ?? t('invoice.notNumbered') })}</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setPrinting(false)}>{t('invoice.actions.backToEdit')}</Button>
            <Button variant="primary" onClick={printDocument}>
              {t('invoice.actions.print')}
            </Button>
          </div>
        </div>
        <div style={{ background: 'var(--sf-line-soft)', borderRadius: 'var(--sf-radius-card)', padding: 24, overflowX: 'auto' }}>
          <DocumentPreview bundle={bundle} />
        </div>
      </>
    )
  } else {
    const initial: EditorInitial =
      foreign && bundle.doc
        ? initialFromDoc(bundle.doc, bundle.lines, rowsOf(products))
        : {
            header: {
              companyId: preset?.companyId ?? choice.companyId ?? '',
              gstinId: preset?.gstinId ?? '',
              docType: preset?.docType ?? 'sales_invoice',
              docDate: todayIst(),
              partyId: preset?.partyId ?? '',
              pos: '',
              lawfulReason: '',
              againstId: preset?.againstId ?? '',
              reason: '',
              notes: '',
            },
            lines: [newLine()],
          }
    body = (
      <InvoiceEditor
        key={editorKey}
        docId={docId}
        doc={bundle.doc}
        docLines={bundle.lines}
        initial={initial}
        products={rowsOf(products)}
        companies={choice.list.filter((c) => c.status === 'active' || c.id === initial.header.companyId)}
        isAdmin={isAdmin}
        canCreate={canCreate}
        canCancel={canCancel}
        onCreated={onCreated}
        onNew={newDoc}
        onPreview={() => setPrinting(true)}
        onCompanyChange={choice.choose}
      />
    )
  }

  return (
    <>
      <nav aria-label={t('invoice.breadcrumb')} style={{ fontSize: 13, marginBottom: 8 }}>
        <Link
          to={`/sales/invoices${companyId ? `?company=${companyId}` : ''}`}
          onClick={(e) => {
            e.preventDefault()
            newDoc()
          }}
        >
          {t('invoice.listName')}
        </Link>
        <span className="muted"> / {bundle.doc?.doc_no ?? (docId ? t('invoice.draft') : t('invoice.newCrumb'))}</span>
      </nav>
      {body}
      {!printing ? <RecentDocuments companyId={companyId} currentId={docId} onOpen={openDoc} /> : null}
    </>
  )
}

function RecentDocuments({ companyId, currentId, onOpen }: { companyId: string | undefined; currentId: string | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const q = useApiView('sales_documents', { eq: { company_id: companyId ?? '' }, order: 'created_at', ascending: false, limit: 25, enabled: Boolean(companyId) })
  const rows = rowsOf(q)
  const columns: Column<SalesDoc>[] = [
    { key: 'date', header: t('invoice.recent.date'), render: (r) => <span className="mono">{formatDate(r.doc_date)}</span> },
    { key: 'no', header: t('invoice.recent.no'), render: (r) => <span className="mono">{r.doc_no ?? t('invoice.draft')}</span> },
    { key: 'type', header: t('invoice.recent.type'), render: (r) => t(`invoice.types.${r.doc_type}`) },
    { key: 'party', header: t('invoice.recent.customer'), render: (r) => r.party_name },
    { key: 'total', header: t('invoice.recent.total'), align: 'right', render: (r) => <Amount value={r.total} /> },
    {
      key: 'state',
      header: t('common.status'),
      render: (r) =>
        r.status === 'posted' ? <StatusChip status="posted" /> : r.status === 'cancelled' ? <Chip tone="danger" icon="ban">{t('invoice.state.cancelled')}</Chip> : <StatusChip status="draft" />,
    },
    {
      key: 'open',
      header: <span className="sr-only">{t('invoice.recent.open')}</span>,
      render: (r) =>
        r.id === currentId ? (
          <span className="muted">{t('invoice.recent.current')}</span>
        ) : (
          <Button
            size="sm"
            variant="link"
            onClick={(e) => {
              e.stopPropagation()
              onOpen(r.id)
            }}
            aria-label={t('invoice.recent.openAria', { no: r.doc_no ?? t('invoice.draft'), customer: r.party_name })}
          >
            {t('invoice.recent.open')}
          </Button>
        ),
    },
  ]
  return (
    <div style={{ marginTop: 16 }}>
      <TableCard title={t('invoice.recent.title')}>
        <DataTable
          caption={t('invoice.recent.title')}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          onRowClick={(r) => onOpen(r.id)}
          empty={<EmptyState title={t('invoice.recent.emptyTitle')} body={t('invoice.recent.emptyBody')} />}
        />
      </TableCard>
    </div>
  )
}
