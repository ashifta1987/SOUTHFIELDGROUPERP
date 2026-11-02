import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FLOWS, routeForFile, type Flow, type FlowStep } from '@/app/flows'
import { SCREEN_BY_FILE } from '@/app/screens'
import { Card, Chip, PageHeader } from '@/ui'
import { HANDOFFS, MAIN_LINE, SUPPORTING } from './layout'

const BY_KEY: Record<string, Flow> = Object.fromEntries(FLOWS.map((f) => [f.key, f]))

/** Phase chip for a step's screen: "Built" once its phase is done (Phase 1 and before), else "Phase N". */
function StepPhase({ step }: { step: FlowStep }) {
  const { t } = useTranslation()
  const phase = SCREEN_BY_FILE[step.file]?.phase
  if (phase === undefined) return null
  return phase <= 1 ? (
    <Chip tone="success" icon="check">
      {t('erpFlow.built')}
    </Chip>
  ) : (
    <Chip tone="neutral" icon="clock">
      {t('erpFlow.phaseN', { n: phase })}
    </Chip>
  )
}

/**
 * Total workflow (`ERPFlow`): the 17 workflows from src/app/flows.ts (generated from WORKFLOWS.md), each step linked
 * to its screen with the phase it arrives in, plus the hand-offs between workflows. This page has no workflow strip.
 */
export function ERPFlowPage() {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string>(MAIN_LINE[0])
  const flow = (BY_KEY[selected] ?? FLOWS[0]) as Flow
  const screens = new Set(FLOWS.flatMap((f) => f.steps.map((s) => s.file))).size
  const name = (key: string) => t(`flows.${key}`, { defaultValue: BY_KEY[key]?.name ?? key })

  const box = (key: string) => {
    const f = BY_KEY[key]
    if (!f) return null
    const active = key === selected
    return (
      <button
        type="button"
        aria-pressed={active}
        onClick={() => setSelected(key)}
        style={{
          textAlign: 'left',
          minWidth: 120,
          padding: '8px 12px',
          border: `1px solid ${active ? 'var(--sf-primary)' : 'var(--sf-line)'}`,
          borderRadius: 'var(--sf-radius-input)',
          background: active ? 'var(--sf-primary-tint)' : 'var(--sf-surface)',
          color: 'var(--sf-text)',
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>{name(key)}</span>
        <span className="k" style={{ fontSize: 12 }}>
          {t('erpFlow.screens', { count: f.steps.length })}
        </span>
      </button>
    )
  }

  return (
    <>
      <PageHeader title={t('erpFlow.title')} subtitle={t('erpFlow.subtitle', { flows: FLOWS.length, screens })} />

      <Card title={t('erpFlow.mainLine')} labelledBy="flow-main">
        <div className="sf-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {MAIN_LINE.map((k, i) => (
            <Fragment key={k}>
              {i > 0 ? (
                <span className="k" aria-hidden="true">
                  →
                </span>
              ) : null}
              {box(k)}
            </Fragment>
          ))}
        </div>
        <div className="sf-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--sf-line)' }}>
          <span className="k" style={{ fontSize: 12.5, marginRight: 4 }}>
            {t('erpFlow.supporting')}
          </span>
          {SUPPORTING.map((k) => (
            <Fragment key={k}>{box(k)}</Fragment>
          ))}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16, alignItems: 'start' }}>
        <Card labelledBy="flow-steps" style={{ borderTop: '3px solid var(--sf-primary)' }}>
          <div className="sf-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 id="flow-steps" className="sf-card__title" style={{ margin: 0 }}>
              {name(flow.key)}
            </h2>
            <span className="k" style={{ fontSize: 12 }}>
              {t('erpFlow.usedBy', { who: flow.usedBy })}
            </span>
          </div>
          <ol aria-label={t('erpFlow.stepsCaption', { name: name(flow.key) })} style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
            {flow.steps.map((s, i) => (
              <li key={`${s.file}-${i}`} className="sf-row" style={{ gap: 10, padding: '7px 0', borderTop: i ? '1px solid var(--sf-line)' : undefined, alignItems: 'center' }}>
                <span className="sf-strip__num" aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 999, background: 'var(--sf-row-group)', display: 'inline-grid', placeItems: 'center' }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{s.label}</span>
                <StepPhase step={s} />
                <Link to={routeForFile(s.file)} aria-label={t('erpFlow.openStep', { label: s.label })} style={{ fontWeight: 600, fontSize: 13, minHeight: 24, display: 'inline-flex', alignItems: 'center' }}>
                  {t('erpFlow.open')}
                </Link>
              </li>
            ))}
          </ol>
        </Card>

        <Card title={t('erpFlow.handoffsTitle')} labelledBy="flow-handoffs">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12.5 }}>
            {HANDOFFS.map((h, i) => (
              <li key={h.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, auto) 1fr', gap: 10, padding: '7px 0', borderTop: i ? '1px solid var(--sf-line)' : undefined }}>
                <strong>
                  {name(h.from)} → {name(h.to)}
                </strong>
                <span className="muted">{t(`erpFlow.handoffs.${h.id}`)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title={t('erpFlow.glanceTitle')} labelledBy="flow-glance">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
          {FLOWS.map((f) => (
            <article key={f.key} className="sf-card" style={{ padding: '12px 14px' }} aria-labelledby={`glance-${f.key}`}>
              <div className="sf-row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <h3 id={`glance-${f.key}`} style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                  {name(f.key)}
                </h3>
                <span className="k" style={{ fontSize: 12, textAlign: 'right' }}>
                  {t('erpFlow.usedBy', { who: f.usedBy })}
                </span>
              </div>
              <ol style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '6px 6px', alignItems: 'center' }}>
                {f.steps.map((s, i) => {
                  const phase = SCREEN_BY_FILE[s.file]?.phase
                  return (
                    <li key={`${s.file}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {i > 0 ? (
                        <span className="k" aria-hidden="true">
                          →
                        </span>
                      ) : null}
                      <Link className="sf-strip__step" to={routeForFile(s.file)}>
                        <span className="sf-strip__num">{i + 1}</span>
                        {s.label}
                        {phase !== undefined ? (
                          <span className="k" style={{ fontWeight: 400, fontSize: 11 }}>
                            · {phase <= 1 ? t('erpFlow.built') : t('erpFlow.phaseN', { n: phase })}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  )
                })}
              </ol>
            </article>
          ))}
        </div>
      </Card>
    </>
  )
}
