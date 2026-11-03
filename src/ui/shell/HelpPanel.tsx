import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { LANGUAGES, setLanguage, type LanguageCode } from '@/i18n'
import { HelpContent } from '@/features/help/HelpContent'
import { HELP_EVENT, type HelpRequest } from '@/features/help/events'
import { Icon } from '@/ui'

/**
 * Southfield Help panel (§HELP-3). Desktop: 400 px right panel; phone/tablet: full screen.
 * Opens from the shell's Help button and from a window `sf:help` CustomEvent (detail: { page?, errorCode? }) that any
 * screen or error box may dispatch (see `askHelp` in `@/features/help/events`). v1 searches the help pages, explains
 * the user's own error references and files problem reports; the AI assistant arrives once its provider is chosen.
 */
export function HelpPanel({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen?: () => void }) {
  const { t, i18n } = useTranslation()
  const closeRef = useRef<HTMLButtonElement>(null)
  const onOpenRef = useRef(onOpen)
  const langId = useId()
  const [request, setRequest] = useState<{ seq: number; detail: HelpRequest }>({ seq: 0, detail: {} })

  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])

  useEffect(() => {
    const onHelp = (e: Event) => {
      const detail = (e as CustomEvent<HelpRequest | undefined>).detail ?? {}
      setRequest((r) => ({ seq: r.seq + 1, detail }))
      onOpenRef.current?.()
    }
    window.addEventListener(HELP_EVENT, onHelp)
    return () => window.removeEventListener(HELP_EVENT, onHelp)
  }, [])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, request.seq])

  if (!open) return null
  // Portaled to <body> above open dialogs, so "Ask Help about this" inside a form dialog shows the explanation on top.
  return createPortal(
    <aside className="sf-help" role="dialog" aria-modal="false" aria-labelledby="sf-help-title" style={{ zIndex: 90, pointerEvents: 'auto' }}>
      <div className="sf-help__head">
        <h2 id="sf-help-title">{t('help.title')}</h2>
        <span className="sf-row" style={{ gap: 6 }}>
          <label htmlFor={langId} className="sr-only">
            {t('common.language')}
          </label>
          <select
            id={langId}
            className="sf-input"
            style={{ height: 32, width: 'auto', paddingInline: 8, fontSize: 13 }}
            value={i18n.resolvedLanguage ?? 'en'}
            onChange={(e) => setLanguage(e.target.value as LanguageCode)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
          <button ref={closeRef} type="button" className="sf-topbar__btn sf-topbar__icon" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </span>
      </div>
      <div className="sf-help__body">
        <HelpContent key={request.seq} request={request.detail} />
      </div>
    </aside>,
    document.body,
  )
}
