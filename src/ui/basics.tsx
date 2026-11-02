import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatIndian, isNegative } from '@/shared/format'
import { Icon } from './Icon'

/* ── Card ── */
export function Card({
  title,
  action,
  children,
  pad = true,
  accent,
  className,
  as: Tag = 'section',
  labelledBy,
  style,
}: {
  style?: CSSProperties
  title?: ReactNode
  action?: ReactNode
  children?: ReactNode
  pad?: boolean
  accent?: 'signal'
  className?: string
  as?: 'section' | 'div' | 'article'
  labelledBy?: string
}) {
  return (
    <Tag className={['sf-card', pad ? 'sf-card__pad' : '', className ?? ''].join(' ').trim()} data-accent={accent} aria-labelledby={labelledBy} style={style}>
      {title || action ? (
        <div className="sf-card__head">
          {title ? (
            <h2 className="sf-card__title" id={labelledBy}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      {children}
    </Tag>
  )
}

/* ── PageHeader ── */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="sf-page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="sf-page-header__actions">{actions}</div> : null}
    </div>
  )
}

/* ── Amount: mono, Indian grouping, minus sign + red ink for negatives ── */
export function Amount({
  value,
  rupee = false,
  digits = 2,
  className,
}: {
  /** Decimal string from Postgres numeric (preferred) or a number */
  value: string | number | null | undefined
  rupee?: boolean
  digits?: number
  className?: string
}) {
  if (value === null || value === undefined || value === '') {
    return <span className={['sf-amount', className ?? ''].join(' ')}>—</span>
  }
  const neg = isNegative(value)
  const text = formatIndian(value, digits)
  const out = rupee ? (neg ? `−₹${text.slice(1)}` : `₹${text}`) : text
  return (
    <span className={['sf-amount', className ?? ''].join(' ')} data-negative={neg ? 'true' : undefined}>
      {out}
    </span>
  )
}

/* ── KPI tiles: a row of tiles in one card split by vertical rules ── */
export interface KpiDef {
  key: string
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  href?: string
}

export function KpiTiles({ items, ariaLabel }: { items: KpiDef[]; ariaLabel: string }) {
  return (
    <section className="sf-card sf-kpis" aria-label={ariaLabel}>
      {items.map((k) => {
        const inner = (
          <>
            <span className="k">{k.label}</span>
            <span className="sf-kpi__value">{k.value}</span>
            {k.sub ? <span className="k">{k.sub}</span> : null}
          </>
        )
        return k.href ? (
          <a key={k.key} className="sf-kpi" href={k.href}>
            {inner}
          </a>
        ) : (
          <div key={k.key} className="sf-kpi">
            {inner}
          </div>
        )
      })}
    </section>
  )
}

export function KpiTile(props: KpiDef) {
  return <KpiTiles items={[props]} ariaLabel={typeof props.label === 'string' ? props.label : 'KPI'} />
}

/* ── Skeleton ── */
export function Skeleton({ width = '100%', height = 14 }: { width?: number | string; height?: number }) {
  return <span className="sf-skel" style={{ width, height }} aria-hidden="true" />
}

/* ── Empty state: why it is empty + the next action ── */
export function EmptyState({ title, body, action }: { title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="sf-empty" role="status">
      <strong>{title}</strong>
      {body ? <span>{body}</span> : null}
      {action}
    </div>
  )
}

/* ── ComingInPhase: explains a control that has no backend yet (disabled, never dead) ── */
export function ComingInPhase({ phase, children }: { phase: number; children?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <span className="sf-coming">
      <Icon name="clock" size={14} />
      {children ?? t('common.comingInPhase', { phase })}
    </span>
  )
}

/* ── Locked: read-only / locked period / licence block ── */
export function Locked({ children }: { children: ReactNode }) {
  return (
    <span className="sf-coming">
      <Icon name="lock" size={14} />
      {children}
    </span>
  )
}

/* ── ErrorRef: what happened, what to do, and a reference ID ── */
export function ErrorRef({ message, next, refId, onAskHelp }: { message: ReactNode; next?: ReactNode; refId: string; onAskHelp?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="sf-errorref" role="alert">
      <strong>{message}</strong>
      {next ? <span>{next}</span> : null}
      <span>
        {t('common.reference')} <span className="mono">{refId}</span>
        {onAskHelp ? (
          <>
            {' · '}
            <button type="button" className="sf-btn" data-variant="link" onClick={onAskHelp}>
              {t('common.askHelp')}
            </button>
          </>
        ) : null}
      </span>
    </div>
  )
}

/* ── KeyValue ── */
export function KeyValue({ rows }: { rows: { label: ReactNode; value: ReactNode; total?: boolean }[] }) {
  return (
    <dl style={{ margin: 0 }}>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 0',
            borderTop: i === 0 ? undefined : '1px solid var(--sf-line-faint)',
            fontWeight: r.total ? 700 : undefined,
          }}
        >
          <dt className={r.total ? undefined : 'muted'}>{r.label}</dt>
          <dd className="mono" style={{ margin: 0 }}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/* ── NeedsYouList ── */
export interface NeedsYouItem {
  id: string
  severity: 'high' | 'medium' | 'info'
  title: ReactNode
  body: ReactNode
  linkLabel: ReactNode
  href: string
}

export function NeedsYouList({ items }: { items: NeedsYouItem[] }) {
  return (
    <ul className="sf-needs" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((it) => (
        <li key={it.id} className="sf-needs__item">
          <span className="sf-needs__dot" data-severity={it.severity} aria-hidden="true" />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <strong>{it.title}</strong>
            <span style={{ color: 'var(--sf-text-2)' }}>{it.body}</span>
            <a href={it.href} style={{ fontSize: 12.5, fontWeight: 600 }}>
              {it.linkLabel}
            </a>
          </span>
        </li>
      ))}
    </ul>
  )
}

/* ── BarList: horizontal bars with a with-GST / without-GST split (split shown in the Admin view only) ── */
export interface BarRow {
  key: string
  label: string
  /** decimal strings from the server */
  withGst: string
  withoutGst?: string
  total: string
}

export function BarList({ rows, showSplit }: { rows: BarRow[]; showSplit: boolean }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.total)))
  return (
    <div>
      {rows.map((r) => {
        const a = (Number(r.withGst) / max) * 100
        const b = showSplit && r.withoutGst ? (Number(r.withoutGst) / max) * 100 : 0
        return (
          <div key={r.key} className="sf-bar" tabIndex={0}>
            <span>{r.label}</span>
            <div className="sf-bar__track">
              <div className="sf-bar__seg" style={{ width: `${a}%`, background: 'var(--sf-info)', borderRadius: b ? 0 : '0 4px 4px 0' }} />
              {b ? <div className="sf-bar__seg" style={{ width: `${b}%`, background: 'var(--sf-signal)', borderRadius: '0 4px 4px 0' }} /> : null}
            </div>
            <span className="r">
              <Amount value={r.total} digits={0} />
            </span>
            <span className="sf-bar__tip">
              ₹{formatIndian(r.withGst, 0)}
              {showSplit && r.withoutGst ? ` · ₹${formatIndian(r.withoutGst, 0)}` : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* ── Copyable mono codes: DocNo / Gstin / Code ── */
export function Code({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation()
  return (
    <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {value}
      <button
        type="button"
        aria-label={`${t('common.copy')} ${label ?? value}`}
        onClick={() => void navigator.clipboard?.writeText(value)}
        style={{ border: 0, background: 'transparent', padding: 2, cursor: 'pointer', color: 'var(--sf-text-muted)', display: 'inline-flex' }}
      >
        <Icon name="copy" size={13} />
      </button>
    </span>
  )
}
export const DocNo = Code
export const Gstin = Code
