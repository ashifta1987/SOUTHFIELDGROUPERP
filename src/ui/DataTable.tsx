import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Skeleton } from './basics'

export interface Column<Row> {
  key: string
  header: ReactNode
  /** Right-aligned mono amounts */
  align?: 'left' | 'right'
  render: (row: Row) => ReactNode
  width?: number | string
}

/**
 * Register table (§UX-6). Paging, sorting, filtering and totals are done on the server for the user's view;
 * the table only renders what arrives. States: loading (skeleton rows), empty (why + next action), error.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  error,
  onRowClick,
  caption,
  footer,
  minWidth = 620,
  rowTone,
}: {
  columns: Column<Row>[]
  rows: Row[] | undefined
  rowKey: (row: Row) => string
  loading?: boolean
  empty?: ReactNode
  error?: ReactNode
  onRowClick?: (row: Row) => void
  caption: string
  footer?: ReactNode
  minWidth?: number
  /** Optional row tint, e.g. bills without GST in the Admin view */
  rowTone?: (row: Row) => 'signal' | undefined
}) {
  const { t } = useTranslation()
  const colSpan = columns.length
  return (
    <div className="sf-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="sf-table" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === 'right' ? 'r' : undefined} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-busy={loading || undefined}>
          {loading ? (
            Array.from({ length: 4 }, (_, i) => (
              <tr key={`sk-${i}`}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <Skeleton width={c.align === 'right' ? 60 : '70%'} />
                  </td>
                ))}
              </tr>
            ))
          ) : error ? (
            <tr className="sf-table__state">
              <td colSpan={colSpan}>{error}</td>
            </tr>
          ) : !rows || rows.length === 0 ? (
            <tr className="sf-table__state">
              <td colSpan={colSpan}>{empty ?? t('common.nothingYet')}</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                data-clickable={onRowClick ? 'true' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={rowTone?.(row) === 'signal' ? { background: 'color-mix(in srgb, var(--sf-signal-tint) 45%, var(--sf-surface))' } : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'r' : undefined}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  )
}
