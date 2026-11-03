import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Amount, TaxClassChip } from '@/ui'
import { formatIndian } from '@/shared/format'
import { hsnSummary, stateLabel, type TaxPreviewLine } from './docs'

/** Debounce a value (the tax preview runs after typing pauses). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

export interface Totals {
  taxable: number | string
  cgst: number | string
  sgst: number | string
  igst: number | string
  round_off: number | string
  total: number | string
  amount_in_words: string | null
}

/** Totals under the lines (server figures): taxable, CGST/SGST or IGST, round-off, total, amount in words. */
export function TotalsBlock({ totals, intra }: { totals: Totals | null; intra: boolean | null }) {
  const { t } = useTranslation()
  const row = (label: string, value: number | string | null | undefined, testId?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '4px 0' }} data-testid={testId}>
      <dt>{label}</dt>
      <dd className="mono" style={{ margin: 0 }}>
        {totals ? <Amount value={value} /> : '—'}
      </dd>
    </div>
  )
  return (
    <div style={{ minWidth: 300 }}>
    <dl aria-label={t('invoice.tax.totalsLabel')} style={{ margin: 0 }}>
      {row(t('invoice.tax.taxable'), totals?.taxable, 'tax-taxable')}
      {intra !== false ? row(t('invoice.tax.cgst'), totals?.cgst, 'tax-cgst') : null}
      {intra !== false ? row(t('invoice.tax.sgst'), totals?.sgst, 'tax-sgst') : null}
      {intra !== true ? row(t('invoice.tax.igst'), totals?.igst, 'tax-igst') : null}
      {row(t('invoice.tax.roundOff'), totals?.round_off, 'tax-round')}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '8px 0 4px', borderTop: '1px solid var(--sf-line)', marginTop: 4 }} data-testid="tax-total">
        <dt style={{ fontWeight: 700, fontSize: 16 }}>{t('invoice.tax.total')}</dt>
        <dd className="mono" style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>
          {totals ? <Amount value={totals.total} rupee /> : '—'}
        </dd>
      </div>
    </dl>
      {totals?.amount_in_words ? (
        <p className="muted" style={{ margin: '4px 0 0', fontSize: 12.5, textAlign: 'right' }} data-testid="tax-words">
          {totals.amount_in_words}
        </p>
      ) : null}
    </div>
  )
}

/** Right-hand tax panel: treatment, place of supply, the HSN-wise summary, e-invoice note. */
export function TaxPanel({
  withoutGst,
  lawfulReason,
  ourState,
  pos,
  intra,
  lines,
  waiting,
}: {
  withoutGst: boolean
  lawfulReason: string | null
  ourState: string | null
  pos: string | null
  intra: boolean | null
  lines: Pick<TaxPreviewLine, 'hsn_code' | 'gst_rate' | 'taxable' | 'cgst' | 'sgst' | 'igst'>[]
  waiting: boolean
}) {
  const { t } = useTranslation()
  const summary = hsnSummary(lines)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div className="sf-field__label">{t('invoice.tax.treatment')}</div>
        {withoutGst ? <TaxClassChip taxClass="withoutGst" reason={lawfulReason ? t(`invoice.reasons.${lawfulReason}`) : null} /> : <TaxClassChip taxClass="taxable" />}
        <p className="muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>{withoutGst ? t('invoice.tax.treatmentWithout') : t('invoice.tax.treatmentTaxable')}</p>
      </div>
      <div style={{ borderTop: '1px solid var(--sf-line-faint)', paddingTop: 12 }}>
        <div className="sf-field__label">{t('invoice.tax.placeOfSupply')}</div>
        {pos ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} data-testid="pos">
              <span className="sf-chip" data-tone="outline">{stateLabel(ourState)}</span>
              <span aria-hidden="true">→</span>
              <span className="sf-chip" data-tone="navy">{stateLabel(pos)}</span>
            </div>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12.5 }} data-testid="pos-rule">
              {intra ? t('invoice.tax.intra') : t('invoice.tax.inter')}
            </p>
          </>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{waiting ? t('invoice.tax.waiting') : t('invoice.tax.posPending')}</p>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--sf-line-faint)', paddingTop: 12 }}>
        <table className="sf-table" style={{ fontSize: 12.5 }}>
          <caption style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 4 }}>{t('invoice.tax.hsnSummary')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('invoice.lines.hsn')}</th>
              <th scope="col" className="r">
                {t('invoice.lines.gst')}
              </th>
              <th scope="col" className="r">
                {t('invoice.lines.taxable')}
              </th>
              <th scope="col" className="r">
                {t('invoice.tax.taxShort')}
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.length === 0 ? (
              <tr className="sf-table__state">
                <td colSpan={4}>{t('invoice.tax.noLinesYet')}</td>
              </tr>
            ) : (
              summary.map((h) => (
                <tr key={h.key}>
                  <td className="mono">{h.hsn}</td>
                  <td className="r mono">{formatIndian(h.rate, 2)}%</td>
                  <td className="r">
                    <Amount value={h.taxable} />
                  </td>
                  <td className="r">
                    <Amount value={(Math.round(h.cgst * 100) + Math.round(h.sgst * 100) + Math.round(h.igst * 100)) / 100} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={{ borderTop: '1px solid var(--sf-line-faint)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <strong>{t('invoice.tax.einvoice')}</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{t('invoice.tax.einvoiceNote')}</span>
      </div>
    </div>
  )
}
