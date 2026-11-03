import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { restAsSignedInUser } from './phase3-sales-setup'
import { createPhase4Company, giveStaffRole, postBill, removeStaffRole, staffUserId, todayIst } from './phase4-setup'

/**
 * Phase 4 purchase to pay against the DEV database, with two people for segregation of duties (Admin, and the synthetic
 * staff user given the factory-manager role for a fresh synthetic company for one hour):
 * request (Admin) → refused to its maker, approved by the second user → RFQ to two suppliers, two quotations, the
 * cheaper chosen → draft PO by Admin, issue refused to the drafter, issued by the second user after accepting the price
 * increase (DB: issued + one po_issued outbox row queued for the consented supplier) → goods receipt of an item needing
 * an incoming test lands in QC hold (DB) → bill photo from the phone → fields typed → 3-way match → bill drafted and
 * posted (DB: posted, linked to the order and the receipt) → the price change is shown. axe on every screen.
 */

async function statusText(page: Page, re: RegExp): Promise<string> {
  const s = page.getByRole('status').filter({ hasText: re })
  await expect(s.first()).toBeVisible({ timeout: 20_000 })
  return ((await s.first().textContent()) ?? '').match(re)?.[1] ?? ''
}

/** A tiny valid JPEG (1×1), synthetic. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
)

test.describe('Phase 4 · purchase to pay', () => {
  test.skip(!hasCreds || !creds.staff.email, 'needs .env.test.local')

  test('Request → approval by another → RFQ and quotes → PO drafted by one, issued by another → GRN into QC hold → bill photo → match → bill posted → price change', async ({ page, browser }) => {
    test.setTimeout(420_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase4Company(page)
    const api = await restAsSignedInUser(page)
    const q = `company=${s.companyId}`
    const A = s.suppliers.consented
    const B = s.suppliers.other
    const item = s.items.tested
    const itemLabel = `${item.code} · ${item.name}`

    // A previous bill from supplier B at ₹100 gives the item a last rate, so ₹110 later is a price increase.
    await postBill(s, { supplierId: B.id, productId: item.id, qty: '5', rate: '100', billNo: `E2E-OLD-${rand4()}` })

    // The second person: the synthetic staff user, factory manager for this company only, for one hour.
    const staffId = await staffUserId(api)
    const roleId = await giveStaffRole(api, staffId, 'factory_manager', s.companyId)
    const staffCtx = await browser.newContext()
    const staffPage = await staffCtx.newPage()
    try {
      await signInWithEmail(staffPage, creds.staff)
      await expect(staffPage).not.toHaveURL(/sign-in/, { timeout: 20_000 })

      // ── 1. Purchase request (Admin) ──
      await page.goto(`/purchase/purchase-requests?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Purchase requests' })).toBeVisible()
      await page.getByLabel('Department', { exact: true }).selectOption({ label: s.department })
      await page.getByLabel('Item, line 1').selectOption({ label: itemLabel })
      await page.getByLabel('Quantity, line 1').fill('10')
      await page.getByLabel('Estimated rate, line 1').fill('105')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Send for approval' }).click()
      const prNo = await statusText(page, /Sent for approval as (\S+)\./)
      const [pr] = await api.view<{ id: string; status: string; requested_by: string; est_total: number }>('purchase_requests', `company_id=eq.${s.companyId}&doc_no=eq.${encodeURIComponent(prNo)}&select=id,status,requested_by,est_total`)
      expect(pr?.status).toBe('submitted')
      expect(Number(pr?.est_total)).toBe(1050)

      // The maker cannot approve their own request (server message).
      await page.goto(`/purchase/purchase-requests?${q}&tab=waiting`)
      await page.getByRole('button', { name: `Open request ${prNo}` }).click()
      await page.getByRole('button', { name: 'Approve', exact: true }).click()
      await expect(page.getByText('You made this request, so you cannot approve it.')).toBeVisible({ timeout: 15_000 })
      await expectNoSeriousA11y(page)

      // Another approver approves.
      await staffPage.goto(`/purchase/purchase-requests?${q}&tab=waiting`)
      await staffPage.getByRole('button', { name: `Open request ${prNo}` }).click()
      await staffPage.getByRole('button', { name: 'Approve', exact: true }).click()
      await statusText(staffPage, new RegExp(`(Request ${prNo.replace(/\//g, '\\/')} approved)`))
      const [prA] = await api.view<{ status: string; decided_by: string }>('purchase_requests', `id=eq.${pr?.id}&select=status,decided_by`)
      expect(prA).toMatchObject({ status: 'approved', decided_by: staffId })

      // ── 2. RFQ to two suppliers, two quotations, choose the cheaper ──
      await page.goto(`/purchase/purchase-orders?${q}&tab=quotes&request=${pr?.id}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Purchase orders' })).toBeVisible()
      await page.getByLabel(A.name).check()
      await page.getByLabel(B.name).check()
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Create request for quotation' }).click()
      await expect(page.getByRole('heading', { name: /^Request for quotation RFQ/ })).toBeVisible({ timeout: 15_000 })
      for (const [sup, rate] of [
        [A, '110'],
        [B, '120'],
      ] as const) {
        await page.getByLabel('Supplier', { exact: true }).selectOption({ label: sup.name })
        await page.getByLabel('Quoted rate, line 1').fill(rate)
        await page.getByRole('button', { name: 'Save quotation' }).click()
        await statusText(page, new RegExp(`(Quotation from ${sup.name} saved)`))
      }
      const compare = page.getByTestId('quote-compare')
      await expect(compare.getByRole('columnheader', { name: A.name })).toBeVisible()
      await expect(compare.getByRole('columnheader', { name: B.name })).toBeVisible()
      await expect(compare.getByText('Cheapest')).toHaveCount(1)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: `Choose the quotation from ${A.name}` }).click()
      const dlg = page.getByRole('dialog')
      await dlg.getByLabel('Deliver to').selectOption({ label: `${s.stores.name} · E2E Test Factory ${s.code.slice(4)}` })
      await dlg.getByRole('button', { name: 'Make draft order' }).click()
      await expect(page.getByRole('heading', { name: 'Draft purchase order' })).toBeVisible({ timeout: 15_000 })
      const orderId = new URL(page.url()).searchParams.get('order') ?? ''
      expect(orderId).not.toBe('')
      await expect(page.getByText('1 lines are dearer than the last purchase')).toBeVisible()

      // ── 3. The drafter cannot issue; another approver issues after accepting the price increase ──
      await page.getByRole('button', { name: 'Issue order' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Issue order' }).click()
      await expect(page.getByText('You drafted this order, so you cannot issue it.')).toBeVisible({ timeout: 15_000 })
      await expectNoSeriousA11y(page)
      const [draftPo] = await api.view<{ status: string; doc_no: string | null; total: number }>('purchase_orders', `id=eq.${orderId}&select=status,doc_no,total`)
      expect(draftPo?.status).toBe('draft')
      expect(draftPo?.doc_no).toBeNull()
      expect(Number(draftPo?.total)).toBe(1298)

      await staffPage.goto(`/purchase/purchase-orders?${q}&order=${orderId}`)
      await expect(staffPage.getByRole('heading', { name: 'Draft purchase order' })).toBeVisible({ timeout: 15_000 })
      await staffPage.getByRole('button', { name: 'Issue order' }).click()
      await staffPage.getByRole('dialog').getByRole('button', { name: 'Issue order' }).click()
      await expect(staffPage.getByText(/Some lines are dearer than the last purchase/)).toBeVisible({ timeout: 15_000 })
      await staffPage.getByLabel('I accept the price increase').check()
      await staffPage.getByRole('button', { name: 'Issue order' }).click()
      await staffPage.getByRole('dialog').getByRole('button', { name: 'Issue order' }).click()
      await expect(staffPage.getByRole('heading', { name: /^Purchase order PO\// })).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(staffPage)
      const [po] = await api.view<{ status: string; doc_no: string; issued_by: string; created_by: string; price_rise_accepted_by: string }>('purchase_orders', `id=eq.${orderId}&select=status,doc_no,issued_by,created_by,price_rise_accepted_by`)
      expect(po?.status).toBe('issued')
      expect(po?.issued_by).toBe(staffId)
      expect(po?.price_rise_accepted_by).toBe(staffId)
      expect(po?.created_by).not.toBe(staffId)
      const outbox = await api.view<{ event: string; status: string; party_id: string; template_name: string }>('msg_outbox', `doc_type=eq.purch.orders&doc_id=eq.${orderId}&select=event,status,party_id,template_name`)
      expect(outbox).toHaveLength(1)
      expect(outbox[0]).toMatchObject({ event: 'purchase.po_issued', status: 'queued', party_id: A.id, template_name: 'po_issued' })
      const [prO] = await api.view<{ status: string }>('purchase_requests', `id=eq.${pr?.id}&select=status`)
      expect(prO?.status).toBe('ordered')

      // ── 4. Goods receipt of an item that needs an incoming test → QC hold ──
      const lot = `E2E-LOT-${rand4()}`
      await page.goto(`/purchase/goods-receipt?${q}&order=${orderId}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Goods receipt' })).toBeVisible()
      await expect(page.getByLabel(/^Received quantity, line 1/)).toHaveValue('10')
      await page.getByLabel(/^Lot number, line 1/).fill(lot)
      await page.getByLabel('Supplier invoice no.').fill(`E2E-INV-${rand4()}`)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Post receipt' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Post receipt' }).click()
      const grnNo = await statusText(page, /Goods receipt (\S+) posted\./)
      await expect(page.getByTestId('grn-lots')).toContainText('QC hold')
      const [grn] = await api.view<{ id: string; order_id: string; lines_in_quarantine: number }>('goods_receipts', `company_id=eq.${s.companyId}&doc_no=eq.${encodeURIComponent(grnNo)}&select=id,order_id,lines_in_quarantine`)
      expect(grn?.order_id).toBe(orderId)
      expect(grn?.lines_in_quarantine).toBe(1)
      const [gl] = await api.view<{ bucket: string; lot_status: string; lot_no: string; qty: number }>('grn_lines', `grn_id=eq.${grn?.id}&select=bucket,lot_status,lot_no,qty`)
      expect(gl).toMatchObject({ bucket: 'quarantine', lot_status: 'quarantine', lot_no: lot })
      const soh = await api.view<{ bucket: string; qty: number; place_id: string }>('stock_on_hand', `company_id=eq.${s.companyId}&product_id=eq.${item.id}&select=bucket,qty,place_id`)
      expect(soh).toHaveLength(1)
      expect(soh[0]).toMatchObject({ bucket: 'quarantine', place_id: s.stores.id })
      expect(Number(soh[0]?.qty)).toBe(10)
      await page.getByRole('tab', { name: 'Receipts' }).click()
      await expect(page.getByText('1 in QC hold')).toBeVisible()
      await expectNoSeriousA11y(page)

      // ── 5. Bill photo from the phone ──
      await page.goto(`/me/bill-photo?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Photo of a bill or challan' })).toBeVisible()
      await page.getByTestId('bill-file').setInputFiles({ name: 'e2e-bill.jpg', mimeType: 'image/jpeg', buffer: JPEG })
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Send for checking' }).click()
      await statusText(page, /(Sent\.)/)
      const caps = await api.view<{ id: string; photo_path: string; status: string; source: string }>('bill_captures', `company_id=eq.${s.companyId}&select=id,photo_path,status,source`)
      expect(caps).toHaveLength(1)
      expect(caps[0]?.photo_path.startsWith(`${s.companyId}/`)).toBe(true)
      expect(caps[0]).toMatchObject({ status: 'uploaded', source: 'phone' })
      const captureId = caps[0]?.id ?? ''

      // ── 6. Bill review: type the fields, match, draft, post ──
      const invNo = `E2E-B-${rand4()}${rand4()}`
      await page.goto(`/purchase/bill-photo-capture?${q}&capture=${captureId}`)
      await expect(page.getByRole('heading', { level: 1, name: /^Bill photo · / })).toBeVisible()
      await page.getByLabel('Supplier', { exact: true }).selectOption({ label: `${A.name} · ${A.gstin}` })
      await page.getByLabel('Invoice no.').fill(invNo)
      await page.getByLabel('Invoice date').fill(todayIst())
      await page.getByLabel('Purchase order', { exact: true }).selectOption({ label: `${po?.doc_no} · ${A.name}` })
      await page.getByLabel('Goods receipt', { exact: true }).selectOption({ index: 1 })
      await page.getByLabel('Taxable value ₹').fill('1100')
      await page.getByLabel('CGST ₹').fill('99')
      await page.getByLabel('SGST ₹').fill('99')
      await page.getByLabel('IGST ₹').fill('0')
      await page.getByLabel('Bill total ₹').fill('1298')
      await page.getByLabel('As written on the bill, line 1').fill('E2E Test resin bags')
      await page.getByLabel('Our item, line 1').selectOption({ label: itemLabel })
      await page.getByLabel('HSN, line 1').fill(s.hsn)
      await page.getByLabel('Quantity, line 1').fill('10')
      await page.getByLabel('Rate, line 1').fill('110')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Save fields' }).click()
      await statusText(page, /(Fields saved)/)
      await page.getByRole('button', { name: 'Match with order and receipt' }).click()
      await expect(page.getByTestId('match-checks')).toContainText('Bill number not entered before for this supplier.', { timeout: 15_000 })
      await expect(page.getByTestId('match-checks')).toContainText('dearer than the last rate')
      const [matched] = await api.view<{ status: string; order_id: string; grn_id: string; party_id: string }>('bill_captures', `id=eq.${captureId}&select=status,order_id,grn_id,party_id`)
      expect(matched).toMatchObject({ status: 'matched', order_id: orderId, grn_id: grn?.id, party_id: A.id })
      await page.getByRole('button', { name: 'Make the bill draft' }).click()
      await statusText(page, /(Supplier bill draft made for ₹1,298\.00)/)
      await page.getByRole('button', { name: 'Post bill' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Post bill' }).click()
      const billNo = await statusText(page, /Bill (\S+) posted to the books\./)
      await expectNoSeriousA11y(page)
      const [cap] = await api.view<{ status: string; bill_id: string; bill_status: string; bill_doc_no: string }>('bill_captures', `id=eq.${captureId}&select=status,bill_id,bill_status,bill_doc_no`)
      expect(cap).toMatchObject({ status: 'posted', bill_status: 'posted', bill_doc_no: billNo })
      const [bill] = await api.view<{ status: string; total: number; party_id: string; supplier_bill_no: string; voucher_id: string | null }>('purchase_bills', `id=eq.${cap?.bill_id}&select=status,total,party_id,supplier_bill_no,voucher_id`)
      expect(bill).toMatchObject({ status: 'posted', party_id: A.id, supplier_bill_no: invNo })
      expect(Number(bill?.total)).toBe(1298)
      expect(bill?.voucher_id).not.toBeNull()
      // The bill is linked to the receipt (api.goods_receipts.bill_id reads purch.bills.grn_id) and, through its capture, to the order.
      const [grnBilled] = await api.view<{ bill_id: string }>('goods_receipts', `id=eq.${grn?.id}&select=bill_id`)
      expect(grnBilled?.bill_id).toBe(cap?.bill_id)

      // ── 7. Price change visible ──
      await page.goto(`/purchase/price-changes?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Price changes' })).toBeVisible()
      await expect(page.getByTestId(`change-${item.code}`)).toHaveText('+10.00%', { timeout: 15_000 })
      await expectNoSeriousA11y(page)
      const [pc] = await api.view<{ latest_rate: number; previous_rate: number; is_increase: boolean }>('price_changes', `company_id=eq.${s.companyId}&product_id=eq.${item.id}&select=latest_rate,previous_rate,is_increase`)
      expect(Number(pc?.latest_rate)).toBe(110)
      expect(Number(pc?.previous_rate)).toBe(100)
      expect(pc?.is_increase).toBe(true)

      // ── 8. Phone home for buying and logistics ──
      await page.goto(`/me/buying-logistics?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Buying, logistics and petty cash' })).toBeAttached()
      await expect(page.getByTestId('bh-bills-count')).toHaveText('0', { timeout: 15_000 })
      await expectNoSeriousA11y(page)
    } finally {
      await removeStaffRole(api, roleId)
      await staffCtx.close()
    }
  })
})
