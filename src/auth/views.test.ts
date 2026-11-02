import { describe, expect, it } from 'vitest'
import type { User } from '@supabase/supabase-js'
import { profileFromUser, viewForRole } from './AuthProvider'

describe('views come from the server-set role', () => {
  it('maps roles to the three views', () => {
    expect(viewForRole('admin')).toBe('all')
    expect(viewForRole('owner')).toBe('all')
    expect(viewForRole('ca')).toBe('all-readonly')
    expect(viewForRole('office_admin')).toBe('gst')
    expect(viewForRole('accountant')).toBe('gst')
    expect(viewForRole('unknown')).toBe('gst')
  })
  it('ignores a role placed in user-editable metadata', () => {
    const user = { id: 'u1', app_metadata: {}, user_metadata: { role: 'admin', full_name: 'Test User' } } as unknown as User
    const p = profileFromUser(user)
    expect(p.view).toBe('gst')
    expect(p.displayName).toBe('Test User')
  })
})
