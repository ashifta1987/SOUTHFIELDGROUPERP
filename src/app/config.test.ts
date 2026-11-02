import { describe, expect, it } from 'vitest'
import { FLOWS, flowForScreen } from './flows'
import { NAV, findNavForPath } from './nav'
import { SCREEN_BY_FILE, SCREENS } from './screens'

describe('screens, flows and nav', () => {
  it('covers every routable screen in the inventory', () => {
    expect(SCREENS.length).toBe(126)
    expect(new Set(SCREENS.map((s) => s.route)).size).toBe(SCREENS.length)
  })
  it('has the 17 workflows and every step points at a known screen', () => {
    expect(FLOWS).toHaveLength(17)
    for (const f of FLOWS) for (const s of f.steps) expect(SCREEN_BY_FILE[s.file], `${f.key}:${s.file}`).toBeDefined()
  })
  it('keeps the sidebar group order from §UX-4.1', () => {
    expect(NAV.map((g) => g.key)).toEqual(['home', 'sales', 'purchase', 'production', 'inventory', 'logistics', 'exports', 'hr', 'accounts', 'admin'])
    expect(NAV.find((g) => g.key === 'sales')!.items).toHaveLength(13)
    expect(NAV.find((g) => g.key === 'admin')!.items).toHaveLength(20)
  })
  it('uses the explicit main flows', () => {
    expect(flowForScreen('Invoice')?.flow.key).toBe('sales')
    expect(flowForScreen('Main')?.flow.key).toBe('home')
    expect(flowForScreen('Customers')?.flow.key).toBe('sales')
    expect(flowForScreen('StaffHome')).toBeNull()
  })
  it('highlights the parent item for second views', () => {
    expect(findNavForPath('/sales/customers/customer-kyc').item?.key).toBe('customers')
  })
})
