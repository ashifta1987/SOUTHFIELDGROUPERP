import { test, expect } from '@playwright/test'

/**
 * Phase 9: security headers on the deployed app (vercel.json). Runs only against a deployed URL
 * (E2E_BASE_URL=https://…vercel.app or the production domain); the Vite dev server does not apply vercel.json.
 * Also loads the sign-in screen and fails on any CSP violation reported by the browser.
 */
const base = process.env.E2E_BASE_URL ?? ''
const deployed = /^https:\/\//.test(base)

test.describe('phase 9 security headers', () => {
  test.skip(!deployed, 'needs E2E_BASE_URL pointing at a deployed https URL')

  test('every page answer carries the security headers', async ({ request }) => {
    for (const path of ['/', '/sign-in', '/staff/sign-in', '/investor/sign-in']) {
      const res = await request.get(path)
      expect(res.status(), path).toBeLessThan(400)
      const h = res.headers()
      expect(h['strict-transport-security'], path).toMatch(/max-age=\d{7,}/)
      expect(h['x-content-type-options'], path).toBe('nosniff')
      expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin')
      expect(h['x-frame-options'], path).toBe('DENY')
      const pp = h['permissions-policy'] ?? ''
      expect(pp, path).toContain('geolocation=(self)')
      expect(pp, path).toContain('camera=(self)')
      expect(pp, path).toContain('payment=()')
      const csp = h['content-security-policy'] ?? ''
      expect(csp, path).toContain("default-src 'self'")
      expect(csp, path).toContain("script-src 'self'")
      expect(csp, path).not.toContain('unsafe-eval')
      expect(csp, path).toContain("frame-ancestors 'none'")
      expect(csp, path).toContain("object-src 'none'")
      expect(csp, path).toMatch(/connect-src [^;]*https:\/\/[a-z0-9]+\.supabase\.co/)
      expect(csp, path).toMatch(/connect-src [^;]*wss:\/\/[a-z0-9]+\.supabase\.co/)
    }
  })

  test('the sign-in screen loads with no CSP violation', async ({ page }) => {
    const violations: string[] = []
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to (load|apply|execute|connect)/i.test(m.text())) violations.push(m.text())
    })
    await page.goto('/sign-in')
    await expect(page.getByRole('button', { name: /sign in/i }).first()).toBeVisible()
    // Fonts and the Supabase client are fetched on load; give them a moment.
    await page.waitForLoadState('networkidle')
    expect(violations).toEqual([])
  })
})
