import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { givePeople, todayIst } from './phase5-setup'
import { restAsSignedInUser } from './phase3-sales-setup'
import { createFieldCompany, endStaleFieldDay, north, storageList } from './phase6-field-setup'

/**
 * Phase 6 · route sales, salesman app, logistics and driver app against the DEV database, on a fresh synthetic company,
 * with two logins: Admin (sales manager, cashier, dispatch desk) and the synthetic staff user (salesman + driver, roles
 * for this company for one hour, removed at the end).
 * Beat planned and the customer assigned with a price list on Route sales (DB) · the salesman starts the day only after
 * the location notice (refused first, then DB GPS point) · check-in 100 m from the pin accepted (DB) · order taken from
 * the price list (DB) · cash of ₹2 lakh refused (message), ₹500 collected (DB) · check-in 200 m away refused without a
 * reason, then flagged pending (DB) and approved by the manager (DB) · cash handed over short (DB), day end refused while
 * the cashier has not counted, the cashier's count flags the mismatch (DB Bug fixer item), finance resolves, day ended
 * (DB) · vehicle added with papers, a fuel entry · delivery scheduled from the order, invoice made, a bad e-way number
 * refused then a valid one saved (DB) · trip made, started by the driver after the notice (DB stock left) · proof of
 * delivery with a drawn signature (DB pod row + storage object) · trip closed (DB) · proof visible on Trips. axe on every
 * desktop and phone screen touched.
 */

async function rpcRead<T>(page: Page, fn: string, args: Record<string, unknown>): Promise<T> {
  const api = await restAsSignedInUser(page)
  return api.rpc<T>(fn, args, false)
}

