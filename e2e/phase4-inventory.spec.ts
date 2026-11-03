import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import type { Rest } from './phase3-sales-setup'
import { createPhase4Company, giveStaffRole, removeStaffRole, todayIst } from './phase4-setup'

/**
 * Phase 4 inventory against the DEV database with three people for segregation of duties (Admin; the synthetic staff
 * user as factory manager + supervisor + QC releaser; the synthetic third user as shop staff, later factory manager),
 * all on a fresh synthetic company for one hour:
 * opening stock → issue → movement in the ledger (DB) · a lot in QC hold refused to its receiver, tested and released
 * by another person (DB) · blind count refused to its counter, posted by another person as an adjustment (DB ledger
 * row) · a same-GSTIN transfer through all nine states with DB assertions at each step: approval refused to the
 * requester, picker ≠ carrier, delivery challan made at dispatch, sellable stock excludes in-transit and QC hold, blind
 * receipt by a third person, reconcile, picker and carrier refused at close, balance rule, closed by the third person ·
 * regrind weigh-in (DB). axe on every inventory screen.
 */

async function statusText(page: Page, re: RegExp): Promise<string> {
  const s = page.getByRole('status').filter({ hasText: re })
  await expect(s.first()).toBeVisible({ timeout: 20_000 })
  return ((await s.first().textContent()) ?? '').match(re)?.[1] ?? ''
}

async function userId(api: Rest, email: string): Promise<string> {
  const users = await api.rpc<{ user_id: string; sign_in_email: string | null }[]>('list_users', {}, false)
  const u = users.find((x) => x.sign_in_email === email)
  if (!u) throw new Error(`E2E user ${email} not found`)
  return u.user_id
}

const n = (v: unknown) => Number(v)

