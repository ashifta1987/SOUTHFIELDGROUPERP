/** Layout of the Total workflow page (ERPFlow reference) and the hand-offs from docs/design/WORKFLOWS.md. */

/** The main line, in the order of the reference; the rest support every step. */
export const MAIN_LINE = ['purchase', 'warehouse', 'stock', 'bio', 'plastics', 'export', 'sales', 'field', 'credit', 'delivery', 'money', 'books', 'partners'] as const
export const SUPPORTING = ['home', 'staff', 'setup', 'control'] as const

/** Hand-offs between workflows (WORKFLOWS.md table); the text is `erpFlow.handoffs.<id>`. */
export const HANDOFFS: { id: string; from: string; to: string }[] = [
  { id: 'h1', from: 'field', to: 'credit' },
  { id: 'h2', from: 'credit', to: 'delivery' },
  { id: 'h3', from: 'purchase', to: 'warehouse' },
  { id: 'h4', from: 'warehouse', to: 'bio' },
  { id: 'h5', from: 'bio', to: 'warehouse' },
  { id: 'h6', from: 'warehouse', to: 'delivery' },
  { id: 'h7', from: 'purchase', to: 'stock' },
  { id: 'h8', from: 'stock', to: 'bio' },
  { id: 'h9', from: 'stock', to: 'plastics' },
  { id: 'h10', from: 'plastics', to: 'bio' },
  { id: 'h11', from: 'bio', to: 'sales' },
  { id: 'h12', from: 'plastics', to: 'export' },
  { id: 'h13', from: 'sales', to: 'delivery' },
  { id: 'h14', from: 'stock', to: 'field' },
  { id: 'h15', from: 'field', to: 'money' },
  { id: 'h16', from: 'sales', to: 'money' },
  { id: 'h17', from: 'staff', to: 'money' },
  { id: 'h18', from: 'money', to: 'books' },
  { id: 'h19', from: 'books', to: 'partners' },
  { id: 'h20', from: 'control', to: 'books' },
]
