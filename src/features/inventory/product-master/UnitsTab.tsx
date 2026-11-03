import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { Card, DataTable, type Column } from '@/ui'

type Uom = ViewRow<'uoms'>

/** Units tab: the GST unit codes (UQC) from api.uoms, read-only. */
export function UnitsTab() {
  const { t } = useTranslation()
  const q = useApiView('uoms', { order: 'code' })
  const columns: Column<Uom>[] = [
    { key: 'code', header: t('productMaster.u.code'), width: 120, render: (u) => <span className="mono">{u.code}</span> },
    { key: 'label', header: t('productMaster.u.label'), render: (u) => u.label },
    { key: 'decimals', header: t('productMaster.u.decimals'), align: 'right', render: (u) => <span className="mono">{u.decimals}</span> },
  ]
  return (
    <Card pad={false}>
      <div className="sf-card__pad" style={{ paddingBottom: 8 }}>
        <div className="sf-card__head">
          <h2 className="sf-card__title">{t('productMaster.u.title')}</h2>
        </div>
        <p className="k" style={{ margin: 0, fontSize: 13 }}>
          {t('productMaster.u.help')}
        </p>
      </div>
      <DataTable caption={t('productMaster.u.title')} columns={columns} rows={rowsOf(q)} rowKey={(u) => u.code} loading={q.isLoading} minWidth={400} />
    </Card>
  )
}
