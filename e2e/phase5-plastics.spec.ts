import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { addItem, createPhase5Company, givePeople, postOpening } from './phase5-setup'

/**
 * Phase 5 · Plastics production against the DEV database, three people for segregation of duties (Admin; the synthetic
 * staff user as production manager — no cost right; the synthetic third user as QC releaser), on a fresh synthetic
 * company for one hour: mould project moved through its stages, Admin's own approval refused, approved by the staff user
 * (DB) · mould registered and put on a machine (DB) · injection shift recorded → OEE on screen equals the DB values, good
 * pieces in quarantine, consumption ledger rows (DB) · quality inspection by the operator/recorder refused, by the third
 * person accepted (DB lot available) · BOM written by Admin, own approval refused, approved by the staff user (DB) ·
 * assembly refused when short (every short component listed, nothing moved — DB), then posted after stock (DB ledger) ·
 * pad print job (DB) · operator machine check from the phone (DB) · costing screens show the cost-hidden state for the
 * staff user · axe on every Plastics screen including the phone ones.
 */

async function alertWith(page: Page, re: RegExp) {
  await expect(page.getByRole('alert').filter({ hasText: re }).first()).toBeVisible({ timeout: 20_000 })
}
async function statusWith(page: Page, re: RegExp) {
  await expect(page.getByRole('status').filter({ hasText: re }).first()).toBeVisible({ timeout: 20_000 })
}

