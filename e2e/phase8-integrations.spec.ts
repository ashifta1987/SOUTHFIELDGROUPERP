import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { todayIst } from './phase4-setup'
import { createPhase6Company } from './phase6-setup'

/**
 * Phase 8 · integrations against the DEV database with the MOCK providers only (no network to any GSP, bank or store):
 * a fresh synthetic company (E2E…) gets the mock e-invoice / e-way providers (company settings, mock allowed on DEV) and
 * e-invoicing switched on for its GSTIN · a B2B invoice made from a dispatch is not final: the panel says IRN pending and
 * printing is refused by the server · "Get IRN" queues the request (DB) and the mock provider returns the IRN — the
 * panel shows it with the QR (DB: active IRN, flagged mock) · on the dispatch board "Get e-way bill" queues the request,
 * the mock returns the number and it lands on the dispatch (DB) · a request that keeps failing is dead-lettered after the
 * maximum attempts with a Bug fixer item (DB), retried from Bug fixer → Integrations and completed (DB: done, item fixed)
 * · axe on each screen. Every value is synthetic.
 */

async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 })
}

interface Final { found: boolean; final: boolean; einvoice_required: boolean; irn?: { irn?: string; status?: string; is_mock?: boolean }; request?: { id: string; status: string } | null }
interface Req { id: string; status: string; attempts: number; bug_id: string | null; company_name: string | null }

