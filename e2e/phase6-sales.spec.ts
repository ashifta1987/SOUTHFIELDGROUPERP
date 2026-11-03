import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { createPhase6Company, givePeople, todayIst } from './phase6-setup'

/**
 * Phase 6 · sales desk against the DEV database, three people for segregation of duties on a fresh synthetic company for
 * one hour (Admin; the synthetic staff user as sales manager + MD; the synthetic third user as accountant):
 * credit application sent by Admin, Admin's own stage approval refused, stage 3 by the staff user and stage 4 by the third
 * user (DB) · an order over the credit limit is held with the message (DB pending_credit), Admin's own release refused,
 * an MD exception by the staff user and the release by the staff user (DB confirmed) · a complaint puts the batch on QC
 * hold → not sellable (DB hold bucket) → released (DB available) · shop set-up, counter sale and day close (DB) · export
 * order, container with the ISO 6346 check, packing-list check and the LUT invoice by Admin (DB) · online channel and an
 * online order brought in, the same order twice gives the first result (DB) · listing blockers (DB) · axe on every screen.
 */

async function alertWith(page: Page, re: RegExp) {
  await expect(page.getByRole('alert').filter({ hasText: re }).first()).toBeVisible({ timeout: 20_000 })
}
async function statusWith(page: Page, re: RegExp) {
  await expect(page.getByRole('status').filter({ hasText: re }).first()).toBeVisible({ timeout: 20_000 })
}

/** A valid ISO 6346 container number (owner code + 6 digits + check digit). */
function containerNo(owner: string, serial: string): string {
  const map = '0123456789A?BCDEFGHIJK?LMNOPQRSTU?VWXYZ'
  const base = `${owner}${serial}`
  let sum = 0
  for (let i = 0; i < 10; i++) sum += map.indexOf(base[i] ?? '0') * 2 ** i
  return `${base}${(sum % 11) % 10}`
}

function plusDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

