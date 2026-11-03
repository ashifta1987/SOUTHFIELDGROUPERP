import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView } from '@/data/queries'
import { Amount, Field, Skeleton } from '@/ui'
import { FieldFrame, FieldGate, Line, useFieldCompany, useFieldRights, useMyDay } from '../common/field'

/**
 * Reference library (§15A.6): the company's active products with MRP and pack size from the product master (cached by
 * the app for offline use). Certificates, flyers and FAQs appear here once Admin uploads them and allows sharing.
 */
export function FieldLibraryPage() {
  const { t } = useTranslation()
  const rights = useFieldRights()
  const { companyId, company, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const products = useApiView('products', { eq: { status: 'active' }, order: 'name', limit: 500, enabled: Boolean(companyId) })
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const mine = rowsOf(products).filter((p) => (p.company_ids ?? []).includes(companyId ?? '') && !p.is_scrap && !['raw_material', 'packaging', 'spares', 'consumable'].includes(p.kind))
  const shown = needle ? mine.filter((p) => `${p.code} ${p.name}`.toLowerCase().includes(needle)) : mine
  const onDuty = day.data?.status === 'ready' ? Boolean(day.data.data?.on_duty) : undefined
  return (
    <FieldFrame title={t('fieldLibrary.title')} sub={company?.short_name ?? company?.name} onDuty={onDuty}>
      <FieldGate loading={isLoading} companyId={companyId} sell={rights.sell}>
        <Field label={t('fieldLibrary.search')} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        <section className="sf-phone-card" aria-labelledby="lib-products">
          <h2 id="lib-products">{t('fieldLibrary.products')}</h2>
          {products.isLoading ? (
            <Skeleton height={80} />
          ) : shown.length === 0 ? (
            <p className="k" style={{ margin: 0 }}>
              {t('fieldLibrary.none')}
            </p>
          ) : (
            <div>
              {shown.map((p) => (
                <Line
                  key={p.id}
                  label={
                    <span>
                      {p.name}
                      <br />
                      <span className="k">
                        {p.code}
                        {p.pack_size ? ` · ${p.pack_size}` : ''}
                        {p.net_qty ? ` · ${p.net_qty} ${p.net_qty_uom ?? ''}` : ''}
                      </span>
                    </span>
                  }
                  value={p.mrp !== null ? <>{t('fieldLibrary.mrp')} <Amount value={p.mrp} rupee /></> : t('fieldLibrary.noMrp')}
                />
              ))}
            </div>
          )}
        </section>
        <section className="sf-phone-card" aria-labelledby="lib-docs">
          <h2 id="lib-docs">{t('fieldLibrary.docs')}</h2>
          <p style={{ margin: 0 }}>{t('fieldLibrary.docsNote')}</p>
        </section>
      </FieldGate>
    </FieldFrame>
  )
}
