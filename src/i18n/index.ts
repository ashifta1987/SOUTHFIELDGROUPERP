import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import en from './locales/en.json'
import ml from './locales/ml.json'
import hi from './locales/hi.json'
import bho from './locales/bho.json'

/**
 * i18next with en, ml, hi, bho (§UX-9). Machine-drafted locales carry `_meta.needs-native-review`.
 * Missing keys fall back (bho → hi → en; ml/hi → en). IDs, numbers and amounts stay in digits in every language.
 */
export const LANGUAGES = [
  { code: 'en', short: 'EN', name: 'English' },
  { code: 'ml', short: 'മല', name: 'മലയാളം' },
  { code: 'hi', short: 'हि', name: 'हिन्दी' },
  { code: 'bho', short: 'भोज', name: 'भोजपुरी' },
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, ml: { translation: ml }, hi: { translation: hi }, bho: { translation: bho } },
    supportedLngs: LANGUAGES.map((l) => l.code),
    fallbackLng: { bho: ['hi', 'en'], default: ['en'] },
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage'], lookupLocalStorage: 'sf.lang', caches: ['localStorage'] },
    returnNull: false,
  })

function applyHtmlLang(code: string) {
  document.documentElement.lang = code === 'bho' ? 'bho' : code
}
applyHtmlLang(i18n.resolvedLanguage ?? 'en')
i18n.on('languageChanged', applyHtmlLang)

export function setLanguage(code: LanguageCode) {
  void i18n.changeLanguage(code)
}

export default i18n