test.describe('Phase 4 · inventory', () => {
  test.skip(!hasCreds || !creds.staff.email || !creds.third.email, 'needs .env.test.local with admin, staff and third logins')

  test('Opening stock → issue → QC release by another → blind count posted by another → transfer through nine states → regrind', async ({ page, browser }) => {
    test.setTimeout(600_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase4Company(page)
    const api = s.api
    const tag = s.code.slice(4)
    const cid = s.companyId
    const q = `company=${cid}`
    const plain = s.items.plain
    const tested = s.items.tested
    const factory = `E2E Test Factory ${tag}`
    const storesLabel = `${s.stores.name} · ${factory}`

    // A shop on the same GSTIN (delivery challan for transfers), its challan series, and a scrap item.
    const shopBranch = await api.rpc<{ id: string }>('upsert_branch', { p: { company_id: cid, gstin_id: s.gstinId, code: `K${tag}`, name: `E2E Test Shop ${tag}`, kind: 'shop', address: 'E2E Test Road' } })
    const shopName = `E2E Test Shop Shelf ${tag}`
    const shop = await api.rpc<{ id: string }>('upsert_place', { p: { branch_id: shopBranch.id, code: `H${tag}`, name: shopName, kind: 'stores' } })
    await api.rpc('upsert_doc_series', { p: { company_id: cid, gstin_id: s.gstinId, doc_type: 'delivery_challan', fy_id: s.fyId, prefix: 'DC', pad: 4, next_no: 1 } })
    const scrapCode = `${s.code}S`
    const scrapName = `E2E Test PP Scrap ${tag}`
    const scrap = await api.rpc<{ id: string }>('upsert_product', { p: { code: scrapCode, name: scrapName, hsn_code: s.hsn, uom: 'KGS', kind: 'other', status: 'active', company_ids: [cid], force: true } })
    await api.rpc('set_item_stock_settings', { p_product_id: scrap.id, p: { is_scrap: true } })

    // Second and third people, for this company only, for one hour.
    const adminId = await userId(api, creds.admin.email)
    const staffId = await userId(api, creds.staff.email)
    const thirdId = await userId(api, creds.third.email)
    const roleIds: string[] = []
    for (const role of ['factory_manager', 'supervisor', 'qc_releaser']) roleIds.push(await giveStaffRole(api, staffId, role, cid))
    roleIds.push(await giveStaffRole(api, thirdId, 'shop_staff', cid))
    const staffCtx = await browser.newContext()
    const thirdCtx = await browser.newContext()
    const staffPage = await staffCtx.newPage()
    const thirdPage = await thirdCtx.newPage()
    try {
      await signInWithEmail(staffPage, creds.staff)
      await expect(staffPage).not.toHaveURL(/sign-in/, { timeout: 20_000 })
      await signInWithEmail(thirdPage, creds.third)
      await expect(thirdPage).not.toHaveURL(/sign-in/, { timeout: 20_000 })

      // ── 1. Opening stock (Admin) ──
      await page.goto(`/inventory/warehouse?${q}&tab=opening`)
      await expect(page.getByRole('heading', { level: 1, name: 'Warehouse · from receipt to delivery' })).toBeVisible()
      await page.getByLabel('Place', { exact: true }).selectOption({ label: storesLabel })
      await page.getByLabel('Item, line 1').selectOption({ label: `${plain.code} · ${plain.name}` })
      await page.getByLabel('Quantity, line 1').fill('100')
      await page.getByLabel('Unit cost, line 1').fill('50')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Post opening stock' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Post opening stock' }).click()
      await statusText(page, /(Opening stock posted: 1 lines\.)/)
      const open = await api.view<{ bucket: string; qty: number }>('stock_on_hand', `company_id=eq.${cid}&product_id=eq.${plain.id}&place_id=eq.${s.stores.id}&select=bucket,qty`)
      expect(open).toHaveLength(1)
      expect(open[0]?.bucket).toBe('available')
      expect(n(open[0]?.qty)).toBe(100)

      // ── 2. Issue → visible in the ledger ──
      await page.goto(`/inventory/stock-movements?${q}&tab=issue`)
      await expect(page.getByRole('heading', { level: 1, name: 'Stock movements' })).toBeVisible()
      await page.getByLabel('Item', { exact: true }).selectOption({ label: `${plain.code} · ${plain.name}` })
      await page.getByLabel('From store').selectOption({ label: storesLabel })
      await expect(page.getByText('Released stock here: 100 KGS')).toBeVisible({ timeout: 15_000 })
      await page.getByLabel('Quantity', { exact: true }).fill('5')
      await page.getByLabel('Batch, job or order no.').fill('E2E-JOB-1')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Post issue' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Post issue' }).click()
      const issueNo = await statusText(page, /Issued as (\S+)\./)
      expect(issueNo).not.toBe('')
      const [iss] = await api.view<{ qty: number; move_type: string; created_by: string; place_id: string }>('stock_movements', `company_id=eq.${cid}&doc_no=eq.${encodeURIComponent(issueNo)}&select=qty,move_type,created_by,place_id`)
      expect(iss).toMatchObject({ move_type: 'issue', created_by: adminId, place_id: s.stores.id })
      expect(n(iss?.qty)).toBe(-5)
      await expect(page.getByRole('cell', { name: issueNo })).toBeVisible({ timeout: 15_000 })
      await expectNoSeriousA11y(page)

      // ── 3. Component stock shows what is free ──
      await page.goto(`/inventory/component-stock?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Component stock' })).toBeVisible()
      await expect(page.getByTestId(`free-${plain.code}`)).toHaveText('95', { timeout: 15_000 })
      await page.getByRole('button', { name: new RegExp(`^Show lots and movements of ${plain.name}`) }).click()
      await expect(page.getByText(issueNo).first()).toBeVisible({ timeout: 15_000 })
      await expectNoSeriousA11y(page)

      // ── 4. QC hold: receiver refused, another person tests and releases ──
      const lotNo = `E2E-QC-${rand4()}`
      const grn = await api.rpc<{ lots: { lot_id: string; bucket: string }[] }>('post_goods_receipt', {
        p_header: { company_id: cid, party_id: s.suppliers.other.id, place_id: s.stores.id, receipt_date: todayIst(), gstin_id: s.gstinId, supplier_invoice_no: `E2E-GRN-${rand4()}` },
        p_lines: [{ product_id: tested.id, qty: '20', rate: '100', lot_no: lotNo }],
      })
      const lotId = grn.lots[0]?.lot_id ?? ''
      expect(grn.lots[0]?.bucket).toBe('quarantine')
      await page.goto(`/inventory/warehouse?${q}&tab=qc`)
      await page.getByRole('button', { name: `Open lot ${lotNo}` }).click()
      await page.getByRole('button', { name: 'Record test' }).click()
      await expect(page.getByText('You received these goods, so you cannot test them.')).toBeVisible({ timeout: 15_000 })
      await expectNoSeriousA11y(page)
      expect(await api.view('lab_tests', `lot_id=eq.${lotId}&select=id`)).toHaveLength(0)

      await staffPage.goto(`/inventory/warehouse?${q}&tab=qc`)
      await staffPage.getByRole('button', { name: `Open lot ${lotNo}` }).click()
      await staffPage.getByLabel('Result').selectOption('pass')
      await staffPage.getByLabel('Remarks').fill('E2E test: within limits')
      await staffPage.getByRole('button', { name: 'Record test' }).click()
      await statusText(staffPage, /(Test recorded: Pass\.)/)
      await staffPage.getByRole('button', { name: 'Release lot' }).click()
      await statusText(staffPage, /(Lot released into stock: 20 KGS\.)/)
      const [lot] = await api.view<{ status: string; released_by: string; received_by: string; last_test_result: string }>('lots', `id=eq.${lotId}&select=status,released_by,received_by,last_test_result`)
      expect(lot).toMatchObject({ status: 'available', released_by: staffId, received_by: adminId, last_test_result: 'pass' })
      const [labTest] = await api.view<{ tested_by: string; result: string }>('lab_tests', `lot_id=eq.${lotId}&select=tested_by,result`)
      expect(labTest).toMatchObject({ tested_by: staffId, result: 'pass' })
      await page.goto(`/inventory/raw-material?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Raw material and parts' })).toBeVisible()
      await expect(page.getByTestId(`free-${tested.code}`)).toHaveText('20', { timeout: 15_000 })
      await expectNoSeriousA11y(page)

      // ── 5. Blind count: counter refused, another person posts the difference ──
      await page.goto(`/inventory/warehouse?${q}&tab=counts`)
      await page.getByLabel('Place to count').selectOption({ label: storesLabel })
      await page.getByLabel('Only this item').selectOption({ label: `${plain.code} · ${plain.name}` })
      await page.getByRole('button', { name: 'Start count' }).click()
      await expect(page.getByRole('heading', { name: /^Count CNT/ })).toBeVisible({ timeout: 15_000 })
      const countId = new URL(page.url()).searchParams.get('count') ?? ''
      const [blindLine] = await api.view<{ system_qty: number | null }>('stock_count_lines', `count_id=eq.${countId}&select=system_qty`)
      expect(blindLine?.system_qty).toBeNull()
      await expect(page.getByRole('cell', { name: 'Hidden until submitted' }).first()).toBeVisible()
      await page.getByLabel(`Counted quantity, ${plain.name}`).fill('93')
      await page.getByLabel(`Reason, ${plain.name}`).fill('E2E test: two units short')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Save counts' }).click()
      await statusText(page, /(1 lines saved\.)/)
      await page.getByRole('button', { name: 'Send for approval' }).click()
      await statusText(page, /(Count sent for approval\.)/)
      await page.getByRole('button', { name: 'Post differences' }).click()
      await expect(page.getByText('You counted or submitted this count, so you cannot post it.')).toBeVisible({ timeout: 15_000 })
      await staffPage.goto(`/inventory/warehouse?${q}&tab=counts&count=${countId}`)
      await staffPage.getByRole('button', { name: 'Post differences' }).click()
      await statusText(staffPage, /(Count posted: 1 adjustments made\.)/)
      const [count] = await api.view<{ status: string; approved_by: string; submitted_by: string; doc_no: string }>('stock_counts', `id=eq.${countId}&select=status,approved_by,submitted_by,doc_no`)
      expect(count).toMatchObject({ status: 'posted', approved_by: staffId, submitted_by: adminId })
      const adj = await api.view<{ qty: number; created_by: string; bucket: string }>('stock_movements', `company_id=eq.${cid}&move_type=eq.adjustment&source_id=eq.${countId}&select=qty,created_by,bucket`)
      expect(adj).toHaveLength(1)
      expect(adj[0]).toMatchObject({ created_by: staffId, bucket: 'available' })
      expect(n(adj[0]?.qty)).toBe(-2)

      // ── 6. Transfer through the nine states (same GSTIN → delivery challan) ──
      await page.goto(`/inventory/stock-transfers?${q}&tab=new`)
      await expect(page.getByRole('heading', { level: 1, name: 'Stock transfers · two people at each end' })).toBeVisible()
      await page.getByLabel('From place').selectOption({ label: storesLabel })
      await page.getByLabel('To place').selectOption({ label: `${shopName} · E2E Test Shop ${tag}` })
      await page.getByLabel('Item, line 1').selectOption({ label: `${plain.code} · ${plain.name}` })
      await page.getByLabel('Quantity, line 1').fill('10')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Send request' }).click()
      await expect(page.getByRole('heading', { name: /^TR.* · .* → / })).toBeVisible({ timeout: 15_000 })
      const trId = new URL(page.url()).searchParams.get('transfer') ?? ''
      const trUrl = `/inventory/stock-transfers?${q}&transfer=${trId}`
      type T = { status: string; gst_doc_kind: string; requested_by: string; approved_by: string | null; picked_by: string | null; carried_by: string | null; received_by: string | null; closed_by: string | null; sales_document_id: string | null; gst_doc_no: string | null; qty_dispatched: number; qty_accepted: number; qty_quarantined: number; qty_returned: number; qty_lost: number; qty_in_transit: number; balanced: boolean; can_close: boolean }
      const tr = async (): Promise<T> => (await api.view<T>('transfers', `id=eq.${trId}&select=*`))[0] as T
      expect(await tr()).toMatchObject({ status: 'requested', gst_doc_kind: 'delivery_challan', requested_by: adminId })
      await expect(page.getByTestId('gst-doc')).toContainText('delivery challan is made when the carrier takes the goods')

      // 2 · approve: refused to the requester, done by another person.
      await page.getByRole('button', { name: 'Approve transfer' }).click()
      await expect(page.getByText('You made this request, so you cannot approve it.')).toBeVisible({ timeout: 15_000 })
      expect((await tr()).status).toBe('requested')
      await staffPage.goto(trUrl)
      await staffPage.getByRole('button', { name: 'Approve transfer' }).click()
      await statusText(staffPage, /(is now Approved\.)/)
      expect(await tr()).toMatchObject({ status: 'approved', approved_by: staffId })

      // 3 · reserve (custodian).
      await page.goto(trUrl)
      await page.getByRole('button', { name: 'Reserve stock' }).click()
      await statusText(page, /(is now Reserved\.)/)
      expect((await tr()).status).toBe('reserved')
      const [resv] = await api.view<{ reserved: number }>('stock_summary', `company_id=eq.${cid}&product_id=eq.${plain.id}&place_id=eq.${s.stores.id}&select=reserved`)
      expect(n(resv?.reserved)).toBe(10)
      await expectNoSeriousA11y(page)

      // 4 · pick and 5 · picker hands over (staff).
      await staffPage.goto(trUrl)
      await expect(staffPage.getByLabel(`Picked quantity, ${plain.name}`)).toHaveValue('10')
      await staffPage.getByRole('button', { name: 'Confirm pick' }).click()
      await statusText(staffPage, /(is now Picked\.)/)
      expect(await tr()).toMatchObject({ status: 'picked', picked_by: staffId })
      await staffPage.getByRole('button', { name: 'Confirm handover (picker)' }).click()
      await statusText(staffPage, /(is now Handed over\.)/)
      expect((await tr()).status).toBe('handed_over')

      // 6 · the carrier takes over on another login: stock into transit, delivery challan posted.
      await page.goto(trUrl)
      await page.getByLabel('Vehicle no.').fill('kl08e2e1')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Take over and dispatch (carrier)' }).click()
      const challanNo = await statusText(page, /is in transit\. Document (\S+)\./)
      const inTransit = await tr()
      expect(inTransit).toMatchObject({ status: 'in_transit', carried_by: adminId, gst_doc_no: challanNo })
      expect(n(inTransit.qty_dispatched)).toBe(10)
      const [challan] = await api.view<{ doc_type: string; status: string; party_id: string | null; gstin_id: string; tax_class: string; lawful_reason: string }>('sales_documents', `id=eq.${inTransit.sales_document_id}&select=doc_type,status,party_id,gstin_id,tax_class,lawful_reason`)
      expect(challan).toMatchObject({ doc_type: 'delivery_challan', status: 'posted', party_id: null, gstin_id: s.gstinId, lawful_reason: 'challan_not_sold' })
      await expect(page.getByTestId('gst-doc')).toContainText(`Delivery challan ${challanNo}`)
      // Sellable leaves out transit: the shop holds 10 in transit and nothing sellable yet.
      const [shopTransit] = await api.view<{ in_transit: number; available: number; sellable: number }>('stock_summary', `company_id=eq.${cid}&product_id=eq.${plain.id}&place_id=eq.${shop.id}&select=in_transit,available,sellable`)
      expect(n(shopTransit?.in_transit)).toBe(10)
      expect(n(shopTransit?.sellable)).toBe(0)
      const [itemT] = await api.view<{ total: number; sellable: number; in_transit: number }>('item_stock', `company_id=eq.${cid}&product_id=eq.${plain.id}&select=total,sellable,in_transit`)
      expect(n(itemT?.total)).toBe(93)
      expect(n(itemT?.in_transit)).toBe(10)
      expect(n(itemT?.sellable)).toBe(83)

      // 7 · blind receipt by a third person (never the picker): 7 good, 1 damaged, 2 not found.
      await thirdPage.goto(trUrl)
      await expect(thirdPage.getByRole('cell', { name: 'Hidden (blind count)' }).first()).toBeVisible({ timeout: 15_000 })
      await thirdPage.getByLabel(`Good quantity counted, ${plain.name}`).fill('7')
      await thirdPage.getByLabel(`Damaged quantity counted, ${plain.name}`).fill('1')
      await expectNoSeriousA11y(thirdPage)
      await thirdPage.getByRole('button', { name: 'Record receipt' }).click()
      await statusText(thirdPage, /(counted in\. Still in transit: 2\.)/)
      const rec = await tr()
      expect(rec).toMatchObject({ status: 'received', received_by: thirdId })
      expect([n(rec.qty_accepted), n(rec.qty_quarantined), n(rec.qty_in_transit)]).toEqual([7, 1, 2])
      // Sellable excludes QC hold and transit: 7 sellable at the shop out of 10 there.
      const [shopRec] = await api.view<{ available: number; quarantine: number; in_transit: number; sellable: number; total: number }>('stock_summary', `company_id=eq.${cid}&product_id=eq.${plain.id}&place_id=eq.${shop.id}&select=available,quarantine,in_transit,sellable,total`)
      expect([n(shopRec?.available), n(shopRec?.quarantine), n(shopRec?.in_transit), n(shopRec?.sellable), n(shopRec?.total)]).toEqual([7, 1, 2, 7, 10])
      const shopSoh = await api.view<{ bucket: string; sellable: boolean }>('stock_on_hand', `company_id=eq.${cid}&product_id=eq.${plain.id}&place_id=eq.${shop.id}&select=bucket,sellable`)
      expect(shopSoh.filter((r) => r.sellable).map((r) => r.bucket)).toEqual(['available'])

      // 8 · reconcile (custodian): 1 found good, 1 returned to the sender's QC hold → nothing left in transit.
      await staffPage.goto(trUrl)
      await staffPage.getByLabel(`Found good, ${plain.name}`).fill('1')
      await staffPage.getByLabel(`Returned to sender, ${plain.name}`).fill('1')
      await staffPage.getByRole('button', { name: 'Settle differences' }).click()
      await statusText(staffPage, /(is now Reconciled\.)/)
      const recd = await tr()
      expect(recd).toMatchObject({ status: 'reconciled', balanced: true, can_close: true })
      expect([n(recd.qty_dispatched), n(recd.qty_accepted), n(recd.qty_quarantined), n(recd.qty_returned), n(recd.qty_lost), n(recd.qty_in_transit)]).toEqual([10, 8, 1, 1, 0, 0])
      await expect(staffPage.getByTestId('balance-sum')).toHaveText('10 = 8 + 1 + 1 + 0 + 0')
      const [back] = await api.view<{ quarantine: number }>('stock_summary', `company_id=eq.${cid}&product_id=eq.${plain.id}&place_id=eq.${s.stores.id}&select=quarantine`)
      expect(n(back?.quarantine)).toBe(1)

      // 9 · close: the picker and the carrier are refused; the third person (now with the close right) closes.
      await staffPage.getByRole('button', { name: 'Close transfer' }).click()
      await expect(staffPage.getByText('The picker or the carrier cannot close the transfer.')).toBeVisible({ timeout: 15_000 })
      await expectNoSeriousA11y(staffPage)
      await page.goto(trUrl)
      await page.getByRole('button', { name: 'Close transfer' }).click()
      await expect(page.getByText('The picker or the carrier cannot close the transfer.')).toBeVisible({ timeout: 15_000 })
      expect((await tr()).status).toBe('reconciled')
      roleIds.push(await giveStaffRole(api, thirdId, 'factory_manager', cid))
      await thirdPage.goto(trUrl)
      await thirdPage.reload()
      await thirdPage.getByRole('button', { name: 'Close transfer' }).click()
      await statusText(thirdPage, /(is now Closed\.)/)
      expect(await tr()).toMatchObject({ status: 'closed', closed_by: thirdId })
      const events = await api.view<{ action: string }>('transfer_events', `transfer_id=eq.${trId}&select=action&order=id`)
      expect(events.map((e) => e.action)).toEqual(['requested', 'approved', 'reserved', 'picked', 'handed_over', 'dispatched', 'received', 'reconcile', 'closed'])
      await expectNoSeriousA11y(thirdPage)
      await page.goto(`/inventory/stock-transfers?${q}&tab=all`)
      await expect(page.getByRole('button', { name: /^Open transfer TR/ })).toHaveCount(1)
      await expectNoSeriousA11y(page)

      // ── 7. Regrind: scrap weighed in ──
      await page.goto(`/inventory/scrap-and-regrind?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Scrap and regrind' })).toBeVisible()
      await page.getByLabel('Scrap or regrind item').selectOption({ label: `${scrapCode} · ${scrapName}` })
      await page.getByLabel('Comes from item').selectOption({ label: `${plain.code} · ${plain.name}` })
      await page.getByLabel('Place', { exact: true }).selectOption({ label: storesLabel })
      await page.getByLabel('Weight').fill('3.5')
      await page.getByLabel('Machine').fill('E2E-M1')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Weigh in' }).click()
      await statusText(page, /(Scrap weighed in\.)/)
      const regrind = await api.view<{ kind: string; qty: number; product_id: string; source_product_id: string; machine: string; recorded_by: string }>('regrind_entries', `company_id=eq.${cid}&select=kind,qty,product_id,source_product_id,machine,recorded_by`)
      expect(regrind).toHaveLength(1)
      expect(regrind[0]).toMatchObject({ kind: 'scrap_in', product_id: scrap.id, source_product_id: plain.id, machine: 'E2E-M1', recorded_by: adminId })
      expect(n(regrind[0]?.qty)).toBe(3.5)
      const [scrapStock] = await api.view<{ total: number }>('scrap_stock', `company_id=eq.${cid}&product_id=eq.${scrap.id}&select=total`)
      expect(n(scrapStock?.total)).toBe(3.5)
      await expect(page.getByRole('cell', { name: 'E2E-M1', exact: false }).first()).toBeVisible({ timeout: 15_000 })
      await expectNoSeriousA11y(page)

      // ── 8. axe on the remaining warehouse sections ──
      for (const tab of ['tasks', 'places', 'reorder', 'negative']) {
        await page.goto(`/inventory/warehouse?${q}&tab=${tab}`)
        await expect(page.getByRole('heading', { level: 1, name: 'Warehouse · from receipt to delivery' })).toBeVisible()
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
        await expectNoSeriousA11y(page)
      }
      await page.goto(`/inventory/stock-movements?${q}&tab=return`)
      await expect(page.getByRole('heading', { name: 'Return unused material' })).toBeVisible()
      await expectNoSeriousA11y(page)
    } finally {
      for (const id of roleIds) await removeStaffRole(api, id).catch(() => undefined)
      await staffCtx.close()
      await thirdCtx.close()
    }
  })
})
