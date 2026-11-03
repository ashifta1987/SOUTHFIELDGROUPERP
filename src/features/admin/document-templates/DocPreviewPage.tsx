import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { DocumentPreview, printDocument } from '@/features/sales/invoice/DocumentPreview'
import { WhatsAppStatus } from '@/features/sales/invoice/WhatsAppStatus'
import { useDocBundle, type DocType } from '@/features/sales/invoice/docs'
import { Button, Card, EmptyState, Icon, PageHeader, SelectField, Skeleton, Tabs } from '@/ui'
import { formatDate, formatIndian } from '@/shared/format'

const KINDS: DocType[] = ['sales_invoice', 'credit_note', 'bill_of_supply', 'delivery_challan']

/**
 * Document templates (`DocPreview`, /admin/document-templates): pick a posted document and see exactly what prints
 * on A4 — the same layout the Invoices screen prints. Download PDF uses the browser's "Save as PDF" print target;
 * WhatsApp shows the queue status for the document; email arrives in Phase 6.
 */
export function DocPreviewPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const seesAll = profile?.view === 'all' || profile?.view === 'all-readonly'
  const choice = useCompanyChoice()
  const [params, setParams] = useSearchParams()
  const [kind, setKind] = useState<DocType>('sales_invoice')
  const companyId = choice.companyId
  const docs = useApiView('sales_documents', { eq: { company_id: companyId ?? '', doc_type: kind, status: 'posted' }, order: 'posted_at', ascending: false, limit: 50, enabled: Boolean(companyId) })
  const list = rowsOf(docs)
  const wanted = params.get('doc')
  const docId = list.some((d) => d.id === wanted) ? wanted : (list[0]?.id ?? null)
  const bundle = useDocBundle(docId)

  function pick(id: string) {
    const next = new URLSearchParams(params)
    next.set('doc', id)
    setParams(next, { replace: true })
  }

  const kinds = KINDS.filter((k) => seesAll || (k !== 'bill_of_supply' && k !== 'delivery_challan'))

  return (
    <>
      <PageHeader title={t('docPreview.title')} subtitle={t('docPreview.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
        <Tabs label={t('docPreview.kindsLabel')} value={kind} onChange={setKind} tabs={kinds.map((k) => ({ key: k, label: t(`invoice.types.${k}`) }))} controls="doc-preview-panel" />
        <span className="muted" style={{ fontSize: 12.5 }}>{t('docPreview.otherKinds')}</span>
      </div>

      <div id="doc-preview-panel" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, alignItems: 'start' }}>
        <div style={{ background: 'var(--sf-line-soft)', borderRadius: 'var(--sf-radius-card)', padding: 24, overflowX: 'auto', minHeight: 400 }}>
          {docs.isLoading || (docId && bundle.isLoading) ? (
            <Card>
              <Skeleton height={400} />
            </Card>
          ) : !docId ? (
            <Card>
              <EmptyState title={t('docPreview.emptyTitle')} body={t('docPreview.emptyBody')} />
            </Card>
          ) : (
            <DocumentPreview bundle={bundle} />
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title={t('docPreview.pickTitle')}>
            <SelectField
              label={t('docPreview.document')}
              value={docId ?? ''}
              placeholder={list.length ? undefined : t('docPreview.noneOfKind')}
              options={list.map((d) => ({ value: d.id, label: `${d.doc_no ?? ''} · ${formatDate(d.doc_date)} · ${d.party_name} · ₹${formatIndian(d.total)}` }))}
              onChange={(e) => pick(e.target.value)}
            />
          </Card>
          <Card title={t('docPreview.sendTitle')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Button onClick={printDocument} disabled={!bundle.doc}>
                <Icon name="download" path="M12 3v12 M7 10l5 5 5-5 M5 21h14" size={16} /> {t('docPreview.download')}
              </Button>
              <Button onClick={printDocument} disabled={!bundle.doc}>
                <Icon name="printer" path="M6 9V3h12v6 M6 18H4v-7h16v7h-2 M6 14h12v7H6z" size={16} /> {t('docPreview.print')}
              </Button>
              <Button comingInPhase={6}>
                <Icon name="mail" path="M3 5h18v14H3z M3 7l9 6 9-6" size={16} /> {t('docPreview.email')}
              </Button>
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{t('docPreview.downloadHelp')}</p>
            </div>
          </Card>
          <Card title={t('docPreview.waTitle')}>
            <WhatsAppStatus docId={bundle.doc ? docId : null} />
          </Card>
        </div>
      </div>
    </>
  )
}