test.describe('Phase 6 · field sales, logistics and driver', () => {
  test.skip(!hasCreds || !creds.staff.email, 'needs .env.test.local with admin and staff logins')

  test('beat → salesman day (notice, geofence, order, collection, handover) → dispatch → trip → POD → close', async ({ page, browser }) => {
    test.setTimeout(900_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createFieldCompany(page)
    const api = s.api
    const cid = s.companyId
    const q = `company=${cid}`
    const people = await givePeople(s, { staff: ['salesman', 'driver'] })
    const staffId = people.staffId

    const phoneCtx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      geolocation: { latitude: north(s.pin.lat, 100), longitude: s.pin.lng, accuracy: 10 },
      permissions: ['geolocation'],
    })
    await phoneCtx.addInitScript((id) => localStorage.setItem('sf.field.company', id), cid)
    const phone = await phoneCtx.newPage()
    try {
      // ── Route sales (Admin as sales manager): beat, salesman, price list ──
      await page.goto(`/sales/route-sales?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Route sales · today' })).toBeVisible()
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Plan beat' }).click()
      const beatDlg = page.getByRole('dialog')
      await beatDlg.getByLabel('Code', { exact: true }).fill(`B${s.tag}`)
      await beatDlg.getByLabel('Name', { exact: true }).fill(`E2E Test Beat ${s.tag}`)
      await beatDlg.getByLabel('Salesman').selectOption(staffId)
      await beatDlg.getByLabel(s.customer.name).check()
      await beatDlg.getByRole('button', { name: 'Save beat' }).click()
      await expect(beatDlg).toBeHidden({ timeout: 20_000 })
      await expect
        .poll(async () => (await api.view<{ salesman_user_id: string; customers: number }>('beats', `company_id=eq.${cid}&select=salesman_user_id,customers`))[0])
        .toMatchObject({ salesman_user_id: staffId, customers: 1 })

      await page.getByLabel('Customer', { exact: true }).selectOption(s.customer.id)
      await page.getByLabel('Salesman', { exact: true }).selectOption(staffId)
      await page.getByRole('button', { name: 'Assign salesman' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Salesman assigned.' })).toBeVisible({ timeout: 20_000 })
      await page.getByLabel('Price list', { exact: true }).selectOption(s.priceListId)
      await page.getByRole('button', { name: 'Set price list' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Price list set.' })).toBeVisible({ timeout: 20_000 })
      await expect.poll(async () => (await rpcRead<{ price_list_id: string | null }>(page, 'customer_price_list', { p_company_id: cid, p_party_id: s.customer.id })).price_list_id).toBe(s.priceListId)

      // ── Salesman's phone: start of day only after the notice ──
      await signInWithEmail(phone, creds.staff)
      await expect(phone).not.toHaveURL(/sign-in/, { timeout: 20_000 })
      // A run that stopped half-way may have left the synthetic salesman on duty elsewhere: close that day first.
      await endStaleFieldDay(api, await restAsSignedInUser(phone), staffId)
      await phone.goto('/field/today')
      await expect(phone.getByRole('button', { name: 'Start day' })).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(phone)
      await phone.getByRole('button', { name: 'Start day' }).click()
      await expect(phone.locator('[data-rule="gps.notice_required"]')).toBeVisible({ timeout: 20_000 })
      await phone.getByLabel('I have read the location notice').check()
      await phone.getByRole('button', { name: 'Start day' }).click()
      await expect(phone.getByText('On duty', { exact: true })).toBeVisible({ timeout: 20_000 })
      await expect.poll(async () => (await api.view('gps_points', `company_id=eq.${cid}&user_id=eq.${staffId}&select=id`)).length).toBeGreaterThan(0)

      // Check-in 100 m from the pin: accepted.
      await expect(phone.getByRole('link', { name: s.customer.name }).first()).toBeVisible({ timeout: 20_000 })
      await phone.getByRole('button', { name: 'Check in here' }).click()
      await expect(phone.getByTestId('checkin-result')).toHaveAttribute('data-geofence', 'ok', { timeout: 20_000 })
      await expect
        .poll(async () => (await api.view<{ geofence_ok: boolean; approval: string }>('visits', `company_id=eq.${cid}&party_id=eq.${s.customer.id}&select=geofence_ok,approval`))[0])
        .toMatchObject({ geofence_ok: true, approval: 'none' })
      await expectNoSeriousA11y(phone)

      // Order from the price list.
      await phone.goto(`/field/customers/${s.customer.id}/order`)
      await phone.getByLabel(`Quantity of ${s.product.name}`).fill('2')
      await phone.getByLabel('Payment', { exact: true }).selectOption('cash')
      await expectNoSeriousA11y(phone)
      await phone.getByRole('button', { name: /Confirm order/ }).click()
      await expect(phone.getByTestId('order-result')).toHaveAttribute('data-status', 'confirmed', { timeout: 20_000 })
      const [order] = await api.view<{ id: string; channel: string; status: string; salesman_user_id: string; taxable: number }>('sales_orders', `company_id=eq.${cid}&party_id=eq.${s.customer.id}&select=id,channel,status,salesman_user_id,taxable`)
      expect(order).toMatchObject({ channel: 'field', status: 'confirmed', salesman_user_id: staffId })
      expect(Number(order!.taxable)).toBe(200)

      // Collection: ₹2 lakh cash refused, ₹500 collected.
      await phone.goto(`/field/customers/${s.customer.id}/collect`)
      await phone.getByLabel('Amount', { exact: true }).fill('200000')
      await phone.getByRole('button', { name: 'Record payment and send receipt' }).click()
      await expect(phone.locator('[data-rule="cash.receipt_blocked"]')).toBeVisible({ timeout: 20_000 })
      await phone.getByLabel('Amount', { exact: true }).fill('500')
      await phone.getByRole('button', { name: 'Record payment and send receipt' }).click()
      await expect(phone.getByTestId('collect-result')).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(phone)
      await expect.poll(async () => (await api.view<{ amount: number; mode: string }>('field_collections', `company_id=eq.${cid}&party_id=eq.${s.customer.id}&select=amount,mode`)).map((r) => [Number(r.amount), r.mode])).toEqual([[500, 'cash']])

      // Check out (order taken).
      await phone.goto(`/field/customers/${s.customer.id}?tab=visit`)
      await phone.getByLabel('How did the visit end?').selectOption('order')
      await phone.getByRole('button', { name: 'Check out' }).click()
      await expect(phone.getByRole('status').filter({ hasText: 'Checked out.' })).toBeVisible({ timeout: 20_000 })

      // Check-in 200 m away: refused without a reason, then flagged for the manager.
      await phoneCtx.setGeolocation({ latitude: north(s.pin.lat, 200), longitude: s.pin.lng, accuracy: 10 })
      await phone.reload()
      await phone.getByRole('button', { name: 'Check in here' }).click()
      await expect(phone.locator('[data-rule="visit.out_of_fence"]')).toBeVisible({ timeout: 20_000 })
      await phone.getByLabel(/Why are you checking in from here/).fill('E2E test: shop shutter closed, met owner at the next building')
      await phone.getByRole('button', { name: 'Check in with this reason' }).click()
      await expect(phone.getByTestId('checkin-result')).toHaveAttribute('data-geofence', 'pending', { timeout: 20_000 })
      let pendingId = ''
      await expect
        .poll(async () => {
          const v = await api.view<{ id: string; geofence_ok: boolean; approval: string; distance_m: number }>('visits', `company_id=eq.${cid}&approval=eq.pending&select=id,geofence_ok,approval,distance_m`)
          pendingId = v[0]?.id ?? ''
          return v.length === 1 && !v[0]!.geofence_ok && Number(v[0]!.distance_m) > 150
        })
        .toBe(true)

      // Manager approves the exception (not the salesman's own).
      await page.goto(`/sales/route-sales?${q}`)
      const visitRow = page.getByTestId(`visit-${pendingId}`)
      await expect(visitRow).toBeVisible({ timeout: 20_000 })
      await visitRow.getByRole('button', { name: 'Approve' }).click()
      await expect.poll(async () => (await api.view<{ approval: string }>('visits', `id=eq.${pendingId}&select=approval`))[0]?.approval).toBe('approved')

      // Salesman checks out, the other screens pass axe.
      await phone.goto(`/field/customers/${s.customer.id}?tab=visit`)
      await phone.getByLabel('How did the visit end?').selectOption('follow_up')
      await phone.getByRole('button', { name: 'Check out' }).click()
      await expect(phone.getByRole('status').filter({ hasText: 'Checked out.' })).toBeVisible({ timeout: 20_000 })
      for (const tab of ['account', 'queries', 'reference']) {
        await phone.goto(`/field/customers/${s.customer.id}?tab=${tab}`)
        await expect(phone.getByRole('tab', { selected: true })).toBeVisible({ timeout: 20_000 })
        await expect(phone.locator('.sf-skeleton')).toHaveCount(0, { timeout: 20_000 })
        await expectNoSeriousA11y(phone)
      }
      for (const path of ['/field/customers', '/field/queries', '/field/library', '/field/my-day']) {
        await phone.goto(path)
        await expect(phone.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 })
        await expect(phone.locator('.sf-skeleton')).toHaveCount(0, { timeout: 20_000 })
        await expectNoSeriousA11y(phone)
      }

      // End of day: hand over ₹400 of the ₹500 collected (short), day end refused until the cashier counts.
      await phone.goto('/field/end-day')
      await expect(phone.getByTestId('end-cash')).toContainText('500', { timeout: 20_000 })
      await phone.getByLabel('₹200 × count').fill('2')
      await phone.getByRole('button', { name: 'Hand over to the cashier' }).click()
      await expect(phone.getByTestId('handover-result')).toContainText('Difference', { timeout: 20_000 })
      await expectNoSeriousA11y(phone)
      const [ho] = await api.view<{ id: string; status: string; expected_cash: number; salesman_total: number }>('cash_handovers', `company_id=eq.${cid}&select=id,status,expected_cash,salesman_total`)
      expect(ho).toMatchObject({ status: 'pending' })
      expect([Number(ho!.expected_cash), Number(ho!.salesman_total)]).toEqual([500, 400])
      await phone.getByRole('button', { name: 'End day', exact: true }).click()
      await expect(phone.locator('[data-rule="field.handover_pending"]')).toBeVisible({ timeout: 20_000 })

      // Cashier (Admin, another login) counts ₹400 → mismatch flagged (Bug fixer); finance resolves.
      await page.goto(`/sales/route-sales?${q}`)
      await page.getByRole('button', { name: 'Count and confirm' }).click()
      const countDlg = page.getByRole('dialog')
      await countDlg.getByLabel('Into cash account').selectOption(s.counterCashId)
      await countDlg.getByLabel('₹200 × count').fill('2')
      await countDlg.getByRole('button', { name: 'Confirm count' }).click()
      await expect(countDlg).toBeHidden({ timeout: 20_000 })
      await expect.poll(async () => (await api.view<{ status: string; bug_item_id: string | null }>('cash_handovers', `id=eq.${ho!.id}&select=status,bug_item_id`))[0]).toMatchObject({ status: 'mismatch' })
      expect((await api.view<{ bug_item_id: string | null }>('cash_handovers', `id=eq.${ho!.id}&select=bug_item_id`))[0]?.bug_item_id).toBeTruthy()
      await page.getByRole('button', { name: 'Resolve' }).click()
      const resolveDlg = page.getByRole('dialog')
      await resolveDlg.getByLabel('What was found (required)').fill('E2E test: ₹100 short, salesman to pay back')
      await resolveDlg.getByRole('button', { name: 'Resolve' }).click()
      await expect(resolveDlg).toBeHidden({ timeout: 20_000 })
      await expect.poll(async () => (await api.view<{ status: string }>('cash_handovers', `id=eq.${ho!.id}&select=status`))[0]?.status).toBe('resolved')
      await expectNoSeriousA11y(page)

      await phone.reload()
      await phone.getByRole('button', { name: 'End day', exact: true }).click()
      await expect(phone.getByTestId('day-ended')).toBeVisible({ timeout: 20_000 })
      await expect.poll(async () => (await api.view('day_closes', `company_id=eq.${cid}&user_id=eq.${staffId}&select=id`)).length).toBe(1)

      // ── Logistics desk (Admin): vehicle, vehicle file ──
      const reg = `XX99EE${rand4()}`
      await page.goto(`/logistics/vehicles-and-drivers?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Vehicles and drivers' })).toBeVisible()
      await expectNoSeriousA11y(page)
      await page.getByLabel('Registration number').fill(reg)
      await page.getByLabel('Type', { exact: true }).selectOption('truck')
      await page.getByLabel('Usual driver').selectOption(staffId)
      await page.getByLabel('Insurance · number').fill(`E2E-INS-${s.tag}`)
      const nextYear = `${Number(todayIst().slice(0, 4)) + 1}${todayIst().slice(4)}`
      await page.getByLabel('Insurance · valid until').fill(nextYear)
      await page.getByRole('button', { name: 'Add vehicle' }).click()
      await expect(page.getByRole('status').filter({ hasText: `Vehicle ${reg} added.` })).toBeVisible({ timeout: 20_000 })
      const [veh] = await api.view<{ id: string; usual_driver_user_id: string }>('vehicles', `reg_no=eq.${reg}&select=id,usual_driver_user_id`)
      expect(veh?.usual_driver_user_id).toBe(staffId)
      expect((await api.view<{ kind: string }>('vehicle_documents', `vehicle_id=eq.${veh!.id}&select=kind`)).map((d) => d.kind)).toContain('insurance')

      await page.goto(`/logistics/vehicle-file?${q}&vehicle=${veh!.id}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Vehicle file' })).toBeVisible()
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: '+ Add fuel' }).click()
      const fuelDlg = page.getByRole('dialog')
      await fuelDlg.getByLabel('Litres').fill('20')
      await fuelDlg.getByLabel('Amount (₹)').fill('2000')
      await fuelDlg.getByRole('button', { name: 'Save' }).click()
      await expect(fuelDlg).toBeHidden({ timeout: 20_000 })
      await expect.poll(async () => (await api.view<{ kind: string }>('vehicle_events', `vehicle_id=eq.${veh!.id}&select=kind`)).map((e) => e.kind)).toEqual(['fuel'])

      // ── Dispatch board: delivery from the order, invoice, e-way bill ──
      await page.goto(`/logistics/dispatch-board?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Dispatch board' })).toBeVisible()
      await page.getByRole('button', { name: 'Schedule delivery' }).click()
      const dDlg = page.getByRole('dialog')
      await dDlg.getByLabel('Order', { exact: true }).selectOption(order!.id)
      await dDlg.getByLabel('Goods leave from').selectOption(s.stores.id)
      await expect(dDlg.getByLabel(/^Quantity/)).toHaveValue(/^2/)
      await dDlg.getByRole('button', { name: 'Schedule' }).click()
      await expect(dDlg).toBeHidden({ timeout: 20_000 })
      const [disp] = await api.view<{ id: string; doc_no: string; status: string }>('dispatches', `order_id=eq.${order!.id}&select=id,doc_no,status`)
      expect(disp?.status).toBe('planned')
      const card = page.getByTestId(`dispatch-${disp!.doc_no}`)
      await expect(card).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(page)
      await card.getByRole('button', { name: 'Make invoice' }).click()
      await expect.poll(async () => (await api.view<{ document_id: string | null }>('dispatches', `id=eq.${disp!.id}&select=document_id`))[0]?.document_id, { timeout: 30_000 }).toBeTruthy()
      await card.getByRole('button', { name: 'E-way bill no.' }).click()
      const eDlg = page.getByRole('dialog')
      await eDlg.getByLabel('E-way bill number').fill('123')
      await eDlg.getByRole('button', { name: 'Save' }).click()
      await expect(eDlg.locator('[data-rule="dispatch.eway_format"]')).toBeVisible({ timeout: 20_000 })
      const ewayNo = `9${rand4()}${rand4()}${rand4().slice(0, 3)}`
      await eDlg.getByLabel('E-way bill number').fill(ewayNo)
      await eDlg.getByRole('button', { name: 'Save' }).click()
      await expect(eDlg).toBeHidden({ timeout: 20_000 })
      await expect.poll(async () => (await api.view<{ eway_bill_no: string | null }>('dispatches', `id=eq.${disp!.id}&select=eway_bill_no`))[0]?.eway_bill_no).toBe(ewayNo)

      // ── Trips: make the trip with the vehicle and the driver ──
      await page.goto(`/logistics/trips?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible()
      await page.getByRole('button', { name: 'New trip' }).click()
      const tDlg = page.getByRole('dialog')
      await tDlg.getByLabel('Vehicle', { exact: true }).selectOption(veh!.id)
      await tDlg.getByLabel('Driver', { exact: true }).selectOption(staffId)
      await tDlg.getByLabel(new RegExp(disp!.doc_no.replace(/[/]/g, '\\/'))).check()
      await tDlg.getByRole('button', { name: 'Make trip' }).click()
      await expect(tDlg).toBeHidden({ timeout: 20_000 })
      const [trip] = await api.view<{ id: string; status: string; stops: number }>('trips', `company_id=eq.${cid}&select=id,status,stops`)
      expect(trip).toMatchObject({ status: 'planned', stops: 1 })
      await expectNoSeriousA11y(page)

      // ── Driver's phone: start after the notice (stock leaves), arrive, proof of delivery, close ──
      await phone.goto('/driver/trip')
      await expect(phone.getByRole('button', { name: 'Start trip' })).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(phone)
      await phone.getByLabel('I have read the location notice').check()
      await phone.getByLabel('Odometer at start (km)').fill('12000')
      await phone.getByRole('button', { name: 'Start trip' }).click()
      await expect(phone.getByRole('button', { name: "I've arrived" })).toBeVisible({ timeout: 30_000 })
      expect((await api.view<{ status: string }>('dispatches', `id=eq.${disp!.id}&select=status`))[0]?.status).toBe('dispatched')
      const stock = await api.view<{ qty: number }>('stock_on_hand', `company_id=eq.${cid}&product_id=eq.${s.product.id}&place_id=eq.${s.stores.id}&bucket=eq.available&select=qty`)
      expect(stock.reduce((n, r) => n + Number(r.qty), 0)).toBe(98)

      await phone.getByRole('button', { name: "I've arrived" }).click()
      await phone.getByRole('link', { name: 'Record delivery' }).click()
      await expect(phone.getByRole('heading', { level: 1, name: 'Proof of delivery' })).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(phone)
      await phone.getByLabel('Name', { exact: true }).fill('E2E Test Receiver')
      await phone.getByLabel('Phone', { exact: true }).fill('9000000000')
      const box = (await phone.getByTestId('signature').boundingBox())!
      await phone.mouse.move(box.x + 20, box.y + 40)
      await phone.mouse.down()
      for (const [dx, dy] of [
        [60, 80],
        [110, 30],
        [170, 90],
        [230, 40],
      ] as const)
        await phone.mouse.move(box.x + dx, box.y + dy, { steps: 5 })
      await phone.mouse.up()
      await expect(phone.getByText('Signed', { exact: true })).toBeVisible()
      await phone.getByRole('button', { name: 'Confirm delivery' }).click()
      await expect(phone.getByTestId('pod-done')).toBeVisible({ timeout: 30_000 })
      const [pod] = await api.view<{ signature_path: string; received_by_name: string; receiver_phone_masked: string | null }>('pods', `dispatch_id=eq.${disp!.id}&select=signature_path,received_by_name,receiver_phone_masked`)
      expect(pod?.received_by_name).toBe('E2E Test Receiver')
      expect(pod?.signature_path.startsWith(`${cid}/${trip!.id}/`)).toBe(true)
      const files = await storageList(page, 'pod', `${cid}/${trip!.id}`)
      expect(files.map((f) => `${cid}/${trip!.id}/${f.name}`)).toContain(pod!.signature_path)
      expect((await api.view<{ status: string }>('dispatches', `id=eq.${disp!.id}&select=status`))[0]?.status).toBe('delivered')

      await phone.goto('/driver/trip')
      await phone.getByLabel('Odometer at end (km)').fill('12080')
      await phone.getByRole('button', { name: 'Close trip' }).click()
      await expect.poll(async () => (await api.view<{ status: string }>('trips', `id=eq.${trip!.id}&select=status`))[0]?.status).toBe('closed')

      // Proof of delivery seen from the desk.
      await page.goto(`/logistics/trips?${q}&trip=${trip!.id}`)
      await page.getByRole('button', { name: 'View proof of delivery' }).click()
      await expect(page.getByTestId('pod-view').getByRole('img')).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(page)
    } finally {
      await endStaleFieldDay(api, await restAsSignedInUser(phone).catch(() => api), staffId).catch(() => undefined)
      await people.cleanup()
      await phoneCtx.close()
    }
  })
})
