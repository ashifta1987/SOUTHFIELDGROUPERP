import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { routeForFile } from '@/app/flows'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { rateText } from '@/features/inventory/product-master/shared'
import { Amount, Card, Chip, EmptyState, KpiTiles, PageHeader, Skeleton } from '@/ui'

type Product = ViewRow<'products'>
type Check = 'hsn' | 'ca' | 'mrp' | 'netQty' | 'licence'
const CHECKS: Check[] = ['hsn', 'ca', 'mrp', 'netQty', 'licence']

/**
 * Biochem products (`BiochemProducts`): the finished goods and perfumes linked to the Biochem company, with MRP,
 * the GST rate in force (from the HSN table) and the label checks a pack needs before it can go on a bill.
 * The checks are display-only; the bill RPCs enforce them on the server.
 */
export function BiochemProductsPage() {
  const { t } = useTranslation()
  const can = useCan()
  const companiesQ = useApiView('companies', { order: 'code' })
  const companies = rowsOf(companiesQ)
  const [params, setParams] = useSearchParams()
  const biochem = companies.find((c) => c.logo_key === 'biochem')
  const chosen = companies.find((c) => c.id === params.get('company')) ?? biochem ?? companies[0]
  const productsQ = useApiView('products', { order: 'code', limit: 2000 })
  const hsnQ = useApiView('hsn_codes', { order: 'code' })
  const hsnConfirmed = useMemo(() => new Map(rowsOf(hsnQ).map((h) => [h.code, Boolean(h.current_ca_confirmed)])), [hsnQ])

  const rows = rowsOf(productsQ).filter((p) => (p.kind === 'finished' || p.kind === 'perfumery') && chosen && (p.company_ids ?? []).includes(chosen.id))

  function failing(p: Product): Check[] {
    const out: Check[] = []
    if (!p.hsn_code) out.push('hsn')
    if (!p.hsn_code || p.gst_rate === null || !hsnConfirmed.get(p.hsn_code)) out.push('ca')
    if (p.mrp === null) out.push('mrp')
    if (p.net_qty === null || !p.net_qty_uom) out.push('netQty')
    if (!p.licence_no) out.push('licence')
    return out
  }

  const fails = new Map(rows.map((p) => [p.id, failing(p)]))
  const count = (c: Check) => rows.filter((p) => fails.get(p.id)?.includes(c)).length
  const ready = rows.filter((p) => (fails.get(p.id) ?? []).length === 0).length

  const groups = new Map<string, Product[]>()
  for (const p of rows) {
    const key = p.group_name ?? ''
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  const groupKeys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  const loading = companiesQ.isLoading || productsQ.isLoading
  const pmRoute = routeForFile('ProductMaster')

  return (
    <>
      <PageHeader title={t('biochemProducts.title')} subtitle={chosen ? t('biochemProducts.subtitle', { company: chosen.short_name || chosen.name }) : t('biochemProducts.subtitleNone')} />

      {!biochem && companies.length > 0 ? (
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
          {t('biochemProducts.noBiochem')}
        </p>
      ) : null}
      {!biochem ? (
        <div style={{ marginBottom: 16 }}>
          <CompanyPicker
            list={companies}
            value={chosen?.id}
            onChange={(id) => {
              const next = new URLSearchParams(params)
              next.set('company', id)
              setParams(next, { replace: true })
            }}
          />
        </div>
      ) : null}

      <KpiTiles
        ariaLabel={t('biochemProducts.kpi.label')}
        items={[
          { key: 'all', label: t('biochemProducts.kpi.products'), value: rows.length, sub: t('biochemProducts.kpi.productsSub') },
          { key: 'ready', label: t('biochemProducts.kpi.ready'), value: ready, sub: t('biochemProducts.kpi.readySub') },
          { key: 'ca', label: t('biochemProducts.kpi.rate'), value: count('ca'), sub: t('biochemProducts.kpi.rateSub') },
          { key: 'mrp', label: t('biochemProducts.kpi.mrp'), value: count('mrp'), sub: t('biochemProducts.kpi.mrpSub') },
          { key: 'licence', label: t('biochemProducts.kpi.licence'), value: count('licence'), sub: t('biochemProducts.kpi.licenceSub') },
        ]}
      />

      <Card pad={false} style={{ marginTop: 16 }}>
        <div className="sf-card__pad" style={{ paddingBottom: 6 }}>
          <div className="sf-card__head">
            <h2 className="sf-card__title">{t('biochemProducts.tableTitle')}</h2>
            <span className="k" style={{ fontSize: 12 }}>
              {t('biochemProducts.tableHint')}
            </span>
          </div>
        </div>
        {loading ? (
          <div className="sf-card__pad">
            <Skeleton height={160} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('biochemProducts.emptyTitle')}
            body={can('products.manage') ? t('biochemProducts.emptyBodyAdmin') : t('biochemProducts.emptyBody')}
            action={<Link to={pmRoute}>{t('biochemProducts.toMaster')}</Link>}
          />
        ) : (
          <div className="sf-table-wrap" role="region" aria-label={t('biochemProducts.tableTitle')} tabIndex={0}>
            <table className="sf-table" style={{ minWidth: 960 }}>
              <caption className="sr-only">{t('biochemProducts.tableTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('biochemProducts.col.product')}</th>
                  <th scope="col">{t('biochemProducts.col.pack')}</th>
                  <th scope="col" className="r">
                    {t('biochemProducts.col.mrp')}
                  </th>
                  <th scope="col">{t('biochemProducts.col.hsn')}</th>
                  <th scope="col">{t('biochemProducts.col.gst')}</th>
                  <th scope="col">{t('biochemProducts.col.check')}</th>
                </tr>
              </thead>
              {groupKeys.map((g) => {
                const list = groups.get(g) ?? []
                return (
                  <tbody key={g || 'none'}>
                    <tr style={{ background: 'var(--sf-row-group)' }}>
                      <th scope="colgroup" colSpan={6} style={{ textAlign: 'left', fontWeight: 600 }}>
                        {g || t('biochemProducts.noGroup')} <span className="k" style={{ fontWeight: 400 }}>· {t('biochemProducts.groupCount', { count: list.length })}</span>
                      </th>
                    </tr>
                    {list.map((p) => {
                      const f = fails.get(p.id) ?? []
                      return (
                        <tr key={p.id}>
                          <td>
                            <div>{p.name}</div>
                            <div className="k mono" style={{ fontSize: 12 }}>
                              {p.code}
                            </div>
                          </td>
                          <td>
                            <span className="mono">{p.pack_size || (p.net_qty !== null ? `${p.net_qty} ${p.net_qty_uom ?? ''}` : '—')}</span>
                          </td>
                          <td className="r">
                            <Amount value={p.mrp} />
                          </td>
                          <td className="mono">{p.hsn_code ?? '—'}</td>
                          <td>{p.gst_rate === null ? <span className="muted">—</span> : <Chip tone="teal">{rateText(p.gst_rate)}</Chip>}</td>
                          <td>
                            {f.length === 0 ? (
                              <Chip tone="teal" icon="check">
                                {t('biochemProducts.allPass')}
                              </Chip>
                            ) : (
                              <div className="sf-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                                {CHECKS.filter((c) => f.includes(c)).map((c) => (
                                  <Chip key={c} tone="signal" icon="alert">
                                    {t(`biochemProducts.fail.${c}`)}
                                  </Chip>
                                ))}
                                <Link to={pmRoute} style={{ fontSize: 12, fontWeight: 600 }} aria-label={t('biochemProducts.fixFor', { name: p.name })}>
                                  {t('biochemProducts.fix')}
                                </Link>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                )
              })}
            </table>
          </div>
        )}
        <div className="sf-card__pad k" style={{ fontSize: 12, paddingTop: 10 }}>
          {t('biochemProducts.tableNote')}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start', marginTop: 16 }}>
        <Card title={t('biochemProducts.before.title')}>
          <dl style={{ margin: 0 }}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} style={{ padding: '10px 0', borderTop: i > 1 ? '1px solid var(--sf-line-soft)' : undefined }}>
                <dt style={{ fontWeight: 600, fontSize: 13 }}>{t(`biochemProducts.before.t${i}`)}</dt>
                <dd className="k" style={{ margin: '2px 0 0', fontSize: 13 }}>
                  {t(`biochemProducts.before.b${i}`)}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title={t('biochemProducts.bill.title')}>
          <dl style={{ margin: 0 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ padding: '10px 0', borderTop: i > 1 ? '1px solid var(--sf-line-soft)' : undefined }}>
                <dt style={{ fontWeight: 600, fontSize: 13 }}>{t(`biochemProducts.bill.t${i}`)}</dt>
                <dd className="k" style={{ margin: '2px 0 0', fontSize: 13 }}>
                  {t(`biochemProducts.bill.b${i}`)}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  )
}
