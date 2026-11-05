import { describe, expect, it } from 'vitest'
import { financialYear, inWindow, parseWindow, planUpgrade, type LegacyLeg } from './dayBookWindow'

// Synthetic data only.
describe('Day Book XML window (--from / --to)', () => {
  const w = parseWindow('2021-04-01', '2022-03-31')
  it('keeps vouchers inside the window, both ends included', () => {
    expect(inWindow('2021-04-01', w)).toBe(true)
    expect(inWindow('2022-03-31', w)).toBe(true)
    expect(inWindow('2021-12-15', w)).toBe(true)
  })
  it('drops vouchers outside the window and vouchers without a date', () => {
    expect(inWindow('2021-03-31', w)).toBe(false)
    expect(inWindow('2022-04-01', w)).toBe(false)
    expect(inWindow(null, w)).toBe(false)
  })
  it('an open end keeps everything on that side', () => {
    expect(inWindow('2001-01-01', parseWindow(undefined, '2022-03-31'))).toBe(true)
    expect(inWindow('2030-01-01', parseWindow('2021-04-01', undefined))).toBe(true)
    expect(inWindow('2030-01-01', parseWindow(undefined, undefined))).toBe(true)
  })
  it('refuses a bad date or a window that ends before it starts', () => {
    expect(() => parseWindow('01-04-2021', undefined)).toThrow('--from')
    expect(() => parseWindow(undefined, '2021-13-40')).toThrow('--to')
    expect(() => parseWindow('2022-04-01', '2021-04-01')).toThrow('after')
  })
  it('names the financial year from April', () => {
    expect(financialYear('2021-04-01')).toBe(2021)
    expect(financialYear('2022-03-31')).toBe(2021)
    expect(financialYear('2022-04-01')).toBe(2022)
  })
})

describe('upgrade of one-leg Excel vouchers by a full-entry XML voucher', () => {
  const leg = (id: string, key: string, over: Partial<LegacyLeg> = {}): LegacyLeg => ({
    id, type: 'Sales', number: 'S-1', date: '2021-04-01', matchKey: key, guid: null, lines: [], state: 'loaded', upgradedInto: null, ...over,
  })
  const xml = { guid: 'g-1', type: 'Sales', number: 'S-1', date: '2021-04-01' }

  it('keeps the first leg and reverses the others, so the voucher is counted once', () => {
    const plan = planUpgrade([leg('b', 'Sales|S-1|2021-04-01|100.00|Test B|cr'), leg('a', 'Sales|S-1|2021-04-01|100.00|Test A|dr')], xml)
    expect(plan.keep).toBe('a') // ordered by key, not by arrival
    expect(plan.reverse).toEqual(['b'])
    expect(planUpgrade([leg('a', 'k1'), leg('b', 'k2'), leg('c', 'k3')], xml)).toEqual({ keep: 'a', reverse: ['b', 'c'] })
  })
  it('matches on type, number and date only', () => {
    expect(planUpgrade([leg('a', 'k1', { type: 'Receipt' })], xml).keep).toBeNull()
    expect(planUpgrade([leg('a', 'k1', { number: 'S-2' })], xml).keep).toBeNull()
    expect(planUpgrade([leg('a', 'k1', { date: '2021-04-02' })], xml).keep).toBeNull()
  })
  it('creates the voucher when there is no Excel leg, and never touches full vouchers, reversed or already upgraded legs', () => {
    expect(planUpgrade([], xml)).toEqual({ keep: null, reverse: [] })
    expect(planUpgrade([leg('a', 'k1', { lines: [{ ledger: 'x', amount: 1 }] })], xml).keep).toBeNull()
    expect(planUpgrade([leg('a', 'k1', { state: 'reversed' })], xml).keep).toBeNull()
    expect(planUpgrade([leg('a', 'k1', { upgradedInto: 'z' })], xml).keep).toBeNull()
  })
  it('loading the same XML voucher again changes nothing', () => {
    expect(planUpgrade([leg('a', 'k1', { guid: 'g-1', lines: [{ ledger: 'x', amount: 1 }] }), leg('b', 'k2', { state: 'reversed', upgradedInto: 'a' })], xml)).toEqual({ keep: null, reverse: [] })
  })
  it('a voucher without a number or a guid is never matched', () => {
    expect(planUpgrade([leg('a', 'k1')], { ...xml, number: '' }).keep).toBeNull()
    expect(planUpgrade([leg('a', 'k1')], { ...xml, guid: '' }).keep).toBeNull()
  })
})
