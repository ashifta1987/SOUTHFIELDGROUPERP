import { describe, expect, it } from 'vitest'
import { financialYear, formatDate, formatIndian, initials, isNegative, maskTail } from './format'

describe('formatIndian', () => {
  it('groups lakhs and crores', () => {
    expect(formatIndian('1234567.5')).toBe('12,34,567.50')
    expect(formatIndian('123456789.00')).toBe('12,34,56,789.00')
    expect(formatIndian('999')).toBe('999.00')
    expect(formatIndian('1000')).toBe('1,000.00')
    expect(formatIndian('100000')).toBe('1,00,000.00')
  })
  it('uses a minus sign, never brackets', () => {
    expect(formatIndian('-250000')).toBe('−2,50,000.00')
    expect(formatIndian('-0.00')).toBe('0.00')
  })
  it('keeps decimal strings exact (no float rounding)', () => {
    expect(formatIndian('9007199254740993.25')).toBe('9,00,71,99,25,47,40,993.25')
  })
  it('supports quantities with 3 decimals', () => {
    expect(formatIndian('1500.5', 3)).toBe('1,500.500')
  })
  it('passes non-numeric input through', () => {
    expect(formatIndian('n/a')).toBe('n/a')
  })
})

describe('isNegative', () => {
  it('detects negatives but not negative zero', () => {
    expect(isNegative('-1.00')).toBe(true)
    expect(isNegative('-0.00')).toBe(false)
    expect(isNegative('5')).toBe(false)
  })
})

describe('dates', () => {
  it('formats DD-MM-YYYY in IST', () => {
    expect(formatDate('2026-11-03')).toBe('03-11-2026')
    // 20:00 UTC on 2-Nov is 01:30 IST on 3-Nov
    expect(formatDate('2026-11-02T20:00:00Z')).toBe('03-11-2026')
  })
  it('computes the April–March financial year in IST', () => {
    expect(financialYear(new Date('2026-11-03T00:00:00+05:30'))).toBe('2026-27')
    expect(financialYear(new Date('2027-03-31T23:00:00+05:30'))).toBe('2026-27')
    expect(financialYear(new Date('2027-04-01T00:30:00+05:30'))).toBe('2027-28')
  })
})

describe('initials and masking', () => {
  it('builds initials', () => {
    expect(initials('Test Admin')).toBe('TA')
    expect(initials('Owner')).toBe('OW')
  })
  it('masks to the last four digits', () => {
    expect(maskTail('50100012347777')).toBe('••7777')
  })
})