test.describe('Phase 5 · Plastics production', () => {
  test.skip(!hasCreds || !creds.staff.email || !creds.third.email, 'needs .env.test.local with admin, staff and third logins')

  test('Mould project approved by another → mould on machine → shift with OEE → inspection by a non-maker → BOM approved by another → assembly short then posted → pad print → machine check → cost-hidden', async ({ page, browser }) => {
    test.setTimeout(900_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase5Company(page)
    const api = s.api
    const cid = s.companyId
    const tag = s.tag
    const q = `company=${cid}`
    const branchName = `E2E Test Factory ${tag}`
    const placeLabel = (name: string) => ({ label: `${name} · ${branchName}` })

    // Items: granules (kg), regrind (kg, scrap item), a moulded lid and a spring (Nos), the assembled grinder, ink (kg).
    const granule = await addItem(s, { suffix: 'XG', name: `E2E Test PP Granule ${tag}`, uom: 'KGS', kind: 'raw_material' })
    const regrind = await addItem(s, { suffix: 'XR', name: `E2E Test PP Regrind ${tag}`, uom: 'KGS', kind: 'other' })
    await api.rpc('set_item_stock_settings', { p_product_id: regrind.id, p: { is_scrap: true } })
    const part = await addItem(s, { suffix: 'XL', name: `E2E Test Jar Lid ${tag}`, uom: 'NOS', kind: 'component' })
    const spring = await addItem(s, { suffix: 'XS', name: `E2E Test Spring ${tag}`, uom: 'NOS', kind: 'component' })
    const grinder = await addItem(s, { suffix: 'XM', name: `E2E Test Grinder ${tag}`, uom: 'NOS', kind: 'finished' })
    const ink = await addItem(s, { suffix: 'XI', name: `E2E Test Ink ${tag}`, uom: 'KGS', kind: 'consumable' })
    await postOpening(s, s.stores.id, [
      { productId: granule.id, qty: '100', unitCost: '120', lotNo: `E2E-LOT-R${tag}` },
      { productId: regrind.id, qty: '10', unitCost: '40' },
      { productId: ink.id, qty: '2', unitCost: '900' },
    ])
    const machCode = `E2EIM${tag}`.toUpperCase()
    const machName = `E2E Test Injection ${tag}`
    const machine = await api.rpc<{ id: string }>('upsert_asset', { p: { company_id: cid, code: machCode, name: machName, kind: 'injection_machine', place_id: s.line.id } })
    const padCode = `E2EPP${tag}`.toUpperCase()
    const padName = `E2E Test Pad Printer ${tag}`
    await api.rpc('upsert_asset', { p: { company_id: cid, code: padCode, name: padName, kind: 'pad_printer', place_id: s.line.id } })
    const [machRow] = await api.view<{ code: string }>('assets', `id=eq.${machine.id}&select=code`)
    const machLabel = { label: `${machRow?.code ?? machCode} · ${machName}` }

    const people = await givePeople(s, { staff: ['production_manager'], third: ['qc_releaser'] })
    const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const thirdCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const staffPage = await staffCtx.newPage()
    const thirdPage = await thirdCtx.newPage()
    try {
      await signInWithEmail(staffPage, creds.staff)
      await expect(staffPage).not.toHaveURL(/sign-in/, { timeout: 20_000 })
      await signInWithEmail(thirdPage, creds.third)
      await expect(thirdPage).not.toHaveURL(/sign-in/, { timeout: 20_000 })

      // ── 1. Mould project: Admin creates and moves it on; Admin's approval refused; the staff user approves ──
      const projCode = `E2EMP${tag}`.toUpperCase()
      await page.goto(`/production/mould-projects?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Mould projects' })).toBeVisible()
      await page.getByRole('button', { name: 'New mould project' }).click()
      let dlg = page.getByRole('dialog')
      await dlg.getByLabel('Project code').fill(projCode)
      await dlg.getByLabel('Name', { exact: true }).fill(`E2E Test Lid Mould Project ${tag}`)
      await dlg.getByLabel('Component it will make').selectOption({ label: `${part.code} · ${part.name}` })
      await dlg.getByRole('button', { name: 'Save' }).click()
      await page.getByRole('button', { name: new RegExp(`^Open project ${projCode}`) }).click()
      await page.getByRole('button', { name: 'Move to Trial' }).click()
      await statusWith(page, /Stage is now Trial/)
      await page.getByRole('button', { name: 'Move to Customer approval' }).click()
      await statusWith(page, /Stage is now Customer approval/)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Approve project' }).click()
      await alertWith(page, /Someone else must approve what you wrote or created/)
      type P = { id: string; stage: string; approved_by: string | null }
      let [proj] = await api.view<P>('mould_projects', `company_id=eq.${cid}&code=eq.${projCode}&select=id,stage,approved_by`)
      expect(proj?.stage).toBe('approval')

      await staffPage.goto(`/production/mould-projects?${q}`)
      await staffPage.getByRole('button', { name: new RegExp(`^Open project ${projCode}`) }).click()
      await staffPage.getByRole('button', { name: 'Approve project' }).click()
      await statusWith(staffPage, /Stage is now Approved/)
      ;[proj] = await api.view<P>('mould_projects', `id=eq.${proj?.id ?? ''}&select=id,stage,approved_by`)
      expect(proj?.stage).toBe('approved')
      expect(proj?.approved_by).toBe(people.staffId)

      // ── 2. Mould register: Admin adds the mould and puts it on the machine ──
      const mouldCode = `E2EML${tag}`.toUpperCase()
      await page.goto(`/production/mould-register?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Mould register' })).toBeVisible()
      await page.getByRole('button', { name: 'Add mould' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('Mould code').fill(mouldCode)
      await dlg.getByLabel('Name', { exact: true }).fill(`E2E Test Lid Mould ${tag}`)
      await dlg.getByLabel('Part it makes').selectOption({ label: `${part.code} · ${part.name}` })
      await dlg.getByLabel('Material (granules)').selectOption({ label: `${granule.code} · ${granule.name}` })
      await dlg.getByLabel('Cavities').fill('2')
      await dlg.getByLabel('Standard cycle time (s)').fill('30')
      await dlg.getByLabel('Kept at (place)').selectOption(placeLabel(s.stores.name))
      await dlg.getByLabel('Life (shots)').fill('100000')
      await dlg.getByLabel('Cost (₹)').fill('50000')
      await dlg.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByTestId('mr-total')).toHaveText('1', { timeout: 20_000 })
      type M = { id: string; cavities: number; location: string; machine_asset_id: string | null; product_id: string | null; shot_count: number }
      let [mould] = await api.view<M>('moulds', `company_id=eq.${cid}&code=eq.${mouldCode}&select=id,cavities,location,machine_asset_id,product_id,shot_count`)
      expect(mould?.cavities).toBe(2)
      expect(mould?.product_id).toBe(part.id)
      await page.getByRole('button', { name: new RegExp(`^Open mould ${mouldCode}`) }).click()
      await page.getByLabel('Move to').selectOption('machine')
      await page.getByLabel('Injection machine').selectOption(machLabel)
      await page.getByRole('button', { name: 'Record move' }).click()
      await statusWith(page, /Moved\. Now: On a machine/)
      await expectNoSeriousA11y(page)
      ;[mould] = await api.view<M>('moulds', `id=eq.${mould?.id ?? ''}&select=id,cavities,location,machine_asset_id,product_id,shot_count`)
      expect(mould?.location).toBe('machine')
      expect(mould?.machine_asset_id).toBe(machine.id)

      // ── 3. Injection shift: Admin is operator and recorder; the server's OEE is shown ──
      await page.goto(`/production/injection-production?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Injection production' })).toBeVisible()
      await page.getByLabel('Machine', { exact: true }).selectOption(machLabel)
      await expect(page.getByLabel('Mould', { exact: true })).toHaveValue(mould?.id ?? '')
      await page.getByLabel('Operator', { exact: true }).selectOption(people.adminId)
      await page.getByLabel('Unit (place)').selectOption(placeLabel(s.line.name))
      await page.getByLabel('Good pieces to (place)').selectOption(placeLabel(s.fgHold.name))
      await page.getByLabel('Cavities running').fill('2')
      await page.getByLabel('Planned minutes').fill('480')
      await page.getByLabel('Shot counter start').fill('0')
      await page.getByLabel('Shot counter end').fill('700')
      await page.getByLabel('Good pieces', { exact: true }).fill('1350')
      await page.getByLabel('Reject reason 1').fill('E2E short shot')
      await page.getByLabel('Reject pieces 1').fill('50')
      await page.getByLabel('Downtime minutes 1').fill('60')
      await page.getByLabel('Material 1', { exact: true }).selectOption({ label: `${granule.code} · ${granule.name}` })
      await page.getByLabel('Material 1 from').selectOption(placeLabel(s.stores.name))
      await page.getByLabel('Material 1 kg').fill('20')
      await page.getByLabel('Regrind 1', { exact: true }).selectOption({ label: `${regrind.code} · ${regrind.name}` })
      await page.getByLabel('Regrind 1 from').selectOption(placeLabel(s.stores.name))
      await page.getByLabel('Regrind 1 kg').fill('2')
      await page.getByLabel('Scrap item').selectOption({ label: `${regrind.code} · ${regrind.name}` })
      await page.getByLabel('Scrap to (place)').selectOption(placeLabel(s.stores.name))
      await page.getByLabel('Scrap kg').fill('1.5')
      await page.getByRole('button', { name: 'Save shift entry' }).click()
      await statusWith(page, /Shift .+ saved\./)
      await expect(page.getByTestId('shift-result')).toBeVisible()
      type S = { id: string; doc_no: string; lot_id: string; theoretical_qty: number; availability: number; performance: number; quality: number; oee: number; shots: number }
      const [shift] = await api.view<S>('injection_shifts', `company_id=eq.${cid}&select=id,doc_no,lot_id,theoretical_qty,availability,performance,quality,oee,shots`)
      expect(shift).toBeTruthy()
      // run 420 min · theoretical floor(420×60÷30)×2 = 1680 · A 0.875 · P 1400÷1680 · Q 1350÷1400 · OEE = A×P×Q (server, 4 dp)
      expect(Number(shift?.theoretical_qty)).toBe(1680)
      expect(Number(shift?.availability)).toBe(0.875)
      expect(Number(shift?.oee)).toBe(0.7031)
      expect(Number(shift?.shots)).toBe(700)
      for (const k of ['availability', 'performance', 'quality', 'oee'] as const) {
        await expect(page.getByTestId(`shift-${k}`)).toHaveAttribute('data-value', String(Number(shift?.[k])))
      }
      await expect(page.getByTestId('shift-oee')).toHaveText('70.31 %')
      await expect(page.getByTestId(`oee-${shift?.doc_no ?? ''}`)).toHaveAttribute('data-value', String(Number(shift?.oee)), { timeout: 20_000 })
      type L = { status: string; qty_quarantine: number; qty_on_hand: number }
      let [lot] = await api.view<L>('lots', `id=eq.${shift?.lot_id ?? ''}&select=status,qty_quarantine,qty_on_hand`)
      expect(lot?.status).toBe('quarantine')
      expect(Number(lot?.qty_quarantine)).toBe(1350)
      const cons = await api.view<{ product_id: string; qty: number; kind: string }>('material_consumption', `source_id=eq.${shift?.id ?? ''}&select=product_id,qty,kind`)
      expect(cons).toHaveLength(2)
      expect(Number(cons.find((c) => c.product_id === granule.id)?.qty)).toBe(20)
      expect(Number(cons.find((c) => c.product_id === regrind.id)?.qty)).toBe(2)
      ;[mould] = await api.view<M>('moulds', `id=eq.${mould?.id ?? ''}&select=id,cavities,location,machine_asset_id,product_id,shot_count`)
      expect(Number(mould?.shot_count)).toBe(700)
      await expectNoSeriousA11y(page)

      // ── 4. Quality: the operator/recorder's inspection refused; the third person accepts ──
      await page.goto(`/production/quality?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Quality inspections' })).toBeVisible()
      await page.getByRole('button', { name: `Inspect lot ${shift?.doc_no ?? ''}` }).click()
      await expect(page.getByTestId('qi-lot')).toContainText('1,350')
      await page.getByRole('button', { name: 'Accept · move to stock' }).click()
      await alertWith(page, /You made or recorded this lot, so someone else must inspect it/)
      await expectNoSeriousA11y(page)
      ;[lot] = await api.view<L>('lots', `id=eq.${shift?.lot_id ?? ''}&select=status,qty_quarantine,qty_on_hand`)
      expect(lot?.status).toBe('quarantine')

      await thirdPage.goto(`/production/quality?${q}`)
      await thirdPage.getByRole('button', { name: `Inspect lot ${shift?.doc_no ?? ''}` }).click()
      await expect(thirdPage.getByTestId('qi-lot')).toContainText('1,350', { timeout: 20_000 })
      await thirdPage.getByRole('button', { name: 'Accept · move to stock' }).click()
      await statusWith(thirdPage, /Inspection of .+ recorded\. Lot is now: Available/)
      ;[lot] = await api.view<L>('lots', `id=eq.${shift?.lot_id ?? ''}&select=status,qty_quarantine,qty_on_hand`)
      expect(lot?.status).toBe('available')
      expect(Number(lot?.qty_on_hand)).toBe(1350)
      const [qi] = await api.view<{ inspected_by: string; result: string; accepted_qty: number }>('quality_inspections', `lot_id=eq.${shift?.lot_id ?? ''}&select=inspected_by,result,accepted_qty`)
      expect(qi?.inspected_by).toBe(people.thirdId)
      expect(qi?.result).toBe('pass')
      await expectNoSeriousA11y(thirdPage)

      // ── 5. BOM: Admin writes it, Admin's approval refused, the staff user approves ──
      await page.goto(`/production/machine-assembly?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Machine assembly' })).toBeVisible()
      await page.getByRole('button', { name: 'New BOM version' }).click()
      await page.getByLabel('Assembled item').selectOption({ label: `${grinder.code} · ${grinder.name}` })
      await page.getByLabel('Component 1', { exact: true }).selectOption({ label: `${part.code} · ${part.name}` })
      await page.getByLabel('Component 1 per unit').fill('2')
      await page.getByRole('button', { name: '+ Add component' }).click()
      await page.getByLabel('Component 2', { exact: true }).selectOption({ label: `${spring.code} · ${spring.name}` })
      await page.getByLabel('Component 2 per unit').fill('1')
      await page.getByRole('button', { name: 'Save BOM draft' }).click()
      await statusWith(page, /Draft v1 saved/)
      await page.getByRole('button', { name: `Open BOM v1: ${grinder.code} · ${grinder.name}` }).click()
      await page.getByRole('button', { name: 'Approve BOM' }).click()
      await alertWith(page, /Someone else must approve what you wrote or created/)
      type Bm = { id: string; status: string; approved_by: string | null }
      let [bom] = await api.view<Bm>('assembly_boms', `company_id=eq.${cid}&product_id=eq.${grinder.id}&select=id,status,approved_by`)
      expect(bom?.status).toBe('draft')
      await expectNoSeriousA11y(page)

      await staffPage.goto(`/production/machine-assembly?${q}`)
      await staffPage.getByRole('button', { name: `Open BOM v1: ${grinder.code} · ${grinder.name}` }).click()
      await staffPage.getByRole('button', { name: 'Approve BOM' }).click()
      await statusWith(staffPage, /BOM approved/)
      ;[bom] = await api.view<Bm>('assembly_boms', `id=eq.${bom?.id ?? ''}&select=id,status,approved_by`)
      expect(bom?.status).toBe('approved')
      expect(bom?.approved_by).toBe(people.staffId)

      // ── 6. Assembly refused when short (every short component listed, nothing moved), then posted after stock ──
      const movesBefore = (await api.view('stock_movements', `company_id=eq.${cid}&select=id`)).length
      await page.goto(`/production/machine-assembly?${q}`)
      await page.getByLabel('Item to assemble (approved BOM)').selectOption({ label: `${grinder.code} · ${grinder.name} (v1)` })
      await page.getByLabel('Units (whole)').fill('10')
      await page.getByLabel('Components from (place)').selectOption(placeLabel(s.stores.name))
      await page.getByLabel('Assembled units to (place)').selectOption(placeLabel(s.fgHold.name))
      await page.getByRole('button', { name: 'Post assembly' }).click()
      await alertWith(page, /Components are short, so nothing was assembled/)
      const shortBox = page.getByRole('alert').filter({ hasText: /Components are short/ }).first()
      await expect(shortBox).toContainText(part.code)
      await expect(shortBox).toContainText(spring.code)
      expect(await api.view('assembly_orders', `company_id=eq.${cid}&select=id`)).toHaveLength(0)
      expect((await api.view('stock_movements', `company_id=eq.${cid}&select=id`)).length).toBe(movesBefore)

      await postOpening(s, s.stores.id, [
        { productId: part.id, qty: '30', unitCost: '5' },
        { productId: spring.id, qty: '20', unitCost: '3' },
      ])
      const movesStocked = (await api.view('stock_movements', `company_id=eq.${cid}&select=id`)).length
      await page.getByRole('button', { name: 'Post assembly' }).click()
      await statusWith(page, /Assembly .+ posted/)
      const [order] = await api.view<{ id: string; lot_id: string; qty: number }>('assembly_orders', `company_id=eq.${cid}&select=id,lot_id,qty`)
      expect(Number(order?.qty)).toBe(10)
      const used = await api.view<{ product_id: string; qty: number; kind: string }>('material_consumption', `source_id=eq.${order?.id ?? ''}&select=product_id,qty,kind`)
      expect(used).toHaveLength(2)
      expect(Number(used.find((c) => c.product_id === part.id)?.qty)).toBe(20)
      expect(Number(used.find((c) => c.product_id === spring.id)?.qty)).toBe(10)
      expect(used.every((c) => c.kind === 'component')).toBe(true)
      const [asmLot] = await api.view<L>('lots', `id=eq.${order?.lot_id ?? ''}&select=status,qty_quarantine,qty_on_hand`)
      expect(asmLot?.status).toBe('quarantine')
      expect(Number(asmLot?.qty_quarantine)).toBe(10)
      expect((await api.view('stock_movements', `company_id=eq.${cid}&select=id`)).length).toBe(movesStocked + 3)

      // ── 7. Pad print job ──
      await page.goto(`/production/pad-printing?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Pad printing' })).toBeVisible()
      await page.getByLabel('Part printed').selectOption({ label: `${part.code} · ${part.name}` })
      await page.getByLabel('Pad printer').selectOption({ label: `${padCode} · ${padName}` })
      await page.getByLabel('Pieces printed').fill('500')
      await page.getByLabel('Pieces rejected').fill('5')
      await page.getByLabel('Ink', { exact: true }).selectOption({ label: `${ink.code} · ${ink.name}` })
      await page.getByLabel('Ink used (kg)').fill('0.2')
      await page.getByLabel('Ink from (place)').selectOption(placeLabel(s.stores.name))
      await page.getByLabel('Labour minutes').fill('60')
      await page.getByRole('button', { name: 'Record print job' }).click()
      await statusWith(page, /Print job .+ recorded/)
      const [job] = await api.view<{ id: string; qty_printed: number; qty_rejected: number; ink_value: number }>('pad_print_jobs', `company_id=eq.${cid}&select=id,qty_printed,qty_rejected,ink_value`)
      expect(Number(job?.qty_printed)).toBe(500)
      expect(Number(job?.qty_rejected)).toBe(5)
      expect(Number(job?.ink_value)).toBe(180)
      expect(await api.view('material_consumption', `source_id=eq.${job?.id ?? ''}&select=id`)).toHaveLength(1)
      await expectNoSeriousA11y(page)

      // ── 8. Operator machine check from the phone (staff user) ──
      await staffPage.setViewportSize({ width: 390, height: 844 })
      await staffPage.goto(`/me/machine-check?${q}`)
      await expect(staffPage.getByRole('heading', { level: 1, name: 'Machine check · daily' })).toBeVisible()
      await staffPage.getByLabel('Machine', { exact: true }).selectOption(machLabel)
      const oks = staffPage.getByRole('button', { name: /^OK: / })
      await expect(oks).toHaveCount(10)
      for (let i = 0; i < 10; i++) await oks.nth(i).click()
      await expect(staffPage.getByTestId('mc-progress')).toHaveText('10 / 10')
      await expectNoSeriousA11y(staffPage)
      await staffPage.getByRole('button', { name: 'Submit' }).click()
      await statusWith(staffPage, /Saved\. All items OK/)
      const [check] = await api.view<{ all_ok: boolean; checked_by: string; checklist: unknown[] }>('machine_checks', `asset_id=eq.${machine.id}&select=all_ok,checked_by,checklist`)
      expect(check?.all_ok).toBe(true)
      expect(check?.checked_by).toBe(people.staffId)
      expect(check?.checklist).toHaveLength(10)
      await staffPage.goto(`/me/injection-manager?${q}`)
      await expect(staffPage.getByRole('heading', { level: 1, name: 'Injection manager home' })).toBeAttached()
      await expect(staffPage.getByTestId('ih-checks')).toHaveText('1 / 1', { timeout: 20_000 })
      await expectNoSeriousA11y(staffPage)
      await staffPage.goto(`/me/mould-manager?${q}`)
      await expect(staffPage.getByRole('heading', { level: 1, name: 'Mould manager home' })).toBeAttached()
      await expect(staffPage.getByTestId('mh-repair')).toHaveText('0', { timeout: 20_000 })
      await expectNoSeriousA11y(staffPage)

      // ── 9. Costing screens: hidden for the staff user (no cost right), shown to Admin ──
      await api.rpc('upsert_material_spec', { p: { company_id: cid, product_id: part.id, granule_product_id: granule.id, grade: 'E2E', part_weight_g: '12', runner_weight_g: '4', cavities: 2, packing_cost_per_piece: '0.10' } })
      await staffPage.setViewportSize({ width: 1440, height: 1000 })
      for (const [path, h1, rowText] of [
        [`/production/mould-costing?${q}`, 'Mould costing', mouldCode],
        [`/production/component-costing?${q}`, 'Component costing', part.code],
        [`/production/assembled-products?${q}`, 'Assembled products', grinder.code],
      ] as const) {
        await staffPage.goto(path)
        await expect(staffPage.getByRole('heading', { level: 1, name: h1 })).toBeVisible()
        await expect(staffPage.getByTestId('cost-hidden')).toBeVisible()
        await expect(staffPage.getByRole('row').filter({ hasText: rowText }).first()).toContainText('Hidden — needs cost rights', { timeout: 20_000 })
        await expectNoSeriousA11y(staffPage)
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible()
        await expect(page.getByTestId('cost-hidden')).toHaveCount(0)
        await expect(page.getByRole('row').filter({ hasText: rowText }).first()).not.toContainText('Hidden — needs cost rights', { timeout: 20_000 })
        await expectNoSeriousA11y(page)
      }
      // (50,000 + 0 upkeep) ÷ 1,00,000 shots ÷ 2 cavities
      await page.goto(`/production/mould-costing?${q}`)
      await expect(page.getByTestId(`mc-piece-${mouldCode}`)).toContainText('0.25', { timeout: 20_000 })

      // ── 10. axe on the remaining screens ──
      for (const [path, h1] of [
        [`/production/mould-projects?${q}`, 'Mould projects'],
        [`/production/mould-register?${q}`, 'Mould register'],
        [`/production/quality?${q}`, 'Quality inspections'],
      ] as const) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible()
        await expectNoSeriousA11y(page)
      }
      await page.getByRole('tab', { name: 'Done' }).click()
      await expect(page.getByRole('cell', { name: shift?.doc_no ?? '' }).first()).toBeVisible({ timeout: 20_000 })
      await expectNoSeriousA11y(page)
      await page.setViewportSize({ width: 390, height: 844 })
      for (const [path, h1] of [
        [`/me/mould-manager?${q}`, 'Mould manager home'],
        [`/me/injection-manager?${q}`, 'Injection manager home'],
        [`/me/machine-check?${q}`, 'Machine check · daily'],
      ] as const) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeAttached()
        await expectNoSeriousA11y(page)
      }
    } finally {
      await people.cleanup()
      await staffCtx.close()
      await thirdCtx.close()
    }
  })
})