test.describe('Phase 6 · sales desk', () => {
  test.skip(!hasCreds || !creds.staff.email || !creds.third.email, 'needs .env.test.local with admin, staff and third logins')

  test('Credit stages by other people → order over limit held, MD exception and release by another → complaint QC hold and release → shop sale and day close → export LUT invoice → online order', async ({ page, browser }) => {
    test.setTimeout(900_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase6Company(page)
    const api = s.api
    const cid = s.companyId
    const tag = s.tag
    const q = `company=${cid}`
    const itemLabel = { label: `${s.product.code} · ${s.product.name}` }
    const trade = s.customers.trade

    const people = await givePeople(s, { staff: ['sales_manager', 'md'], third: ['accountant'] })
    const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const thirdCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const staffPage = await staffCtx.newPage()
    const thirdPage = await thirdCtx.newPage()
    try {
      await signInWithEmail(staffPage, creds.staff)
      await expect(staffPage).not.toHaveURL(/sign-in/, { timeout: 20_000 })
      await signInWithEmail(thirdPage, creds.third)
      await expect(thirdPage).not.toHaveURL(/sign-in/, { timeout: 20_000 })

      // ── 1. Credit application: Admin asks; Admin's own approval refused; stage 3 by staff, stage 4 by third ──
      await page.goto(`/sales/credit-customers?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Credit customers' })).toBeVisible()
      await page.getByRole('button', { name: `Open credit of ${trade.name}` }).click()
      await expect(page.getByTestId('credit-exposure')).toBeVisible({ timeout: 20_000 })
      await page.getByLabel('Limit asked ₹').fill('100000')
      await page.getByRole('button', { name: 'Send credit application' }).click()
      await statusWith(page, /Credit application .* sent/)
      await expectNoSeriousA11y(page)
      type App = { id: string; doc_no: string; stage: number; status: string; requested_by: string }
      let [app] = await api.view<App>('credit_applications', `company_id=eq.${cid}&party_id=eq.${trade.id}&select=id,doc_no,stage,status,requested_by`)
      expect(app?.stage).toBe(3)
      expect(app?.requested_by).toBe(people.adminId)

      await page.getByRole('tab', { name: 'Applications' }).click()
      await page.getByRole('button', { name: `Open application ${app?.doc_no ?? ''}` }).click()
      await page.getByRole('button', { name: 'Approve stage 3' }).click()
      await alertWith(page, /Someone else must approve or release what you asked for/)
      ;[app] = await api.view<App>('credit_applications', `id=eq.${app?.id ?? ''}&select=id,doc_no,stage,status,requested_by`)
      expect(app?.stage).toBe(3)

      await staffPage.goto(`/sales/credit-customers?${q}`)
      await staffPage.getByRole('tab', { name: 'Applications' }).click()
      await staffPage.getByRole('button', { name: `Open application ${app?.doc_no ?? ''}` }).click()
      await staffPage.getByRole('button', { name: 'Approve stage 3' }).click()
      await statusWith(staffPage, /moves to stage 4/)
      await thirdPage.goto(`/sales/credit-customers?${q}`)
      await thirdPage.getByRole('tab', { name: 'Applications' }).click()
      await thirdPage.getByRole('button', { name: `Open application ${app?.doc_no ?? ''}` }).click()
      await thirdPage.getByRole('button', { name: 'Approve stage 4' }).click()
      await statusWith(thirdPage, /moves to stage 5/)
      await expectNoSeriousA11y(thirdPage)
      ;[app] = await api.view<App>('credit_applications', `id=eq.${app?.id ?? ''}&select=id,doc_no,stage,status,requested_by`)
      expect(app?.stage).toBe(5)
      expect(app?.status).toBe('in_progress')
      const approvals = await api.view<{ stage: number; decided_by: string }>('credit_approvals', `application_id=eq.${app?.id ?? ''}&select=stage,decided_by&order=stage`)
      expect(approvals).toEqual([
        { stage: 3, decided_by: people.staffId },
        { stage: 4, decided_by: people.thirdId },
      ])
      // Admin asked for it, so stage 5 is refused for Admin too (nobody decides their own request).
      await page.reload()
      await page.getByRole('tab', { name: 'Applications' }).click()
      await page.getByRole('button', { name: `Open application ${app?.doc_no ?? ''}` }).click()
      await page.getByRole('button', { name: 'Approve stage 5' }).click()
      await alertWith(page, /Someone else must approve or release what you asked for/)

      // ── 2. Order over the credit limit is held; Admin can't release own order; MD exception by staff; staff releases ──
      await page.goto(`/sales/quotations-and-orders?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Quotations and sales orders' })).toBeVisible()
      await page.getByLabel('Customer', { exact: true }).selectOption({ label: trade.name })
      await page.getByLabel('Item 1').selectOption(itemLabel)
      await page.getByLabel('Quantity 1').fill('10')
      await page.getByLabel('Rate ₹ 1').fill('100')
      await expect(page.getByTestId('tax-total')).toContainText('1,180.00', { timeout: 20_000 })
      await expect(page.getByTestId('order-exposure')).toHaveAttribute('data-blocked', 'true', { timeout: 20_000 })
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Confirm order' }).click()
      await alertWith(page, /is held: it takes the customer over the credit limit/)
      type O = { id: string; doc_no: string; status: string; created_by: string; confirmed_by: string | null; total: number }
      let [order] = await api.view<O>('sales_orders', `company_id=eq.${cid}&party_id=eq.${trade.id}&select=id,doc_no,status,created_by,confirmed_by,total`)
      expect(order?.status).toBe('pending_credit')
      expect(Number(order?.total)).toBe(1180)
      await page.getByRole('button', { name: 'Release order' }).click()
      await alertWith(page, /Someone else must approve or release what you asked for/)
      ;[order] = await api.view<O>('sales_orders', `id=eq.${order?.id ?? ''}&select=id,doc_no,status,created_by,confirmed_by,total`)
      expect(order?.status).toBe('pending_credit')

      await staffPage.goto(`/sales/credit-customers?${q}`)
      await staffPage.getByRole('button', { name: `Open credit of ${trade.name}` }).click()
      const md = staffPage.getByTestId('md-exception-form')
      await md.getByLabel('Exception amount ₹').fill('5000')
      await md.getByLabel('Valid until').fill(`${plusDays(2)}T18:00`)
      await md.getByLabel('Reason and compensating checks').fill('E2E test exception: owner vouched for this order')
      await md.getByRole('button', { name: 'Grant MD exception' }).click()
      await statusWith(staffPage, /MD exception recorded/)
      const exc = await api.view<{ granted_by: string; amount: number; active: boolean }>('credit_exceptions', `company_id=eq.${cid}&party_id=eq.${trade.id}&select=granted_by,amount,active`)
      expect(exc).toEqual([{ granted_by: people.staffId, amount: 5000, active: true }])

      await staffPage.goto(`/sales/quotations-and-orders?${q}`)
      await staffPage.getByRole('button', { name: `Open order ${order?.doc_no ?? ''}` }).click()
      await staffPage.getByRole('button', { name: 'Release order' }).click()
      await statusWith(staffPage, /released and confirmed/)
      ;[order] = await api.view<O>('sales_orders', `id=eq.${order?.id ?? ''}&select=id,doc_no,status,created_by,confirmed_by,total`)
      expect(order?.status).toBe('confirmed')
      expect(order?.confirmed_by).toBe(people.staffId)

      // ── 3. Complaint → QC hold on the batch everywhere (not sellable) → released ──
      await page.goto(`/sales/customer-care-and-agents?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Customer care, reminders and agents' })).toBeVisible()
      await page.getByLabel('Customer', { exact: true }).selectOption({ label: trade.name })
      await page.getByLabel('Batch (lot)').selectOption({ label: `${s.lotNo} · ${s.product.code} · ${s.product.name}` })
      await page.getByLabel('What the customer says').fill('E2E test: bars crack in the wrapper')
      await page.getByRole('button', { name: 'Log complaint' }).click()
      await statusWith(page, /Complaint .* logged/)
      await page.getByLabel('Reason for the hold').fill('E2E test: complaint on this batch')
      await page.getByRole('button', { name: 'Hold the batch' }).click()
      await statusWith(page, /Batch on hold everywhere/)
      await expectNoSeriousA11y(page)
      type Lot = { id: string; status: string }
      type Bal = { bucket: string; qty: number; sellable: boolean | null }
      const [lot] = await api.view<Lot>('lots', `company_id=eq.${cid}&lot_no=eq.${s.lotNo}&select=id,status`)
      expect(lot?.status).toBe('hold')
      let bal = await api.view<Bal>('stock_on_hand', `lot_id=eq.${lot?.id ?? ''}&qty=gt.0&select=bucket,qty,sellable`)
      expect(bal.map((b) => b.bucket)).toEqual(['hold'])
      expect(bal.every((b) => !b.sellable)).toBe(true)
      const [cmp] = await api.view<{ status: string; hold_status: string }>('complaints', `company_id=eq.${cid}&select=status,hold_status`)
      expect(cmp).toEqual({ status: 'on_hold', hold_status: 'on_hold' })
      await page.getByLabel('QC finding').fill('E2E test: wrapper issue only, bars fine')
      await page.getByRole('button', { name: 'Release the batch' }).click()
      await statusWith(page, /Batch released/)
      const [lot2] = await api.view<Lot>('lots', `id=eq.${lot?.id ?? ''}&select=id,status`)
      expect(lot2?.status).not.toBe('hold')
      bal = await api.view<Bal>('stock_on_hand', `lot_id=eq.${lot?.id ?? ''}&qty=gt.0&select=bucket,qty,sellable`)
      expect(bal).toEqual([{ bucket: 'available', qty: 200, sellable: true }])

      // ── 4. Own shop: set-up, counter sale, day close ──
      await page.goto(`/sales/own-shops?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Own shops' })).toBeVisible()
      await page.getByRole('tab', { name: 'Set-up' }).click()
      await page.getByLabel('Shop branch').selectOption({ label: `H${tag} · ${s.shopBranch.name}` })
      await page.getByLabel('Stock place').selectOption({ label: `SH${tag} · ${s.shopPlace.name}` })
      await page.getByLabel('Walk-in customer').selectOption({ label: s.customers.walkIn.name })
      await page.getByLabel('Cash account').selectOption({ label: `E2E Test Shop Cash ${tag}` })
      await page.getByRole('button', { name: 'Save shop' }).click()
      await statusWith(page, /Shop saved/)
      const [shop] = await api.view<{ id: string }>('shops', `company_id=eq.${cid}&select=id`)
      expect(shop?.id).toBeTruthy()
      await page.getByRole('tab', { name: 'Counter sale' }).click()
      await page.getByLabel('Item 1').selectOption(itemLabel)
      await page.getByLabel('Quantity 1').fill('2')
      await page.getByLabel('Rate ₹ 1').fill('100')
      await page.getByRole('button', { name: 'Bill', exact: true }).click()
      await statusWith(page, /posted and paid/)
      await expectNoSeriousA11y(page)
      const docs = await api.view<{ status: string; total: number; party_id: string }>('sales_documents', `company_id=eq.${cid}&notes=eq.Counter%20sale&select=status,total,party_id`)
      expect(docs).toEqual([{ status: 'posted', total: 236, party_id: s.customers.walkIn.id }])
      const shelf = await api.view<{ qty: number }>('stock_on_hand', `place_id=eq.${s.shopPlace.id}&bucket=eq.available&select=qty`)
      expect(shelf.map((x) => Number(x.qty))).toEqual([48])
      await page.getByRole('tab', { name: 'Day closing' }).click()
      await page.getByLabel('₹200 × count').fill('1')
      await page.getByLabel('₹20 × count').fill('1')
      await page.getByLabel('₹10 × count').fill('1')
      await page.getByLabel('₹5 × count').fill('1')
      await page.getByLabel('₹1 × count').fill('1')
      await page.getByRole('button', { name: 'Close the day' }).click()
      await statusWith(page, /Day closed: the counted cash matches/)
      await expectNoSeriousA11y(page)
      const days = await api.view<{ status: string; expected_cash: number; counted_cash: number; bills: number }>('shop_days', `shop_id=eq.${shop?.id ?? ''}&select=status,expected_cash,counted_cash,bills`)
      expect(days).toEqual([{ status: 'closed', expected_cash: 236, counted_cash: 236, bills: 1 }])

      // ── 5. Export order → container (ISO 6346) → packing-list check → LUT invoice by Admin ──
      await page.goto(`/exports/export-orders?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Export orders and containers' })).toBeVisible()
      await page.getByLabel('Overseas buyer').selectOption({ label: s.customers.overseas.name })
      await page.getByLabel('Exchange rate (₹ per unit)').fill('83.5')
      await page.getByLabel('LUT reference').fill(`E2E-LUT-${tag}`)
      await page.getByLabel('LUT valid to').fill(plusDays(90))
      await page.getByLabel('Item 1').selectOption(itemLabel)
      await page.getByLabel('Quantity 1').fill('10')
      await page.getByLabel('Rate (foreign currency) 1').fill('2.5')
      await page.getByRole('button', { name: 'Create export order' }).click()
      await statusWith(page, /Export order .* created/)
      const [exp] = await api.view<{ id: string; doc_no: string; status: string }>('export_orders', `company_id=eq.${cid}&select=id,doc_no,status`)
      expect(exp?.status).toBe('confirmed')
      const cno = containerNo('EEEU', String(100000 + (Number(tag.replace(/\D/g, '')) % 900000)).slice(0, 6))
      const wrong = `${cno.slice(0, 10)}${(Number(cno[10]) + 1) % 10}`
      await page.getByLabel('Container number').fill(wrong)
      await page.getByLabel('Item 1').selectOption(itemLabel)
      await page.getByLabel('Cartons 1').fill('1')
      await page.getByLabel('Pieces 1').fill('10')
      await page.getByRole('button', { name: 'Add container' }).click()
      await alertWith(page, /check digit is wrong/)
      await page.getByLabel('Container number').fill(cno)
      await page.getByRole('button', { name: 'Add container' }).click()
      await statusWith(page, new RegExp(`Container ${cno} added`))
      await page.getByRole('button', { name: `Check loading of container ${cno}` }).click()
      const loadBox = page.locator('fieldset').filter({ hasText: 'What was loaded' })
      await loadBox.getByLabel('Item 1').selectOption(itemLabel)
      await loadBox.getByLabel('Cartons 1').fill('1')
      await loadBox.getByLabel('Pieces 1').fill('10')
      await page.getByRole('button', { name: 'Check against the packing list' }).click()
      await statusWith(page, /Loading matches the packing list/)
      const [cont] = await api.view<{ container_no: string; check_status: string }>('containers', `export_order_id=eq.${exp?.id ?? ''}&select=container_no,check_status`)
      expect(cont).toEqual({ container_no: cno, check_status: 'matches' })
      await page.getByLabel('Shipping bill number').fill(`E2E-SB-${tag}`)
      await page.getByRole('button', { name: 'Post export invoice' }).click()
      await statusWith(page, /posted under LUT/)
      await expectNoSeriousA11y(page)
      const [inv] = await api.view<{ document_id: string; lut: boolean; value_fc: number; total_inr: number }>('export_invoices', `export_order_id=eq.${exp?.id ?? ''}&select=document_id,lut,value_fc,total_inr`)
      expect(inv?.lut).toBe(true)
      expect(Number(inv?.value_fc)).toBe(25)
      const [doc] = await api.view<{ tax_class: string; lawful_reason: string; igst: number; status: string; place_of_supply: string }>('sales_documents', `id=eq.${inv?.document_id ?? ''}&select=tax_class,lawful_reason,igst,status,place_of_supply`)
      expect(doc).toEqual({ tax_class: 'without_gst', lawful_reason: 'export_lut', igst: 0, status: 'posted', place_of_supply: '96' })

      // ── 6. Online channel + an online order brought in (and the same order again gives the first result) ──
      await page.goto(`/sales/online-channels?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Online channels' })).toBeVisible()
      await page.getByLabel('Sells from GSTIN').selectOption({ label: s.gstin })
      await page.getByLabel('Marketplace buyer account').selectOption({ label: s.customers.marketplace.name })
      await page.getByLabel('Ships from (stock place)').selectOption({ label: `${s.stores.name} · E2E Test Factory ${tag}` })
      await page.getByRole('button', { name: 'Save channel' }).click()
      await statusWith(page, /Channel saved/)
      const ext = `E2E-ORD-${tag}`
      const ingestCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Enter an online order' }) })
      await ingestCard.getByLabel('Channel', { exact: true }).selectOption({ label: 'Shopify (own website)' })
      await ingestCard.getByLabel('Channel order number').fill(ext)
      await ingestCard.getByLabel('Ship-to state code').fill('32')
      await ingestCard.getByLabel('Item 1').selectOption(itemLabel)
      await ingestCard.getByLabel('Quantity 1').fill('1')
      await ingestCard.getByLabel('Price incl. GST ₹ 1').fill('236')
      await ingestCard.getByRole('button', { name: 'Bring in order' }).click()
      await statusWith(page, /brought in as sales order/)
      await expectNoSeriousA11y(page)
      const online = await api.view<{ order_id: string; external_order_id: string }>('online_orders', `company_id=eq.${cid}&select=order_id,external_order_id`)
      expect(online.length).toBe(1)
      expect(online[0]?.external_order_id).toBe(ext)
      const [oo] = await api.view<{ channel: string; payment: string; status: string; total: number }>('sales_orders', `id=eq.${online[0]?.order_id ?? ''}&select=channel,payment,status,total`)
      expect(oo).toEqual({ channel: 'online', payment: 'advance', status: 'confirmed', total: 236 })
      await ingestCard.getByLabel('Item 1').selectOption(itemLabel)
      await ingestCard.getByLabel('Quantity 1').fill('1')
      await ingestCard.getByLabel('Price incl. GST ₹ 1').fill('236')
      await ingestCard.getByRole('button', { name: 'Bring in order' }).click()
      await statusWith(page, /already brought in/)
      expect((await api.view('online_orders', `company_id=eq.${cid}&select=id`)).length).toBe(1)

      // ── 7. Listing: the server lists what stops it going live ──
      await page.goto(`/sales/online-listings?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Online store listings' })).toBeVisible()
      await page.getByLabel('Store', { exact: true }).selectOption({ label: 'Shopify (own website)' })
      await page.getByLabel('Item', { exact: true }).selectOption(itemLabel)
      await page.getByLabel('Store price incl. GST ₹').fill('450')
      await page.getByRole('button', { name: 'Save listing' }).click()
      await statusWith(page, /Saved, not listed\. Still needed: Barcode/)
      await expectNoSeriousA11y(page)
      const [listing] = await api.view<{ status: string; blockers: string[] }>('listings', `company_id=eq.${cid}&select=status,blockers`)
      expect(listing?.status).toBe('draft')
      expect(listing?.blockers).toContain('barcode')

      // ── 8. Remaining screens: axe + their main data ──
      await page.goto(`/sales/shops-and-supermarkets?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Shops and supermarkets' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Shops, supermarkets and distributors' })).toContainText(trade.name, { timeout: 20_000 })
      await expectNoSeriousA11y(page)
      await page.goto(`/exports/mixer-grinder-costing?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Mixer grinder costing' })).toBeVisible()
      await expect(page.getByText('Not built yet')).toBeVisible()
      await expectNoSeriousA11y(page)
      for (const tab of ['Contact coverage', 'Payment reminders', 'Private label', 'Agents', 'Queries']) {
        await page.goto(`/sales/customer-care-and-agents?${q}`)
        await page.getByRole('tab', { name: tab }).click()
        await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
        await expectNoSeriousA11y(page)
      }
      await page.goto(`/sales/quotations-and-orders?${q}`)
      await page.getByRole('tab', { name: 'Quotations' }).click()
      await expect(page.getByText('Quotations are not in the database yet')).toBeVisible()
      await expectNoSeriousA11y(page)
      await page.goto(`/sales/credit-customers?${q}`)
      await page.getByRole('tab', { name: 'MD exceptions' }).click()
      await expect(page.getByRole('region', { name: 'MD exceptions' })).toContainText(trade.name, { timeout: 20_000 })
      await expectNoSeriousA11y(page)
      void todayIst
    } finally {
      await people.cleanup()
      await staffCtx.close()
      await thirdCtx.close()
    }
  })
})
