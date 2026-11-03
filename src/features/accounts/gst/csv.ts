/**
 * CSV download built in the browser from rows the server already returned (no figure is worked out here).
 * Values are written as the server sent them; text is quoted when it holds a comma, quote or line break.
 */
export type CsvCell = string | number | boolean | null | undefined

function cell(v: CsvCell): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(sections: { title: string; header: string[]; rows: CsvCell[][] }[]): string {
  const out: string[] = []
  for (const s of sections) {
    out.push(cell(s.title))
    out.push(s.header.map(cell).join(','))
    for (const r of s.rows) out.push(r.map(cell).join(','))
    out.push('')
  }
  return out.join('\r\n')
}

export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** First and last day of a YYYY-MM month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}
