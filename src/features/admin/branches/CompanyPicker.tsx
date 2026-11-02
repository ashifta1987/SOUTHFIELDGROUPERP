import { useTranslation } from 'react-i18next'
import { SelectField, Tabs } from '@/ui'
import type { CompanyRow } from './company'

/** Up to this many companies are shown as segmented tabs; more become a select (keeps the bar readable). */
const MAX_TABS = 4

/** Segmented tabs for a few companies, a labelled select for many. Renders nothing for a single company. */
export function CompanyPicker({ list, value, onChange, panelId }: { list: CompanyRow[]; value: string | undefined; onChange: (id: string) => void; panelId?: string }) {
  const { t } = useTranslation()
  if (list.length < 2 || !value) return null
  if (list.length > MAX_TABS) {
    return (
      <div style={{ maxWidth: 420 }}>
        <SelectField label={t('common.company')} value={value} onChange={(e) => onChange(e.target.value)} options={list.map((c) => ({ value: c.id, label: `${c.code} · ${c.short_name || c.name}` }))} />
      </div>
    )
  }
  return (
    <div style={{ display: 'flex' }}>
      <Tabs variant="segmented" label={t('common.company')} value={value} onChange={onChange} controls={panelId} tabs={list.map((c) => ({ key: c.id, label: c.short_name || c.name }))} />
    </div>
  )
}

