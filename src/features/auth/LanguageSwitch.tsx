import { useTranslation } from 'react-i18next'
import { LANGUAGES, setLanguage } from '@/i18n'

/** EN · മല · हि · भोज language switch (sign-in screens and settings). */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation()
  return (
    <div className="sf-lang" role="group" aria-label={t('common.language')}>
      {LANGUAGES.map((l) => (
        <button key={l.code} type="button" lang={l.code === 'bho' ? 'bho' : l.code} aria-pressed={i18n.resolvedLanguage === l.code} onClick={() => setLanguage(l.code)} title={l.name}>
          {l.short}
        </button>
      ))}
    </div>
  )
}

