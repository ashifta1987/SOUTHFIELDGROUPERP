import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import ml from './locales/ml.json'
import hi from './locales/hi.json'
import bho from './locales/bho.json'
import { NAV } from '@/app/nav'

type Tree = { [k: string]: string | boolean | Tree }

function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => {
    if (k === '_meta') return []
    const path = prefix ? `${prefix}.${k}` : k
    return typeof v === 'object' ? keys(v as Tree, path) : [path]
  })
}

const enKeys = new Set(keys(en as Tree))

describe('i18n locales', () => {
  it('every translated key exists in English (no orphan keys)', () => {
    for (const [name, loc] of Object.entries({ ml, hi, bho })) {
      const orphans = keys(loc as Tree).filter((k) => !enKeys.has(k))
      expect(orphans, `${name} has keys missing from en`).toEqual([])
    }
  })
  it('machine-drafted locales are flagged for native review', () => {
    for (const loc of [ml, hi, bho]) expect(loc._meta['needs-native-review']).toBe(true)
  })
  it('every sidebar label has an English string', () => {
    for (const g of NAV) {
      expect(enKeys.has(g.labelKey), g.labelKey).toBe(true)
      for (const i of g.items) expect(enKeys.has(i.labelKey), i.labelKey).toBe(true)
    }
  })
  it('placeholders match between languages', () => {
    const ph = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',')
    const get = (tree: Tree, path: string) => path.split('.').reduce<unknown>((t, k) => (t as Tree | undefined)?.[k], tree)
    for (const loc of [ml, hi, bho]) {
      for (const k of keys(loc as Tree)) {
        expect(ph(String(get(loc as Tree, k))), k).toBe(ph(String(get(en as Tree, k))))
      }
    }
  })
})
