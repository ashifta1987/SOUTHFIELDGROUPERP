import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { routeForFile } from '@/app/flows'
import { Card, Chip, EmptyState, PageHeader, Skeleton } from '@/ui'

type Role = ViewRow<'roles'>
const VIEWS = ['all', 'all-readonly', 'gst'] as const

/**
 * How each person sees it (`UXOverview`): the three views and which roles get each, from api.roles
 * (label, view, sign-in method, second step). Explanatory text is i18n; no people's names.
 */
export function UXOverviewPage() {
  const { t } = useTranslation()
  const q = useApiView('roles', { order: 'sort' })
  const roles = rowsOf(q)

  return (
    <>
      <PageHeader title={t('uxOverview.title')} subtitle={t('uxOverview.subtitle')} />

      <Card title={t('uxOverview.decidesTitle')} labelledBy="ux-decides">
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
          {t('uxOverview.decidesBody')}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {VIEWS.map((v) => {
            const inView = roles.filter((r) => r.view_kind === v)
            return (
              <article key={v} className="sf-card" style={{ padding: '14px 16px' }} aria-labelledby={`ux-view-${v}`}>
                <ViewChip view={v} />
                <h3 id={`ux-view-${v}`} style={{ margin: '10px 0 6px', fontSize: 15, fontWeight: 600 }}>
                  {t(`uxOverview.view.${v}.title`)}
                </h3>
                <p style={{ margin: '0 0 10px', fontSize: 13 }}>{t(`uxOverview.view.${v}.body`)}</p>
                <h4 className="k" style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 600 }}>
                  {t('uxOverview.rolesIn')}
                </h4>
                {q.isLoading ? (
                  <Skeleton height={40} />
                ) : inView.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    {t('uxOverview.noRoles')}
                  </p>
                ) : (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {inView.map((r) => (
                      <li key={r.key}>
                        <Chip tone="outline" icon={r.mfa_required ? 'lock' : 'user'}>
                          {r.label}
                        </Chip>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            )
          })}
        </div>
      </Card>

      <Card pad={false} labelledBy="ux-table">
        <div className="sf-card__pad" style={{ paddingBottom: 6 }}>
          <h2 id="ux-table" className="sf-card__title">
            {t('uxOverview.tableTitle')}
          </h2>
        </div>
        {q.isLoading ? (
          <div className="sf-card__pad">
            <Skeleton height={160} />
          </div>
        ) : roles.length === 0 ? (
          <EmptyState title={t('uxOverview.emptyTitle')} body={t('uxOverview.emptyBody')} />
        ) : (
          <div className="sf-table-wrap" role="region" aria-label={t('uxOverview.caption')} tabIndex={0}>
            <table className="sf-table" style={{ minWidth: 900 }}>
              <caption className="sr-only">{t('uxOverview.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('uxOverview.col.role')}</th>
                  <th scope="col">{t('uxOverview.col.signIn')}</th>
                  <th scope="col">{t('uxOverview.col.mfa')}</th>
                  <th scope="col">{t('uxOverview.col.withoutGst')}</th>
                  <th scope="col">{t('uxOverview.col.enter')}</th>
                  <th scope="col">{t('uxOverview.col.amber')}</th>
                  <th scope="col">{t('uxOverview.col.label')}</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((r) => (
                  <RoleRow key={r.key} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="k" style={{ margin: 0, padding: '12px 16px', borderTop: '1px solid var(--sf-line)', fontSize: 12.5 }}>
          {t('uxOverview.footnote')} <Link to={routeForFile('LawRules')}>{t('uxOverview.toLaw')}</Link>
        </p>
      </Card>

      <Card title={t('uxOverview.otherTitle')} labelledBy="ux-other">
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, fontSize: 13 }}>
          <li>{t('uxOverview.cash')}</li>
          <li>{t('uxOverview.partners')}</li>
          <li>{t('uxOverview.statements')}</li>
        </ul>
      </Card>
    </>
  )
}

function ViewChip({ view }: { view: string }) {
  const { t } = useTranslation()
  const tone = view === 'all' ? 'teal' : view === 'all-readonly' ? 'navy' : 'info'
  return (
    <Chip tone={tone} icon={view === 'all-readonly' ? 'lock' : 'check'}>
      {t(`views.${view}.chip`)}
    </Chip>
  )
}

function RoleRow({ r }: { r: Role }) {
  const { t } = useTranslation()
  const v = r.view_kind
  const seesAll = v === 'all' || v === 'all-readonly'
  const phoneOnly = r.sign_in === 'phone' && v === 'gst'
  return (
    <tr>
      <th scope="row" style={{ textAlign: 'left', fontWeight: 600, color: 'var(--sf-text)' }}>
        {r.label}
      </th>
      <td>{t(`uxOverview.signIn.${r.sign_in}`, { defaultValue: r.sign_in })}</td>
      <td>{r.mfa_required ? t('uxOverview.mfa.yes') : t('uxOverview.mfa.no')}</td>
      <td>{t(`uxOverview.withoutGst.${v}`, { defaultValue: '—' })}</td>
      <td>{r.key === 'admin' ? t('uxOverview.enter.all') : t('uxOverview.enter.no')}</td>
      <td>
        {seesAll ? (
          <Chip tone="signal" icon="alert">
            {t('uxOverview.amber.shown')}
          </Chip>
        ) : (
          <Chip tone="neutral" icon="ban">
            {t('uxOverview.amber.never')}
          </Chip>
        )}
      </td>
      <td>
        {phoneOnly ? (
          <Chip tone="outline" icon="user">
            {t('uxOverview.phoneApp')}
          </Chip>
        ) : (
          <ViewChip view={v} />
        )}
      </td>
    </tr>
  )
}
