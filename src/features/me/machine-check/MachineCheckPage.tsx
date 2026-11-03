import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApiMutation } from '@/data/rpc'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { Done, useProductionRights } from '@/features/production/biochem-common/biochem'
import { PlasticsErrorBox, PLASTICS_REFRESH, useMachines } from '@/features/production/plastics-common/plastics'
import { formatDate } from '@/shared/format'
import { Button, Icon, SelectField, TextAreaField } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

const ITEMS = ['oil_level', 'no_leak', 'cooling', 'heaters', 'safety', 'clamps', 'grease', 'noise', 'hopper', 'gauge'] as const
const KINDS = ['injection_machine', 'pad_printer', 'assembly_station', 'compressor', 'chiller']

/**
 * Operator machine check on the phone (`OperatorCheck`): the daily checklist before the shift, one tap per item (OK or
 * not OK). Saved by api.record_machine_check; any item not OK puts the machine under repair and records a breakdown on
 * the asset — the server decides, the phone only sends the answers.
 */
export function MachineCheckPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const { list, companyId, choose } = useCompanyChoice()
  const machines = useMachines(companyId, KINDS)
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string; all_ok: boolean }>('record_machine_check', PLASTICS_REFRESH)
  const [asset, setAsset] = useState('')
  const [shift, setShift] = useState('day')
  const [answers, setAnswers] = useState<Record<string, boolean>>({})
  const [remarks, setRemarks] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const answered = ITEMS.filter((i) => i in answers).length
  const q = companyId ? `?company=${companyId}` : ''

  function submit() {
    setHint(null)
    if (!asset) return setHint(t('plMachineCheck.chooseFirst'))
    if (answered < ITEMS.length) return setHint(t('plMachineCheck.answerAll', { n: ITEMS.length - answered }))
    save.mutate(
      { p: { asset_id: asset, date: todayIst(), shift, checklist: ITEMS.map((i) => ({ item: t(`plMachineCheck.item.${i}`), ok: answers[i] === true })), remarks: remarks.trim() || null } },
      {
        onSuccess: () => {
          setAnswers({})
          setRemarks('')
        },
      },
    )
  }

  return (
    <>
      <header className="sf-phone-head">
        <Link to={`/me/injection-manager${q}`} className="sf-phone-head__btn" aria-label={t('plMachineCheck.back')}>
          <Icon name="home" size={22} />
        </Link>
        <div className="sf-phone-head__text">
          <h1 className="sf-phone-head__name" style={{ margin: 0 }}>
            {t('plMachineCheck.title')}
          </h1>
          <span className="sf-phone-head__sub">{t('plMachineCheck.sub', { date: formatDate(todayIst()) })}</span>
        </div>
        <span className="sf-chip mono" data-tone="outline" aria-label={t('plMachineCheck.progress', { n: answered, total: ITEMS.length })} data-testid="mc-progress">
          {answered} / {ITEMS.length}
        </span>
        {ctx?.openHelp ? (
          <button type="button" className="sf-phone-head__btn" aria-label={t('help.open')} onClick={ctx.openHelp}>
            <Icon name="help" size={24} />
          </button>
        ) : null}
      </header>
      <main className="sf-phone-body">
        {list.length > 1 ? <SelectField label={t('common.company')} value={companyId ?? ''} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} /> : null}
        {!rights.create ? <p className="sf-phone-note">{t('plMachineCheck.noRight')}</p> : null}
        <SelectField label={t('plMachineCheck.machine')} value={asset} onChange={(e) => setAsset(e.target.value)} options={[{ value: '', label: machines.isLoading ? t('common.loading') : machines.list.length ? t('plMachineCheck.chooseMachine') : t('plMachineCheck.noMachines') }, ...machines.list.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))]} />
        <SelectField label={t('plMachineCheck.shift')} value={shift} onChange={(e) => setShift(e.target.value)} options={['day', 'night', 'general'].map((s) => ({ value: s, label: t(`plasticsCommon.shift.${s}`) }))} />
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={t('plMachineCheck.list')}>
          {ITEMS.map((i) => {
            const label = t(`plMachineCheck.item.${i}`)
            const v = answers[i]
            return (
              <li key={i} className="sf-phone-card" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', margin: 0, flexDirection: 'row' }}>
                <span style={{ flex: 1, fontWeight: 600 }}>{label}</span>
                <button
                  type="button"
                  className="sf-btn"
                  aria-pressed={v === true}
                  aria-label={t('plMachineCheck.ok', { item: label })}
                  onClick={() => setAnswers({ ...answers, [i]: true })}
                  style={{ minWidth: 48, minHeight: 44, background: v === true ? 'var(--sf-success-tint)' : undefined, borderColor: 'var(--sf-success)', color: 'var(--sf-success-ink)' }}
                >
                  <Icon name="check" size={20} />
                </button>
                <button
                  type="button"
                  className="sf-btn"
                  aria-pressed={v === false}
                  aria-label={t('plMachineCheck.notOk', { item: label })}
                  onClick={() => setAnswers({ ...answers, [i]: false })}
                  style={{ minWidth: 48, minHeight: 44, background: v === false ? 'var(--sf-danger-tint)' : undefined, borderColor: 'var(--sf-danger-border)', color: 'var(--sf-danger-ink)' }}
                >
                  <Icon name="cross" size={20} />
                </button>
              </li>
            )
          })}
        </ul>
        <TextAreaField label={t('plMachineCheck.remarks')} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        <p className="sf-phone-note">{t('plMachineCheck.notOkNote')}</p>
        {hint ? (
          <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
            {hint}
          </p>
        ) : null}
        <PlasticsErrorBox error={save.error} />
        <Done>{save.data ? (save.data.all_ok ? t('plMachineCheck.savedOk') : t('plMachineCheck.savedRepair')) : null}</Done>
        {rights.create ? (
          <Button variant="primary" size="touch" busy={save.isPending} onClick={submit}>
            {t('plMachineCheck.submit')}
          </Button>
        ) : null}
      </main>
    </>
  )
}
