import type { CSSProperties, ReactNode } from 'react'
import { Card } from '@/ui'

/** Two cards side by side that fill the row (sf-grid-2 sizes cards to their content). */
export const TWO_COLS: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, alignItems: 'start', marginBottom: 16 }

/** A card whose body is a full-bleed table: the title row keeps the card padding, the table runs edge to edge. */
export function TableCard({ title, action, children, style }: { title: ReactNode; action?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <Card pad={false} style={style}>
      <div className="sf-card__head sf-card__pad" style={{ alignItems: 'center', paddingBottom: 8 }}>
        <h2 className="sf-card__title">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  )
}
