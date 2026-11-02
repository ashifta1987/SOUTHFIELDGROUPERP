import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, Skeleton } from '@/ui'
import { asObj, diffFields, OP_CHIP, recordName, show } from './logShared'

type Version = ViewRow<'transaction_log'>
/**
 * HistoryDiff: every version of one record (same table_name + row_pk) from api.transaction_log, newest first.
 * Each version shows only the fields that changed (before → after, tinted); unchanged fields are collapsed.
 */
export function HistoryDiff({ tableName, rowPk, onClose }: { tableName: string; rowPk: string; onClose: () => void }) {
  const { t } = useTranslation()
  const q = useApiView('transaction_log', { eq: { table_name: tableName, row_pk: rowPk }, order: 'id', ascending: true, limit: 200 })
  const versions = rowsOf(q)
  const latest = versions[versions.length - 1]
  const name = latest ? recordName(latest) : rowPk
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    anchor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [tableName, rowPk])

  return (
    <div ref={anchor} style={{ scrollMarginTop: 16 }}>
    <Card labelledBy="history-title" style={{ borderTop: '3px solid var(--sf-primary)' }}>
      <div className="sf-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="k">{t('transactionLog.history.title')}</span>
        <span className="sf-row" style={{ gap: 10 }}>
          <span className="mono k">{t('transactionLog.history.versions', { count: versions.length })}</span>
          <Button size="sm" onClick={onClose}>
            {t('transactionLog.history.close')}
          </Button>
        </span>
      </div>
      <h2 id="history-title" className="sf-card__title" style={{ margin: '6px 0 12px', fontSize: 17 }}>
        <span className="mono">{name}</span> · <span className="mono">{tableName}</span>
      </h2>

      {q.isLoading ? (
        <Skeleton height={120} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 12 }}>
          {versions
            .map((v, i) => ({ v, n: i + 1 }))
            .reverse()
            .map(({ v, n }) => (
              <VersionCard key={v.id} v={v} n={n} />
            ))}
        </div>
      )}
      <p className="k" style={{ margin: '12px 0 0', fontSize: 12.5 }}>
        {t('transactionLog.history.sealNote')}
      </p>
    </Card>
    </div>
  )
}

function VersionCard({ v, n }: { v: Version; n: number }) {
  const { t } = useTranslation()
  const { changed, unchanged } = diffFields(v.before, v.after)
  const b = asObj(v.before)
  const a = asObj(v.after)
  const chip = OP_CHIP[v.op] ?? OP_CHIP.UPDATE
  return (
    <article className="sf-card" style={{ padding: '12px 14px' }} aria-labelledby={`ver-${v.id}`}>
      <div className="sf-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 id={`ver-${v.id}`} style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t('transactionLog.history.version', { n, op: t(`transactionLog.ops.${v.op}`, { defaultValue: v.op }) })}
        </h3>
        <span className="mono k" style={{ fontSize: 12 }}>
          {formatDate(v.at)} {formatTime(v.at)}
        </span>
      </div>
      <div className="sf-row" style={{ gap: 8, margin: '4px 0 8px', fontSize: 12.5 }}>
        <span className="k">{t('transactionLog.history.by', { who: v.actor_name ?? t('transactionLog.system') })}</span>
        {chip ? (
          <Chip tone={chip.tone} icon={chip.icon}>
            {t(`transactionLog.ops.${v.op}`, { defaultValue: v.op })}
          </Chip>
        ) : null}
        {v.grant_code ? (
          <Chip tone="navy" icon="clock">
            {t('transactionLog.underGrant', { code: v.grant_code })}
          </Chip>
        ) : null}
      </div>
      {changed.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t('transactionLog.history.noChange')}
        </p>
      ) : (
        <div className="sf-table-wrap">
          <table className="sf-table">
            <caption className="sr-only">{t('transactionLog.history.changedCaption', { n })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('transactionLog.history.field')}</th>
                <th scope="col">{t('transactionLog.history.before')}</th>
                <th scope="col">{t('transactionLog.history.after')}</th>
              </tr>
            </thead>
            <tbody>
              {changed.map((k) => (
                <tr key={k} data-changed="true" style={v.op === 'UPDATE' ? { background: 'color-mix(in srgb, var(--sf-signal-tint) 45%, var(--sf-surface))' } : undefined}>
                  <th scope="row" style={{ fontWeight: 600, textAlign: 'left' }}>
                    {k.replace(/_/g, ' ')}
                  </th>
                  <td className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {k in b && v.op !== 'INSERT' ? (
                      <del style={{ color: 'var(--sf-danger-ink)' }}>{show(b[k]) || t('transactionLog.history.empty')}</del>
                    ) : (
                      <span className="muted">{t('transactionLog.history.empty')}</span>
                    )}
                  </td>
                  <td className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {k in a && v.op !== 'DELETE' ? (
                      <ins style={{ color: 'var(--sf-success-ink)', textDecoration: 'none' }}>{show(a[k]) || t('transactionLog.history.empty')}</ins>
                    ) : (
                      <span className="muted">{t('transactionLog.history.empty')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unchanged.length > 0 ? (
        <details style={{ marginTop: 8, fontSize: 12.5 }}>
          <summary className="k" style={{ cursor: 'pointer', minHeight: 24 }}>
            {t('transactionLog.history.unchanged', { count: unchanged.length })}
          </summary>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, auto) 1fr', gap: '3px 12px', margin: '6px 0 0' }}>
            {unchanged.map((k) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt className="muted">{k.replace(/_/g, ' ')}</dt>
                <dd className="mono" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                  {show(a[k] ?? b[k]) || t('transactionLog.history.empty')}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </article>
  )
}
