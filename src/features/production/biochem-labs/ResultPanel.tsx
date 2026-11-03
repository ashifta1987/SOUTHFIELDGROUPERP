import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { Button, Card, Field, FieldGrid, SelectField } from '@/ui'
import { Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, useProductionRights } from '../biochem-common/biochem'

export type Sample = ViewRow<'lab_samples'>
interface SpecRow {
  parameter: string
  min: number | null
  max: number | null
  unit: string | null
  stage: string | null
}

/** QC limits for a sample: from the batch's (or trial's) approved formula version, for the sample's stage. */
export function useSampleSpec(s: Sample) {
  const batch = useApiView('batches', { eq: { id: s.batch_id }, enabled: Boolean(s.batch_id) })
  const trial = useApiView('rnd_trials', { eq: { id: s.trial_id }, enabled: Boolean(s.trial_id) })
  const versionId = rowsOf(batch)[0]?.formula_version_id ?? rowsOf(trial)[0]?.formula_version_id ?? null
  const fv = useApiView('formula_versions', { eq: { id: versionId }, enabled: Boolean(versionId) })
  const raw = rowsOf(fv)[0]?.qc_spec
  const all = Array.isArray(raw) ? (raw as unknown as SpecRow[]) : []
  return { spec: all.filter((r) => !r.stage || r.stage === s.kind), loading: batch.isLoading || trial.isLoading || fv.isLoading }
}

/**
 * Record a lab result for one sample (testing lab or R&D). Values are typed per QC parameter; the server compares them
 * with the formula's limits and refuses a pass outside them (qc.out_of_spec). The instrument must be in use and within
 * calibration (asset.calibration_due).
 */
export function ResultPanel({ sample, onClose, compact }: { sample: Sample; onClose?: () => void; compact?: boolean }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const { spec } = useSampleSpec(sample)
  const instruments = useApiView('assets', { eq: { company_id: sample.company_id, status: 'active' }, order: 'code' })
  const insts = rowsOf(instruments).filter((a) => a.kind === 'lab_instrument' || a.kind === 'scale')
  const [values, setValues] = useState<Record<string, string>>({})
  const [extraName, setExtraName] = useState('')
  const [extraValue, setExtraValue] = useState('')
  const [instrument, setInstrument] = useState('')
  const [remarks, setRemarks] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const rec = useApiMutation<{ p_sample_id: string; p: Record<string, unknown> }, { result: string; out_of_spec: { parameter: string }[] }>('record_lab_result', PROD_REFRESH)
  const canTest = sample.kind === 'rnd' ? rights.rnd : rights.qcTest
  const open = ['pending', 'retained'].includes(sample.status)

  function submit(result: 'pass' | 'fail' | 'hold') {
    setHint(null)
    const params: Record<string, number> = {}
    for (const [k, v] of Object.entries(values)) {
      if (!v.trim()) continue
      const n = Number(v.replace(/,/g, ''))
      if (!Number.isFinite(n)) return setHint(t('biochemLabs.result.numberHint', { name: k }))
      params[k] = n
    }
    if (extraName.trim() && extraValue.trim()) {
      const n = Number(extraValue)
      if (!Number.isFinite(n)) return setHint(t('biochemLabs.result.numberHint', { name: extraName }))
      params[extraName.trim()] = n
    }
    rec.mutate({ p_sample_id: sample.id, p: { result, parameters: params, instrument_id: instrument || null, remarks: remarks.trim() || null } })
  }

  const title = t('biochemLabs.result.title', { no: sample.sample_no })
  return (
    <Card
      title={title}
      action={
        onClose ? (
          <Button size="sm" variant="link" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : undefined
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {[t(`biochemEntry.sampleKind.${sample.kind}`, { defaultValue: sample.kind }), sample.batch_no ? t('biochemLabs.result.batch', { no: sample.batch_no }) : null, sample.trial_code ? t('biochemLabs.result.trial', { code: sample.trial_code }) : null, sample.product_name]
          .filter(Boolean)
          .join(' · ')}{' '}
        <ProdStatus status={sample.status} />
      </p>
      {!open ? (
        <p className="k" style={{ margin: 0 }}>
          {t('biochemLabs.result.already', { result: sample.last_result ? t(`biochemCommon.status.${sample.last_result}`) : '—' })}
        </p>
      ) : !canTest ? (
        <p className="k" style={{ margin: 0 }}>
          {rights.readOnly ? t('biochemCommon.readOnly') : t('biochemLabs.result.noRight')}
        </p>
      ) : (
        <>
          <FieldGrid cols={compact ? 2 : 3}>
            {spec.map((r) => (
              <Field
                key={r.parameter}
                label={`${r.parameter}${r.unit ? ` (${r.unit})` : ''}`}
                inputMode="decimal"
                value={values[r.parameter] ?? ''}
                onChange={(e) => setValues({ ...values, [r.parameter]: e.target.value })}
                help={t('biochemLabs.result.limit', { min: r.min ?? '—', max: r.max ?? '—' })}
              />
            ))}
            {spec.length === 0 ? (
              <>
                <Field label={t('biochemLabs.result.extraName')} value={extraName} onChange={(e) => setExtraName(e.target.value)} />
                <Field label={t('biochemLabs.result.extraValue')} inputMode="decimal" value={extraValue} onChange={(e) => setExtraValue(e.target.value)} />
              </>
            ) : null}
            <SelectField
              label={t('biochemLabs.result.instrument')}
              value={instrument}
              onChange={(e) => setInstrument(e.target.value)}
              options={[{ value: '', label: t('biochemLabs.result.noInstrument') }, ...insts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}${a.calibration_overdue ? ` (${t('biochemLabs.result.calDue')})` : ''}` }))]}
            />
            <Field label={t('biochemLabs.result.remarks')} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </FieldGrid>
          {spec.length === 0 ? <p className="k">{t('biochemLabs.result.noSpec')}</p> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Button variant="primary" busy={rec.isPending && rec.variables?.p.result === 'pass'} onClick={() => submit('pass')}>
              {t('biochemLabs.result.pass')}
            </Button>
            <Button busy={rec.isPending && rec.variables?.p.result === 'hold'} onClick={() => submit('hold')}>
              {t('biochemLabs.result.hold')}
            </Button>
            <Button variant="danger" busy={rec.isPending && rec.variables?.p.result === 'fail'} onClick={() => submit('fail')}>
              {t('biochemLabs.result.fail')}
            </Button>
          </div>
        </>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {hint ? (
          <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
            {hint}
          </p>
        ) : null}
        <ProductionErrorBox error={rec.error} />
        <Done>{rec.data ? t('biochemLabs.result.saved', { result: t(`biochemCommon.status.${rec.data.result}`) }) : null}</Done>
      </div>
      <p className="k" style={{ marginBottom: 0 }}>
        {t('biochemLabs.result.rule')}
      </p>
    </Card>
  )
}
