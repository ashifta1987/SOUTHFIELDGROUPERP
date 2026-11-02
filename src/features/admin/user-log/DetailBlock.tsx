import type { Json } from '@/shared/database.types'
import { humanKey, readable } from './detail'

/** The detail of a user log entry as "key: value" pairs in mono (the server keeps secrets out of it). */
export function DetailBlock({ detail }: { detail: Json }) {
  const entries = detail && typeof detail === 'object' && !Array.isArray(detail) ? Object.entries(detail) : []
  if (entries.length === 0) {
    if (detail === null || (typeof detail === 'object' && entries.length === 0)) return <span className="muted">—</span>
    return <span>{readable(detail)}</span>
  }
  return (
    <div
      className="mono"
      style={{
        fontSize: 12,
        background: 'var(--sf-row-group)',
        border: '1px solid var(--sf-line)',
        borderRadius: 'var(--sf-radius-input)',
        padding: '5px 8px',
        overflowWrap: 'anywhere',
      }}
    >
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 ? ' · ' : ''}
          <span className="muted">{humanKey(k)}:</span> {readable(v)}
        </span>
      ))}
    </div>
  )
}
