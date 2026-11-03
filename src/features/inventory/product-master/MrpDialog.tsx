import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { todayIst } from '@/features/admin/branches/company'
import { formatDate } from '@/shared/format'
import { Amount, Field, FieldGrid, FormDialog, Skeleton } from '@/ui'

type Product = ViewRow<'products'>

/** Set a product's MRP from a date (api.set_product_mrp). History is append-only and listed below the form. */
export function MrpDialog({ product, canManage, onClose }: { product: Product; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const [mrp, setMrp] = useState('')
  const [from, setFrom] = useState(todayIst())
  const [err, setErr] = useState<string | undefined>()
  const save = useApiMutation<{ p_product_id: string; p_mrp: string; p_effective_from: string }>('set_product_mrp', [['api', 'products'], ['api', 'product_mrp_history']])
  const history = useApiView('product_mrp_history', { eq: { product_id: product.id }, order: 'effective_from', ascending: false })
  const rows = rowsOf(history)

  function submit() {
    if (!canManage) {
      onClose()
      return
    }
    const v = mrp.trim()
    if (!/^\d+(\.\d{1,2})?$/.test(v) || !(Number(v) > 0)) {
      setErr(t('productMaster.mrp.err'))
      return
    }
    setErr(undefined)
    save.mutate({ p_product_id: product.id, p_mrp: v, p_effective_from: from }, { onSuccess: onClose })
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('productMaster.mrp.title', { name: product.name })}
      description={t('productMaster.mrp.help')}
      submitLabel={canManage ? t('productMaster.mrp.save') : t('common.close')}
      busy={save.isPending}
      onSubmit={submit}
      error={<RpcErrorBox error={save.error as RpcError | null} />}
    >
      {canManage ? (
        <FieldGrid>
          <Field label={t('productMaster.mrp.mrp')} className="mono" inputMode="decimal" prefix="₹" value={mrp} onChange={(e) => setMrp(e.target.value)} error={err} />
          <Field label={t('productMaster.mrp.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FieldGrid>
      ) : null}
      <h3 className="sf-card__title" style={{ fontSize: 14, margin: '14px 0 6px' }}>
        {t('productMaster.mrp.history')}
      </h3>
      {history.isLoading ? (
        <Skeleton height={40} />
      ) : rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('productMaster.mrp.none')}
        </p>
      ) : (
        <table className="sf-table">
          <caption className="sr-only">{t('productMaster.mrp.history')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('productMaster.mrp.from')}</th>
              <th scope="col" className="r">
                {t('productMaster.mrp.mrp')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{formatDate(r.effective_from)}</td>
                <td className="r">
                  <Amount value={r.mrp} rupee />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </FormDialog>
  )
}
