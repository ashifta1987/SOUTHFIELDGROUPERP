import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { flowForScreen, routeForFile } from '@/app/flows'
import { useBugFixerOpenCount } from '@/data/queries'
import { Icon } from '@/ui'

/** Workflow strip (FlowStrip.html), driven by src/app/flows.ts. Bug fixer count is live from the database. */
export function FlowStrip({ file }: { file: string }) {
  const { t } = useTranslation()
  const bug = useBugFixerOpenCount()
  const found = flowForScreen(file)
  if (!found) return null
  const { flow, stepIndex } = found

  let bugLabel: string
  if (bug.data?.status === 'ready') bugLabel = t('strip.bugOpen', { count: bug.data.data })
  else if (bug.data?.status === 'not-ready') bugLabel = t('strip.bugNotReady')
  else bugLabel = t('strip.bug')

  return (
    <nav className="sf-strip" aria-label={t('strip.label', { name: t(`flows.${flow.key}`, { defaultValue: flow.name }) })}>
      <span className="sf-strip__title">
        <Icon name="flow" size={16} strokeWidth={2} style={{ color: 'var(--sf-primary)' }} />
        <strong>{t(`flows.${flow.key}`, { defaultValue: flow.name })}</strong>
        <span className="k">{t('strip.step', { i: stepIndex + 1, n: flow.steps.length, who: flow.usedBy })}</span>
      </span>
      {flow.steps.map((s, i) => (
        <Fragment key={`${s.file}-${i}`}>
          {i > 0 ? (
            <span className="k" aria-hidden="true">
              →
            </span>
          ) : null}
          <Link className="sf-strip__step" to={routeForFile(s.file)} aria-current={i === stepIndex ? 'step' : undefined}>
            <span className="sf-strip__num">{i + 1}</span>
            {s.label}
          </Link>
        </Fragment>
      ))}
      <span className="sf-strip__end">
        <Link className="sf-strip__bug" to={routeForFile('BookFixes')}>
          {bugLabel}
        </Link>
        <Link className="sf-strip__total" to={routeForFile('ERPFlow')}>
          {t('strip.total')}
        </Link>
      </span>
    </nav>
  )
}
