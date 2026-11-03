import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Amount } from '@/ui'
import { formatDate, formatIndian } from '@/shared/format'
import { hsnSummary, stateLabel, type DocBundle } from './docs'
import { IrnPrintBlock, type FinalStatus } from '@/features/sales/einvoice/EinvoicePanel'

/**
 * The A4 layout of a sales document (tax invoice, bill of supply, delivery challan, credit note), exactly what
 * prints. Every figure is the posted (or saved draft) value from api.sales_documents / api.sales_document_lines.
 * Rule 46 / 49 / 55 contents: supplier name, address and GSTIN; number and date; recipient name, address and
 * GSTIN; place of supply with state; HSN, description, quantity, unit, value, discount, taxable value, rate and
 * tax split; total in figures and words; reverse-charge statement; signature line. Drafts carry a DRAFT mark.
 */
export const PRINT_AREA_CLASS = 'sf-docprint'

/** Print CSS scoped to the preview: everything else on the page is hidden while printing. */
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 0; }
  body * { visibility: hidden !important; }
  .${PRINT_AREA_CLASS}, .${PRINT_AREA_CLASS} * { visibility: visible !important; }
  .${PRINT_AREA_CLASS} { position: absolute !important; left: 0; top: 0; box-shadow: none !important; margin: 0 !important; }
}
`

export function printDocument() {
  window.print()
}

const cell: CSSProperties = { padding: '4px 6px', borderBottom: '1px solid var(--sf-line-faint)', textAlign: 'left', verticalAlign: 'top' }
const head: CSSProperties = { ...cell, background: 'var(--sf-paper)', fontWeight: 600, borderBottom: '1px solid var(--sf-line)' }
const num: CSSProperties = { ...cell, textAlign: 'right', fontFamily: 'var(--sf-font-mono)' }
const numHead: CSSProperties = { ...head, textAlign: 'right' }

function Row({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0', fontWeight: strong ? 700 : undefined, borderTop: strong ? '1px solid var(--sf-ink)' : undefined }}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  )
}

export function DocumentPreview({ bundle, irn }: { bundle: DocBundle; irn?: FinalStatus['irn'] }) {
  const { t } = useTranslation()
  const { doc, lines, company, gstin, address, against } = bundle
  if (!doc) return null
  const summary = hsnSummary(lines)
  const intra = Number(doc.igst) === 0
  const mark = doc.status === 'draft' ? t('invoice.print.draftMark') : doc.status === 'cancelled' ? t('invoice.print.cancelledMark') : null
  return (
    <>
      <style>{PRINT_CSS}</style>
      <article
        className={PRINT_AREA_CLASS}
        aria-label={t('invoice.print.sheetLabel')}
        style={{
          position: 'relative',
          width: '210mm',
          maxWidth: '100%',
          minHeight: '297mm',
          boxSizing: 'border-box',
          padding: '14mm 12mm',
          margin: '0 auto',
          background: 'var(--sf-surface)',
          color: 'var(--sf-text)',
          fontSize: 11.5,
          lineHeight: 1.4,
          boxShadow: '0 1px 4px color-mix(in srgb, var(--sf-ink) 18%, transparent)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {mark ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '38%',
              left: '50%',
              transform: 'translate(-50%, -50%) rotate(-28deg)',
              fontSize: 96,
              fontWeight: 700,
              letterSpacing: 8,
              color: 'color-mix(in srgb, var(--sf-danger) 14%, transparent)',
              pointerEvents: 'none',
            }}
          >
            {mark}
          </span>
        ) : null}

        <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, borderBottom: '2px solid var(--sf-ink)', paddingBottom: 10 }}>
          <div>
            <strong style={{ fontSize: 14 }}>{company?.name ?? doc.company_name}</strong>
            {company?.registered_address ? <div>{company.registered_address}</div> : null}
            <div>
              {t('invoice.print.gstin')} <span className="mono">{doc.gstin}</span> · {t('invoice.print.state')} {stateLabel(gstin?.state_code ?? doc.our_state)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <strong style={{ fontSize: 16, letterSpacing: 0.5 }}>{t(`invoice.print.title.${doc.doc_type}`)}</strong>
            {doc.doc_type === 'sales_invoice' ? <div style={{ fontSize: 10 }}>{t('invoice.print.original')}</div> : null}
            <div>
              {t('invoice.print.no')} <span className="mono">{doc.doc_no ?? t('invoice.print.notNumbered')}</span>
            </div>
            <div>
              {t('invoice.print.date')} <span className="mono">{formatDate(doc.doc_date)}</span>
            </div>
            <div>{t('invoice.print.reverseChargeNo')}</div>
          </div>
        </header>

        <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 12 }}>
          <div>
            <strong>{t('invoice.print.billTo')}</strong>
            <div>{doc.party_name}</div>
            {address ? <div>{[address.line1, address.line2, address.city, address.pincode].filter(Boolean).join(', ')}</div> : null}
            <div>
              {t('invoice.print.gstin')} <span className="mono">{doc.party_gstin ?? t('invoice.print.unregistered')}</span>
            </div>
          </div>
          <div>
            <strong>{t('invoice.print.placeOfSupply')}</strong>
            <div>{stateLabel(doc.place_of_supply)}</div>
            {doc.doc_type === 'credit_note' ? (
              <div style={{ marginTop: 6 }}>
                <strong>{t('invoice.print.againstInvoice')}</strong> <span className="mono">{against?.doc_no ?? '—'}</span>
                {doc.reason ? <div>{t('invoice.print.reason', { reason: doc.reason })}</div> : null}
              </div>
            ) : null}
            {doc.tax_class === 'without_gst' && doc.lawful_reason ? (
              <div style={{ marginTop: 6 }}>
                <strong>{t('invoice.print.lawfulReason')}</strong> {t(`invoice.reasons.${doc.lawful_reason}`)}
              </div>
            ) : null}
          </div>
          <div style={{ border: '1px dashed var(--sf-line)', padding: 6, fontSize: 10, color: 'var(--sf-text-muted)', textAlign: 'center', alignSelf: 'start' }}>
            {doc.irn ? <span className="mono">{doc.irn}</span> : t('invoice.print.irnNote')}
          </div>
        </section>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <caption className="sr-only">{t('invoice.print.linesCaption')}</caption>
          <thead>
            <tr>
              <th scope="col" style={head}>#</th>
              <th scope="col" style={head}>{t('invoice.print.description')}</th>
              <th scope="col" style={head}>{t('invoice.print.hsn')}</th>
              <th scope="col" style={numHead}>{t('invoice.print.qty')}</th>
              <th scope="col" style={head}>{t('invoice.print.unit')}</th>
              <th scope="col" style={numHead}>{t('invoice.print.rate')}</th>
              <th scope="col" style={numHead}>{t('invoice.print.discount')}</th>
              <th scope="col" style={numHead}>{t('invoice.print.taxable')}</th>
              <th scope="col" style={numHead}>{t('invoice.print.gstPct')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td style={cell}>{l.line_no}</td>
                <td style={cell}>{l.description}</td>
                <td style={{ ...cell, fontFamily: 'var(--sf-font-mono)' }}>{l.hsn_code ?? '—'}</td>
                <td style={num}>{formatIndian(l.qty, 3)}</td>
                <td style={cell}>{l.uom}</td>
                <td style={num}>{formatIndian(l.rate)}</td>
                <td style={num}>{formatIndian(l.discount)}</td>
                <td style={num}>{formatIndian(l.taxable)}</td>
                <td style={num}>{formatIndian(l.gst_rate, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <strong>{t('invoice.print.amountInWords')}</strong> {doc.amount_in_words}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
              <caption style={{ textAlign: 'left', fontWeight: 600, padding: '2px 0' }}>{t('invoice.print.hsnSummary')}</caption>
              <thead>
                <tr>
                  <th scope="col" style={head}>{t('invoice.print.hsn')}</th>
                  <th scope="col" style={numHead}>{t('invoice.print.gstPct')}</th>
                  <th scope="col" style={numHead}>{t('invoice.print.taxable')}</th>
                  {intra ? (
                    <>
                      <th scope="col" style={numHead}>{t('invoice.tax.cgst')}</th>
                      <th scope="col" style={numHead}>{t('invoice.tax.sgst')}</th>
                    </>
                  ) : (
                    <th scope="col" style={numHead}>{t('invoice.tax.igst')}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {summary.map((h) => (
                  <tr key={h.key}>
                    <td style={{ ...cell, fontFamily: 'var(--sf-font-mono)' }}>{h.hsn}</td>
                    <td style={num}>{formatIndian(h.rate, 2)}</td>
                    <td style={num}>{formatIndian(h.taxable)}</td>
                    {intra ? (
                      <>
                        <td style={num}>{formatIndian(h.cgst)}</td>
                        <td style={num}>{formatIndian(h.sgst)}</td>
                      </>
                    ) : (
                      <td style={num}>{formatIndian(h.igst)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {irn?.status === 'active' ? <IrnPrintBlock irn={irn} /> : <div style={{ fontSize: 10, color: 'var(--sf-text-muted)' }}>{t('invoice.print.einvoiceNote')}</div>}
          </div>
          <div>
            <Row label={t('invoice.tax.taxable')} value={<Amount value={doc.taxable} />} />
            <Row label={t('invoice.tax.cgst')} value={<Amount value={doc.cgst} />} />
            <Row label={t('invoice.tax.sgst')} value={<Amount value={doc.sgst} />} />
            <Row label={t('invoice.tax.igst')} value={<Amount value={doc.igst} />} />
            <Row label={t('invoice.tax.roundOff')} value={<Amount value={doc.round_off} />} />
            <Row label={t('invoice.print.totalRupees')} value={<Amount value={doc.total} />} strong />
          </div>
        </section>

        <footer style={{ marginTop: 'auto', borderTop: '1px solid var(--sf-line)', paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
          <span style={{ color: 'var(--sf-text-muted)' }}>{t('invoice.print.eoe')}</span>
          <span style={{ textAlign: 'right' }}>
            {t('invoice.print.forCompany', { company: company?.name ?? doc.company_name })}
            <br />
            <br />
            {t('invoice.print.signatory')}
          </span>
        </footer>
      </article>
    </>
  )
}
