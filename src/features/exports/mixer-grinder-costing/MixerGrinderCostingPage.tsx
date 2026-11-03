import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, EmptyState, Locked, PageHeader } from '@/ui'

const NEEDS = ['bom', 'rates', 'freight', 'labour', 'overheads', 'fob', 'container', 'checks'] as const
const LINKS: { key: string; to: string }[] = [
  { key: 'machines', to: '/production/machine-assembly' },
  { key: 'assembled', to: '/production/assembled-products' },
  { key: 'components', to: '/production/component-costing' },
  { key: 'exports', to: '/exports/export-orders' },
]

/**
 * Mixer grinder costing (`MixerCosting`): there are no costing tables for the export models yet, so this screen shows a
 * designed "not built yet" state that says what it will need and where those figures will come from. No figures are
 * shown — every rupee on this screen will come from the database once the tables exist.
 */
export function MixerGrinderCostingPage() {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t('mixerCosting.title')} subtitle={t('mixerCosting.subtitle')} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card>
          <EmptyState title={t('mixerCosting.notBuilt')} body={t('mixerCosting.notBuiltBody')} action={<Locked>{t('mixerCosting.when')}</Locked>} />
        </Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, alignItems: 'start' }}>
          <Card title={t('mixerCosting.needsTitle')}>
            <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {NEEDS.map((k) => (
                <li key={k}>
                  <strong>{t(`mixerCosting.needs.${k}.title`)}</strong> {t(`mixerCosting.needs.${k}.body`)}
                </li>
              ))}
            </ol>
          </Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card title={t('mixerCosting.ownerTitle')}>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['models', 'sheets', 'overheads', 'profit'].map((k) => (
                  <li key={k}>{t(`mixerCosting.owner.${k}`)}</li>
                ))}
              </ul>
            </Card>
            <Card title={t('mixerCosting.usedTitle')}>
              <p className="k" style={{ marginTop: 0 }}>
                {t('mixerCosting.usedBody')}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {LINKS.map((l) => (
                  <Link key={l.key} to={l.to} className="sf-btn" data-variant="secondary">
                    {t(`mixerCosting.links.${l.key}`)}
                  </Link>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </>
  )
}