test.describe('Phase 8 · integrations (mock providers)', () => {
  test.skip(!hasCreds, 'needs .env.test.local with the admin login')

  test('e-invoice IRN before final · e-way bill on the dispatch · dead letter → Bug fixer → retry', async ({ page }) => {
    test.setTimeout(600_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase6Company(page)
    const api = s.api
    const cid = s.companyId
    const trade = s.customers.trade

    // Mock providers for this synthetic company only, and e-invoicing on for its GSTIN (Admin, with a note).
    for (const [key, value] of [['integrations.provider.einvoice', 'mock'], ['integrations.provider.eway', 'mock'], ['integrations.allow_mock', true]] as const) {
      await api.rpc('set_setting', { p_company_id: cid, p_key: key, p_value: value, p_effective_from: todayIst(), p_note: 'E2E test: mock provider on DEV' })
    }
    await api.rpc('set_einvoice_switch', { p_gstin_id: s.gstinId, p_enabled: true, p_from: todayIst(), p_note: 'E2E test: synthetic CA confirmation' })

    // A B2B order → dispatch → tax invoice (Phase 6 RPCs).
    const order = await api.rpc<{ id: string }>('confirm_sales_order', {
      p_header: { company_id: cid, party_id: trade.id, place_id: s.stores.id, payment: 'cash' },
      p_lines: [{ product_id: s.product.id, qty: 2, rate: 100 }],
    })
    const dispatch = await api.rpc<{ id: string; doc_no: string }>('create_dispatch', { p: { order_id: order.id } })
    const inv = await api.rpc<{ document_id: string; doc_no: string }>('invoice_dispatch', { p_dispatch_id: dispatch.id, p: {} })
    let fin = await api.rpc<Final>('document_final_status', { p_document_id: inv.document_id }, false)
    expect([fin.einvoice_required, fin.final]).toEqual([true, false])

    await test.step('Invoice: IRN pending, print refused, Get IRN, mock provider, QR shown', async () => {
      await page.goto(`/sales/invoices?company=${cid}&doc=${inv.document_id}`)
      await settled(page)
      const panel = page.getByRole('region', { name: 'E-invoice (IRN and QR)' })
      await expect(panel.getByText('IRN pending · not final yet')).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(page)

      await page.getByRole('button', { name: 'Preview and print' }).click()
      await page.getByRole('button', { name: 'Print', exact: true }).click()
      await expect(page.getByRole('alert').filter({ hasText: /needs its IRN first/ }).first()).toBeVisible({ timeout: 20_000 })
      await page.getByRole('button', { name: 'Back to the document' }).click()

      await panel.getByRole('button', { name: 'Get IRN' }).click()
      await expect.poll(async () => (await api.view<Req>('integration_requests', `ref_id=eq.${inv.document_id}&kind=eq.einvoice_generate&select=id,status`))[0]?.status, { timeout: 20_000 })
        .toBe('queued')
      await panel.getByRole('button', { name: 'Run with mock provider' }).click()
      await expect(panel.getByText('IRN received · final')).toBeVisible({ timeout: 20_000 })
      await expect(panel.getByRole('img', { name: 'E-invoice QR code' })).toBeVisible()
      await expect(panel.getByText('TEST IRN from the mock provider — not valid for GST')).toBeVisible()
      fin = await api.rpc<Final>('document_final_status', { p_document_id: inv.document_id }, false)
      expect(fin.final).toBe(true)
      expect(fin.irn?.irn ?? '').toMatch(/^[0-9a-f]{64}$/)
      expect([fin.irn?.status, fin.irn?.is_mock]).toEqual(['active', true])
      await expect(panel.getByText(fin.irn?.irn ?? 'missing')).toBeVisible()
      await expectNoSeriousA11y(page)
    })

    await test.step('Dispatch board: Get e-way bill through the mock provider', async () => {
      await page.goto(`/logistics/dispatch-board?company=${cid}`)
      await settled(page)
      const card = page.getByTestId(`dispatch-${dispatch.doc_no}`)
      await card.getByRole('button', { name: 'Get e-way bill' }).click()
      const dlg = page.getByRole('dialog')
      await dlg.getByLabel('Vehicle number').fill('KL 08 AB 1234')
      await dlg.getByLabel('Distance (km)').fill('120')
      await dlg.getByRole('button', { name: 'Ask for the e-way bill' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      await card.getByRole('button', { name: 'Run with mock provider' }).click()
      await expect(card.getByText('E-way bill active')).toBeVisible({ timeout: 20_000 })
      const [c] = await api.view<{ eway_status: string; eway_bill_no: string; eway_vehicle_no: string }>('dispatch_compliance', `dispatch_id=eq.${dispatch.id}&select=eway_status,eway_bill_no,eway_vehicle_no`)
      expect(c?.eway_status).toBe('active')
      expect(c?.eway_bill_no ?? '').toMatch(/^[0-9]{12}$/)
      expect(c?.eway_vehicle_no).toBe('KL08AB1234')
      await expectNoSeriousA11y(page)
    })

    await test.step('Dead letter after repeated failures → Bug fixer → retry → done', async () => {
      // A second B2B invoice whose IRN request keeps failing (mock failure) until it is dead-lettered.
      const o2 = await api.rpc<{ id: string }>('confirm_sales_order', { p_header: { company_id: cid, party_id: trade.id, place_id: s.stores.id, payment: 'cash' }, p_lines: [{ product_id: s.product.id, qty: 1, rate: 100 }] })
      const d2 = await api.rpc<{ id: string }>('create_dispatch', { p: { order_id: o2.id } })
      const inv2 = await api.rpc<{ document_id: string }>('invoice_dispatch', { p_dispatch_id: d2.id, p: {} })
      const rq = await api.rpc<{ request_id: string }>('request_einvoice', { p_document_id: inv2.document_id })
      let last: { status: string } = { status: '' }
      for (let i = 0; i < 10 && last.status !== 'dead'; i++) {
        last = await api.rpc<{ status: string }>('run_mock_integration', { p_request_id: rq.request_id, p: { fail: true, error: 'E2E test: GSP timeout' } })
      }
      expect(last.status).toBe('dead')
      const [dead] = await api.view<Req>('integration_requests', `id=eq.${rq.request_id}&select=id,status,attempts,bug_id,company_name`)
      expect(dead?.bug_id).toBeTruthy()
      const [bug] = await api.view<{ status: string; area: string; kind: string }>('bug_items', `id=eq.${dead?.bug_id}&select=status,area,kind`)
      expect(bug).toEqual({ status: 'open', area: 'integration', kind: 'integration_dead_letter' })

      await page.goto('/admin/bug-fixer')
      await settled(page)
      const card = page.getByRole('region', { name: 'Integrations' })
      const row = card.getByRole('row').filter({ hasText: dead?.company_name ?? 'missing' }).filter({ hasText: 'Gave up' })
      await expect(row).toHaveCount(1, { timeout: 20_000 })
      await expectNoSeriousA11y(page)
      await row.getByRole('button', { name: 'Retry' }).click()
      await expect.poll(async () => (await api.view<Req>('integration_requests', `id=eq.${rq.request_id}&select=status,attempts`))[0], { timeout: 20_000 })
        .toMatchObject({ status: 'queued', attempts: 0 })
      const retryRow = card.getByRole('row').filter({ hasText: dead?.company_name ?? 'missing' }).filter({ hasText: 'Waiting' })
      await retryRow.getByRole('button', { name: 'Run with mock provider' }).click()
      await expect.poll(async () => (await api.view<Req>('integration_requests', `id=eq.${rq.request_id}&select=status`))[0]?.status, { timeout: 20_000 }).toBe('done')
      const [fixed] = await api.view<{ status: string }>('bug_items', `id=eq.${dead?.bug_id}&select=status`)
      expect(fixed?.status).toBe('fixed')
    })
  })
})
