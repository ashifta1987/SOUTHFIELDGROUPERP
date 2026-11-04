import { useTranslation } from 'react-i18next'

export type Step = 'upload' | 'check' | 'import' | 'result'
export const STEPS: Step[] = ['upload', 'check', 'import', 'result']

export function StepBar({ step }: { step: Step }) {
  const { t } = useTranslation()
  const at = STEPS.indexOf(step)
  return (
    <ol aria-label={t('importData.steps.label')} style={{ listStyle: 'none', margin: '0 0 16px', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
      {STEPS.map((s, i) => {
        const done = i < at || (s === 'result' && step === 'result')
        const current = i === at && !done
        return (
          <li key={s} aria-current={current ? 'step' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span aria-hidden="true" style={{ height: 5, borderRadius: 3, background: done ? 'var(--sf-success)' : current ? 'var(--sf-info)' : 'var(--sf-line)' }} />
            <span style={{ fontSize: 13, fontWeight: done || current ? 600 : 400, color: done ? 'var(--sf-success-ink)' : current ? 'var(--sf-info-ink)' : 'var(--sf-text-muted)' }}>
              {done ? '✓ ' : current ? '● ' : ''}
              {`${i + 1} · ${t(`importData.steps.${s}`)}`}
              <span className="sr-only">{done ? ` (${t('importData.steps.done')})` : current ? ` (${t('importData.steps.current')})` : ''}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

