import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, ComingInPhase, Icon } from '@/ui'

/**
 * Southfield Help panel (§HELP-3). Desktop: 400 px right panel; phone/tablet: full screen.
 * Phase 0 ships the panel and its entry points; the assistant itself (help-agent Edge Function) arrives in Phase 3.
 */
export function HelpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <aside className="sf-help" role="dialog" aria-modal="false" aria-labelledby="sf-help-title">
      <div className="sf-help__head">
        <h2 id="sf-help-title">{t('help.title')}</h2>
        <button ref={closeRef} type="button" className="sf-topbar__btn sf-topbar__icon" aria-label={t('common.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="sf-help__body">
        <p style={{ margin: 0, color: 'var(--sf-text-2)' }}>{t('help.intro')}</p>
        <div className="sf-row">
          {(['chipWhy', 'chipHow', 'chipError'] as const).map((k) => (
            <Button key={k} size="sm" comingInPhase={3}>
              {t(`help.${k}`)}
            </Button>
          ))}
        </div>
        <ComingInPhase phase={3}>{t('help.phase')}</ComingInPhase>
      </div>
    </aside>
  )
}

