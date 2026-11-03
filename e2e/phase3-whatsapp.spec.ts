import { expect, test } from '@playwright/test'
import { expectNoSeriousA11y, hasCreds, creds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { restAsSignedInUser } from './phase3-sales-setup'

/**
 * Phase 3 WhatsApp & email admin against the DEV database: the "sending is off" notice, a test number accepted only
 * for a contact who agreed to WhatsApp (row asserted) and refused for a typed number, removed again; a draft template
 * added (row asserted); every tab passes axe. Synthetic data only ("E2E Test" party, 6xxxxxxxxx test number).
 */
test.describe('Phase 3 · WhatsApp & email', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin adds a consenting test number and a template; typed numbers are refused', async ({ page }) => {
    test.setTimeout(150_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const api = await restAsSignedInUser(page)

    // A synthetic customer whose WhatsApp contact agreed to messages.
    const digits = `6${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
    const partyName = `E2E Test WhatsApp Party ${rand4()}${rand4()}`
    // Its own synthetic company (switched back on if the E2E clean-up switched it off).
    let [company] = await api.view<{ id: string; status: string }>('companies', 'code=eq.E2EWAPP&select=id,status')
    if (!company) {
      const res = await api.rpc<{ id: string }>('upsert_company', { p: { code: 'E2EWAPP', legal_name: 'E2E Test WhatsApp Company', short_name: 'E2E Test WhatsApp', registered_address: 'E2E Test Address, Kerala' } })
      company = { id: res.id, status: 'active' }
    } else if (company.status !== 'active') {
      await api.rpc('upsert_company', { p: { id: company.id, status: 'active' } })
    }
    await api.rpc('upsert_party', {
      p: { company_id: company?.id, legal_name: partyName, is_customer: true, whatsapp: `+91${digits}`, whatsapp_consent: true, contact_name: 'E2E Test Contact', address: 'E2E Test Street', city: 'Thrissur', pincode: '680001', force: true },
    })

    await page.goto('/admin/whatsapp-and-email')
    await expect(page.getByRole('heading', { level: 1, name: 'WhatsApp, SMS and email' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Sending is off' })).toBeVisible()
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
    await expectNoSeriousA11y(page)

    // ── Test numbers ──
    await page.getByRole('tab', { name: 'Test numbers' }).click()
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
    await page.getByLabel('WhatsApp number').fill('6999999999')
    await page.getByLabel('Who it is (note)').fill('E2E Test typed number')
    await page.getByRole('button', { name: 'Add number' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'not a contact who agreed to WhatsApp' })).toBeVisible({ timeout: 15_000 })
    expect(await api.view('msg_allow_list', 'number=eq.%2B916999999999&select=number')).toHaveLength(0)

    await page.getByLabel('WhatsApp number').fill(digits)
    await page.getByLabel('Who it is (note)').fill('E2E Test contact')
    await page.getByRole('button', { name: 'Add number' }).click()
    await expect(page.getByRole('status').filter({ hasText: `Added ••${digits.slice(-4)}` })).toBeVisible({ timeout: 15_000 })
    const [row] = await api.view<{ note: string; belongs_to: string; belongs_to_kind: string }>('msg_allow_list', `number=eq.%2B91${digits}&select=note,belongs_to,belongs_to_kind`)
    expect(row).toEqual({ note: 'E2E Test contact', belongs_to: partyName, belongs_to_kind: 'party' })
    await expect(page.getByRole('row').filter({ hasText: partyName })).toBeVisible()
    await expectNoSeriousA11y(page)

    await page.getByRole('button', { name: `Remove ••${digits.slice(-4)}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()
    await expect.poll(async () => (await api.view('msg_allow_list', `number=eq.%2B91${digits}&select=number`)).length, { timeout: 15_000 }).toBe(0)

    // ── Templates ──
    await page.getByRole('tab', { name: 'Templates' }).click()
    const name = `e2e_test_${rand4()}${rand4()}`.toLowerCase()
    await page.getByRole('button', { name: 'Add template' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add template' })
    await dialog.getByLabel('Template name').fill(name)
    await dialog.getByLabel('Event').fill('sales.e2e_test')
    await dialog.getByLabel('Parameters').fill('customer, doc_no')
    await dialog.getByLabel('Message body').fill('Dear {{1}}, document {{2}} is ready. E2E test.')
    await expect(dialog.getByText('Preview: Dear [customer], document [doc_no] is ready. E2E test.')).toBeVisible()
    await expectNoSeriousA11y(page)
    await dialog.getByRole('button', { name: 'Save template' }).click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    const [tpl] = await api.view<{ approval_status: string; version: number; event: string; params: string[]; category: string }>('msg_templates', `name=eq.${name}&select=approval_status,version,event,params,category`)
    expect(tpl).toEqual({ approval_status: 'draft', version: 1, event: 'sales.e2e_test', params: ['customer', 'doc_no'], category: 'utility' })
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()

    // A staff template with an amount is refused.
    await page.getByRole('button', { name: 'Add template' }).click()
    await dialog.getByLabel('Template name').fill(`${name}_pay`)
    await dialog.getByLabel('Event').fill('hr.e2e_test')
    await dialog.getByLabel('Parameters').fill('net')
    await dialog.getByLabel('Message body').fill('Your pay of ₹{{1}} is ready.')
    await dialog.getByRole('button', { name: 'Save template' }).click()
    await expect(dialog.getByRole('alert').filter({ hasText: 'Staff messages may not carry amounts' })).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // ── The other tabs render and pass axe ──
    for (const tab of ['Outbox', 'Received', 'Numbers per company']) {
      await page.getByRole('tab', { name: tab }).click()
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
      await expectNoSeriousA11y(page)
    }
  })
})
