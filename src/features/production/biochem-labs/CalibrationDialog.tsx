import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { Field, FieldGrid, FormDialog, SelectField } from '@/ui'
import { ProductionErrorBox, PROD_REFRESH } from '../biochem-common/biochem'

/** Record a calibration (assets.manage or qc.test). A fail takes the instrument out of service; the next date defaults to the interval. */
export function CalibrationDialog({ asset, onClose }: { asset: ViewRow<'assets'>; onClose: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({ calibrated_on: todayIst(), next_due: '', result: 'pass', agency: '', remarks: '' })
  const save = useApiMutation<{ p_asset_id: string; p: Record<string, unknown> }, { next_due: string | null }>('record_calibration', PROD_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('biochemLabs.cal.title', { code: asset.code, name: asset.name })}
      description={asset.calibration_interval_days ? t('biochemLabs.cal.interval', { n: asset.calibration_interval_days }) : t('biochemLabs.cal.noInterval')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      error={<ProductionErrorBox error={save.error} />}
      onSubmit={() => save.mutate({ p_asset_id: asset.id, p: { ...f, next_due: f.next_due || null, agency: f.agency.trim() || null, remarks: f.remarks.trim() || null } }, { onSuccess: onClose })}
    >
      <FieldGrid cols={2}>
        <Field label={t('biochemLabs.cal.on')} type="date" value={f.calibrated_on} onChange={set('calibrated_on')} />
        <Field label={t('biochemLabs.cal.next')} type="date" value={f.next_due} onChange={set('next_due')} />
        <SelectField label={t('biochemLabs.cal.result')} value={f.result} onChange={set('result')} options={['pass', 'adjusted', 'fail'].map((r) => ({ value: r, label: t(`biochemCommon.status.${r}`) }))} />
        <Field label={t('biochemLabs.cal.agency')} value={f.agency} onChange={set('agency')} />
      </FieldGrid>
      <Field label={t('biochemLabs.cal.remarks')} value={f.remarks} onChange={set('remarks')} />
    </FormDialog>
  )
}
