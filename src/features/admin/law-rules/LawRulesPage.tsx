import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { Card, Chip, EmptyState, PageHeader, SelectField, Skeleton } from '@/ui'
import { STATUS_CHIP, STATUSES } from './status'

type Rule = ViewRow<'law_rules'>

/**
 * Built to Indian law (`LawRules`): the rules from api.law_rules grouped by area, with where each is enforced,
 * its test and its status (built / planned / needs CA). Filtering by status happens on the server.
 */
export function LawRulesPage() {
  const { t } = useTranslation()
  const [status, setStatus] = useState('')
  const q = useApiView('law_rules', { order: 'sort', eq: { status } })
  const rules = rowsOf(q)
  const notReady = q.data?.status === 'not-ready'

  // Group rows by area, keeping the server's sort order.
  const groups: { area: string; rows: Rule[] }[] = []
  for (const r of rules) {
    const g = groups.find((x) => x.area === r.area)
    if (g) g.rows.push(r)
    else groups.push({ area: r.area, rows: [r] })
  }

  return (
    <>
      <PageHeader title={t('lawRules.title')} subtitle={t('lawRules.subtitle')} />

      <Card style={{ borderLeft: '4px solid var(--sf-primary)' }}>
        <h2 className="sf-card__title" style={{ margin: 0 }}>
          {t('lawRules.viewTitle')}
        </h2>
        <p style={{ margin: '6px 0 0', fontSize: 13 }}>{t('lawRules.viewBody')}</p>
      </Card>

      <Card pad={false}>
        <div className="sf-card__pad sf-row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', paddingBottom: 10 }}>
          <h2 className="sf-card__title" style={{ margin: 0 }}>
            {t('lawRules.count', { count: rules.length })}
          </h2>
          <div style={{ minWidth: 220 }}>
            <SelectField
              label={t('lawRules.filter')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder={t('lawRules.allStatuses')}
              options={STATUSES.map((s) => ({ value: s, label: t(`lawRules.status.${s}`) }))}
            />
          </div>
        </div>

        {q.isLoading ? (
          <div className="sf-card__pad">
            <Skeleton height={160} />
          </div>
        ) : q.isError ? (
          <div className="sf-card__pad">
            <p>
              {t('errors.loadFailed')} {t('errors.tryAgain')}
            </p>
          </div>
        ) : rules.length === 0 ? (
          <EmptyState title={t('lawRules.emptyTitle')} body={notReady ? t('lawRules.emptyNotReady') : t('lawRules.emptyBody')} />
        ) : (
          <div className="sf-table-wrap" role="region" aria-label={t('lawRules.caption')} tabIndex={0}>
            <table className="sf-table" style={{ minWidth: 980 }}>
              <caption className="sr-only">{t('lawRules.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('lawRules.col.rule')}</th>
                  <th scope="col">{t('lawRules.col.does')}</th>
                  <th scope="col">{t('lawRules.col.where')}</th>
                  <th scope="col">{t('lawRules.col.test')}</th>
                  <th scope="col">{t('lawRules.col.phase')}</th>
                  <th scope="col">{t('lawRules.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.area}>
                    <tr>
                      <th scope="colgroup" colSpan={6} style={{ background: 'var(--sf-row-group)', textAlign: 'left', fontWeight: 600, color: 'var(--sf-text)' }}>
                        {g.area}
                      </th>
                    </tr>
                    {g.rows.map((r) => {
                      const s = STATUS_CHIP[r.status] ?? STATUS_CHIP.planned
                      return (
                        <tr key={r.code}>
                          <td style={{ maxWidth: 320 }}>
                            <span className="mono k" style={{ fontSize: 11.5 }}>
                              {r.code}
                            </span>
                            <div>{r.rule}</div>
                          </td>
                          <td style={{ maxWidth: 300 }}>{r.what_erp_does}</td>
                          <td className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', maxWidth: 220 }}>
                            {r.enforced_in}
                          </td>
                          <td className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', maxWidth: 200 }}>
                            {r.test_ref ?? <span className="muted" style={{ fontFamily: 'var(--sf-font)' }}>{t('lawRules.noTest')}</span>}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>{t('lawRules.phaseN', { n: r.phase })}</td>
                          <td>
                            {s ? (
                              <Chip tone={s.tone} icon={s.icon}>
                                {t(`lawRules.status.${r.status}`, { defaultValue: r.status })}
                              </Chip>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="k" style={{ margin: 0, padding: '12px 16px', borderTop: '1px solid var(--sf-line)', fontSize: 12.5 }}>
          {t('lawRules.footnote')}
        </p>
      </Card>
    </>
  )
}
