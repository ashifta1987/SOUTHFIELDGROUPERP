import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { addCustomer, addItem, createPhase5Company, givePeople, postOpening, todayIst } from './phase5-setup'

/**
 * Phase 5 · Biochem production against the DEV database, three people for segregation of duties (Admin; the synthetic
 * staff user as production manager; the synthetic third user as QC releaser), on a fresh synthetic company for one hour:
 * formula written and sent by Admin, Admin's own approval refused, approved by the staff user (DB) · batch plan refused
 * without a licence (server message + link) · Admin adds a synthetic licence on Admin → Licences (DB) · batch planned
 * (DB licence linked) · reserve · weighing refused to its weigher, checked by the second person (DB consumption ledger)
 * · start · bulk sample · a pass outside the QC limits refused, then passed · packaging issued · packing into quarantine
 * (DB lot in quarantine) · reconciliation balanced · finished-lot sample passed · the batch maker's QC release refused,
 * released by the third person (DB lot available) · closed with a cost sheet (DB, rates missing listed) · a duty that
 * would make a batch maker its QC releaser refused · a pack refused on a sales draft until Admin sets its GST
 * treatment (server message, then DB). axe on every Biochem screen, the factory manager phone home and the lab panel.
 */

async function alertWith(page: Page, re: RegExp) {
  await expect(page.getByRole('alert').filter({ hasText: re }).first()).toBeVisible({ timeout: 20_000 })
}
async function statusWith(page: Page, re: RegExp) {
  await expect(page.getByRole('status').filter({ hasText: re }).first()).toBeVisible({ timeout: 20_000 })
}

test.describe('Phase 5 · Biochem production', () => {
  test.skip(!hasCreds || !creds.staff.email || !creds.third.email, 'needs .env.test.local with admin, staff and third logins')

  test('Formula approved by another → licence block → batch through weighing check, lab, packing, reconciliation, QC release by a non-maker → close with cost · pack GST guard', async ({ page, browser }) => {
    test.setTimeout(900_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase5Company(page)
    const api = s.api
    const cid = s.companyId
    const tag = s.tag
    const q = `company=${cid}`
    const branchName = `E2E Test Factory ${tag}`

    // Items: two bulk materials (kg), a carton (Nos), the finished soap (Nos, 100 g), a gift pack item and a free tray.
    const matA = await addItem(s, { suffix: 'A', name: `E2E Test Soap Base ${tag}`, uom: 'KGS', kind: 'raw_material' })
    const matB = await addItem(s, { suffix: 'B', name: `E2E Test Glycerin ${tag}`, uom: 'KGS', kind: 'raw_material' })
    const carton = await addItem(s, { suffix: 'C', name: `E2E Test Carton ${tag}`, uom: 'NOS', kind: 'packaging' })
    const soap = await addItem(s, { suffix: 'F', name: `E2E Test Bath Bar ${tag}`, uom: 'NOS', kind: 'finished', netQty: 100, netQtyUom: 'GMS' })
    const giftItem = await addItem(s, { suffix: 'G', name: `E2E Test Gift Pack ${tag}`, uom: 'NOS', kind: 'finished' })
    const tray = await addItem(s, { suffix: 'Y', name: `E2E Test Tray ${tag}`, uom: 'NOS', kind: 'packaging' })
    await postOpening(s, s.stores.id, [
      { productId: matA.id, qty: '50', unitCost: '80', lotNo: `E2E-LOT-A${tag}` },
      { productId: matB.id, qty: '50', unitCost: '120', lotNo: `E2E-LOT-B${tag}` },
      { productId: carton.id, qty: '200', unitCost: '2' },
      { productId: tray.id, qty: '50', unitCost: '5' },
    ])

    // A licensed process family and a formula written by Admin (10 kg batch, 100 g per pack, pH limits on the bulk).
    const fam = await api.rpc<{ id: string }>('upsert_process_family', { p: { company_id: cid, code: `BAR${tag}`, name: `E2E Test Bars ${tag}`, licence_kind: 'cosmetics_manufacturing', steps: ['Weigh', 'Mix', 'Pack'] } })
    const formulaCode = `E2EF${tag}`
    const fv = await api.rpc<{ version_id: string }>('save_formula_version', {
      p: {
        company_id: cid,
        product_id: soap.id,
        family_id: fam.id,
        code: formulaCode,
        name: `E2E Test Formula ${tag}`,
        batch_size: '10',
        fill_qty_g: '100',
        qc_spec: [{ parameter: 'pH', min: 5, max: 9, unit: null, stage: 'bulk' }],
        lines: [
          { line_kind: 'bulk', product_id: matA.id, qty: '6' },
          { line_kind: 'bulk', product_id: matB.id, qty: '4' },
          { line_kind: 'packaging', product_id: carton.id, qty: '1' },
        ],
      },
    })

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

      // ── 1. Formula: Admin sends it, Admin's approval refused, the staff user approves ──
      await page.goto(`/production/biochem-manufacturing?${q}&tab=formulas`)
      await expect(page.getByRole('heading', { level: 1, name: 'Biochem manufacturing' })).toBeVisible()
      await page.getByRole('button', { name: `Details · ${formulaCode} v1` }).click()
      await page.getByRole('button', { name: 'Send for approval' }).click()
      await statusWith(page, /Sent for approval/)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Approve formula' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Approve formula' }).click()
      await alertWith(page, /Someone else must approve a formula you wrote or submitted/)
      type Ver = { status: string; approved_by?: string | null }
      let [ver] = await api.view<Ver>('formula_versions', `id=eq.${fv.version_id}&select=status`)
      expect(ver?.status).toBe('submitted')

      await staffPage.goto(`/production/biochem-manufacturing?${q}&tab=formulas`)
      await staffPage.getByRole('button', { name: `Details · ${formulaCode} v1` }).click()
      await staffPage.getByRole('button', { name: 'Approve formula' }).click()
      await staffPage.getByRole('dialog').getByRole('button', { name: 'Approve formula' }).click()
      await statusWith(staffPage, /Approved\. In force from/)
      ;[ver] = await api.view<Ver>('formula_versions', `id=eq.${fv.version_id}&select=status,approved_by`)
      expect(ver?.status).toBe('approved')
      expect(ver?.approved_by).toBe(people.staffId)

      // ── 2. Plan refused without a licence ──
      async function fillPlan() {
        await page.goto(`/production/biochem-production-entry?${q}`)
        await expect(page.getByRole('heading', { level: 1, name: 'Production entry · new batch' })).toBeVisible()
        await page.getByLabel('Product', { exact: true }).selectOption({ label: `${soap.code} · ${soap.name}` })
        await page.getByLabel('Production line (place)').selectOption({ label: `${s.line.name} · ${branchName}` })
        await page.getByLabel('Stores (materials from)').selectOption({ label: `${s.stores.name} · ${branchName}` })
        await page.getByLabel('Finished goods to (place)').selectOption({ label: `${s.fgHold.name} · ${branchName}` })
        await page.getByLabel('Bulk to make (kg)').fill('10')
        await page.getByRole('button', { name: 'Plan batch' }).click()
      }
      await fillPlan()
      await alertWith(page, /licence for this kind of product is not recorded/)
      await expect(page.getByRole('link', { name: 'Open Admin → Licences' })).toBeVisible()
      await expectNoSeriousA11y(page)
      expect(await api.view('batches', `company_id=eq.${cid}&select=id`)).toHaveLength(0)

      // ── 3. Admin adds a synthetic licence ──
      const licNo = `E2E-LIC-${tag}${rand4()}`
      await page.goto(`/admin/licences-and-documents?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Licences, certificates and documents' })).toBeVisible()
      await expect(page.getByTestId('lic-blocking')).toHaveText('1')
      await page.getByRole('button', { name: 'Add licence' }).click()
      const dlg = page.getByRole('dialog')
      await dlg.getByLabel('Number').fill(licNo)
      await dlg.getByLabel('Issued by').fill('E2E Test Authority')
      await dlg.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('cell', { name: licNo })).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('lic-blocking')).toHaveText('0')
      await expectNoSeriousA11y(page)
      const [lic] = await api.view<{ id: string; is_valid: boolean }>('licences', `company_id=eq.${cid}&licence_no=eq.${licNo}&select=id,is_valid`)
      expect(lic?.is_valid).toBe(true)

      // ── 4. Plan, reserve, weigh ──
      await fillPlan()
      await expect(page).toHaveURL(/batch=/, { timeout: 20_000 })
      const batchId = new URL(page.url()).searchParams.get('batch') ?? ''
      type B = { batch_no: string; status: string; licence_id: string; fg_lot_id: string | null }
      let [batch] = await api.view<B>('batches', `id=eq.${batchId}&select=batch_no,status,licence_id,fg_lot_id`)
      expect(batch?.status).toBe('planned')
      expect(batch?.licence_id).toBe(lic?.id)
      await expect(page.getByTestId('batch-licence')).toHaveText(licNo)
      const batchUrl = `/production/biochem-production-entry?${q}&batch=${batchId}`

      await page.getByRole('button', { name: 'Reserve materials' }).click()
      await statusWith(page, /Reserved 2 materials/)
      await page.getByLabel(`Weighed kg of ${matA.name}`).fill('6')
      await page.getByLabel(`Weighed kg of ${matB.name}`).fill('4')
      await page.getByRole('button', { name: 'Record weighing' }).click()
      await statusWith(page, /2 weighing\(s\) recorded/)
      await page.getByRole('button', { name: `Weight OK for ${matA.name}` }).click()
      await alertWith(page, /A second person must check the weighing you made/)
      await expectNoSeriousA11y(page)

      await staffPage.goto(batchUrl)
      await staffPage.getByRole('button', { name: `Weight OK for ${matA.name}` }).click()
      await statusWith(staffPage, /Checked\. Material issued from the stores/)
      await staffPage.getByRole('button', { name: `Weight OK for ${matB.name}` }).click()
      await expect(staffPage.getByTestId('batch-status')).toHaveText('Weighed and checked', { timeout: 20_000 })
      const cons = await api.view<{ kind: string; qty: number; product_id: string }>('material_consumption', `batch_id=eq.${batchId}&select=kind,qty,product_id`)
      expect(cons.filter((c) => c.kind === 'bulk_material')).toHaveLength(2)
      expect(cons.find((c) => c.product_id === matA.id)?.qty).toBe(6)
      expect(cons.find((c) => c.product_id === matB.id)?.qty).toBe(4)

      // ── 5. Start, bulk sample, lab: out of limits refused, then pass ──
      await page.goto(batchUrl)
      await page.getByRole('button', { name: 'Start batch' }).click()
      await statusWith(page, /Batch started/)
      await page.getByLabel('Bulk made (kg)').fill('10')
      await page.getByLabel('Labour hours so far').fill('2')
      await page.getByLabel('Machine hours so far').fill('1')
      await page.getByRole('button', { name: 'Send sample' }).click()
      await statusWith(page, /sent to the lab/)
      const [bulkSample] = await api.view<{ sample_no: string }>('lab_samples', `batch_id=eq.${batchId}&kind=eq.bulk&select=sample_no`)

      await page.goto(`/production/biochem-labs?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Labs · R&D and testing' })).toBeVisible()
      await page.getByRole('button', { name: `Open sample ${bulkSample?.sample_no ?? ''}` }).click()
      await page.getByLabel('pH', { exact: true }).fill('10')
      await page.getByRole('button', { name: 'Pass', exact: true }).click()
      await alertWith(page, /outside the approved limits/)
      await page.getByLabel('pH', { exact: true }).fill('7')
      await page.getByRole('button', { name: 'Pass', exact: true }).click()
      await statusWith(page, /Result saved: Pass/)
      await expectNoSeriousA11y(page)
      ;[batch] = await api.view<B>('batches', `id=eq.${batchId}&select=batch_no,status,licence_id,fg_lot_id`)
      expect(batch?.status).toBe('bulk_passed')

      // ── 6. Packaging, packing into quarantine, reconciliation ──
      await page.goto(batchUrl)
      await page.getByLabel(new RegExp(`${carton.name} · Nos to issue`)).fill('100')
      await page.getByRole('button', { name: 'Issue packaging' }).click()
      await statusWith(page, /packaging item\(s\) issued/)
      await page.getByLabel('Good packs').fill('95')
      await page.getByLabel('Rejected packs').fill('0')
      await page.getByLabel('Bulk scrapped (kg)').fill('0.3')
      await page.getByLabel('Bulk left (kg)').fill('0.2')
      await page.getByLabel(`${carton.name} scrapped`).fill('2')
      await page.getByLabel(`${carton.name} returned to stores`).fill('3')
      await page.getByLabel(`${carton.name} still at the line`).fill('0')
      await page.getByRole('button', { name: 'Record packing' }).click()
      await statusWith(page, /Packed into quarantine\. Reconciliation balanced/)
      ;[batch] = await api.view<B>('batches', `id=eq.${batchId}&select=batch_no,status,licence_id,fg_lot_id`)
      expect(batch?.status).toBe('packed_hold')
      type L = { status: string; qty_quarantine: number; qty_on_hand: number }
      let [lot] = await api.view<L>('lots', `id=eq.${batch?.fg_lot_id ?? ''}&select=status,qty_quarantine,qty_on_hand`)
      expect(lot?.status).toBe('quarantine')
      expect(Number(lot?.qty_quarantine)).toBe(95)
      await page.getByRole('button', { name: 'Reconcile', exact: true }).click()
      await expect(page.getByTestId('recon-result')).toContainText('Balanced.', { timeout: 20_000 })
      const [recon] = await api.view<{ recon_status: string }>('batches', `id=eq.${batchId}&select=recon_status`)
      expect(recon?.recon_status).toBe('balanced')

      // ── 7. Finished-lot sample passed; the maker's release refused; the third person releases ──
      await page.getByLabel('Sample', { exact: true }).selectOption('finished')
      await page.getByRole('button', { name: 'Send sample' }).click()
      await statusWith(page, /sent to the lab/)
      const [finSample] = await api.view<{ sample_no: string }>('lab_samples', `batch_id=eq.${batchId}&kind=eq.finished&select=sample_no`)
      await page.goto(`/production/biochem-labs?${q}`)
      await page.getByRole('button', { name: `Open sample ${finSample?.sample_no ?? ''}` }).click()
      await page.getByRole('button', { name: 'Pass', exact: true }).click()
      await statusWith(page, /Result saved: Pass/)

      await page.goto(batchUrl)
      await page.getByRole('button', { name: 'QC release', exact: true }).click()
      await alertWith(page, /You helped make this batch, so another QC person must decide on it/)
      ;[lot] = await api.view<L>('lots', `id=eq.${batch?.fg_lot_id ?? ''}&select=status,qty_quarantine,qty_on_hand`)
      expect(lot?.status).toBe('quarantine')

      await thirdPage.goto(batchUrl)
      await expect(thirdPage.getByTestId('batch-status')).toHaveText('Packed · on hold', { timeout: 20_000 })
      await thirdPage.waitForLoadState('networkidle')
      await thirdPage.getByRole('button', { name: 'QC release', exact: true }).click()
      await statusWith(thirdPage, /Released 95 packs for sale/)
      await expect(thirdPage.getByTestId('batch-status')).toHaveText('QC released', { timeout: 20_000 })
      ;[lot] = await api.view<L>('lots', `id=eq.${batch?.fg_lot_id ?? ''}&select=status,qty_quarantine,qty_on_hand`)
      expect(lot?.status).toBe('available')
      expect(Number(lot?.qty_on_hand)).toBe(95)

      // ── 8. Admin sets labour and machine rates on Biochem costing (overhead left unset), then closes: the missing rate is listed, never invented ──
      await page.goto(`/production/biochem-costing?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Biochem product costing' })).toBeVisible()
      await expect(page.getByTestId('rates-missing')).toContainText(batch?.batch_no ?? '')
      for (const [kind, rate] of [
        ['labour_hour', '100'],
        ['machine_hour', '50'],
      ] as const) {
        await page.getByLabel('Rate', { exact: true }).selectOption(kind)
        await page.getByLabel('Rate (₹)').fill(rate)
        await page.getByRole('button', { name: 'Set rate' }).click()
        await expect.poll(async () => (await api.view('cost_rates', `company_id=eq.${cid}&kind=eq.${kind}&select=id`)).length, { timeout: 20_000 }).toBe(1)
      }
      await page.goto(batchUrl)
      await page.getByRole('button', { name: 'Close batch' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Close batch' }).click()
      await expect(page.getByTestId('close-cost')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('close-cost')).toContainText('Overhead per kg of bulk')
      const [cost] = await api.view<{ final: boolean; total: number; materials: number; good_packs: number; cost_per_pack: number; rates_missing: string[] }>('batch_costs', `batch_id=eq.${batchId}&select=final,total,materials,good_packs,cost_per_pack,rates_missing`)
      expect(cost?.final).toBe(true)
      expect(Number(cost?.materials)).toBe(960)
      expect(Number(cost?.good_packs)).toBe(95)
      // materials 6×80 + 4×120; packaging (95 used + 2 scrapped) × 2; labour 2 h × 100; machine 1 h × 50; overhead unset (0, listed)
      expect(Number(cost?.total)).toBe(1404)
      expect(Number(cost?.cost_per_pack)).toBe(14.7789)
      expect(cost?.rates_missing).toEqual(['overhead_per_kg'])
      ;[batch] = await api.view<B>('batches', `id=eq.${batchId}&select=batch_no,status,licence_id,fg_lot_id`)
      expect(batch?.status).toBe('closed')
      await expectNoSeriousA11y(page)

      // ── 9. Work assignment: a batch maker can't be its QC releaser ──
      await page.goto(`/production/factory-work-assignment?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Factory work · who does what today' })).toBeVisible()
      await page.getByLabel('Person', { exact: true }).selectOption(people.staffId)
      await page.getByLabel('Duty', { exact: true }).selectOption('qc_releaser')
      // The closed batch is not in the open list; use the API for the conflict on it, the screen for a clean duty.
      await page.getByLabel('Duty', { exact: true }).selectOption('supervisor')
      await page.getByRole('button', { name: 'Assign', exact: true }).click()
      await statusWith(page, /Duty assigned/)
      await expectNoSeriousA11y(page)
      const conflict = await api.rpc('assign_shift_duties', { p: { company_id: cid, work_date: todayIst(), shift: 'day', assignments: [{ user_id: people.staffId, duty: 'qc_releaser', batch_id: batchId }] } }).then(
        () => '',
        (e: Error) => e.message,
      )
      expect(conflict).toContain('sod.self_release')

      // ── 10. Pack refused on a sales draft until Admin sets its GST treatment ──
      const pack = await api.rpc<{ id: string }>('upsert_pack', { p: { company_id: cid, product_id: giftItem.id, kind: 'gift_pack', name: `E2E Test Gift ${tag}`, items: [{ product_id: soap.id, qty: '3' }, { product_id: tray.id, qty: '1', is_free: true }] } })
      const customer = await addCustomer(s)
      const draft = { p: { company_id: cid, gstin_id: s.gstinId, doc_type: 'sales_invoice', doc_date: todayIst(), party_id: customer.id, lines: [{ product_id: giftItem.id, qty: '2', rate: '150', discount: '0' }] } }
      const refused = await api.rpc('save_sales_draft', draft).then(
        () => '',
        (e: Error) => e.message,
      )
      expect(refused).toContain('pack.gst_treatment_unset')
      expect(refused).toContain('GST treatment of this pack is not set')

      await page.goto(`/production/free-items-and-gift-packs?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Free items and gift packs' })).toBeVisible()
      await page.getByRole('button', { name: `Open pack E2E Test Gift ${tag}` }).click()
      await expect(page.getByTestId('pack-gst')).toContainText("Can't be billed yet")
      await expectNoSeriousA11y(page)
      await page.getByLabel("CA's advice (reference and date)").fill(`E2E test CA note ${tag}`)
      await page.getByRole('button', { name: 'Set GST treatment' }).click()
      await statusWith(page, /GST treatment set/)
      const [pk] = await api.view<{ gst_treatment: string | null }>('packs', `id=eq.${pack.id}&select=gst_treatment`)
      expect(pk?.gst_treatment).toBe('free_with_sale_single_price')
      const ok = await api.rpc<{ id: string }>('save_sales_draft', draft)
      const [doc] = await api.view<{ status: string }>('sales_documents', `id=eq.${ok.id}&select=status`)
      expect(doc?.status).toBe('draft')

      // ── 11. axe on the remaining Biochem screens, the phone home and the lab panel ──
      for (const [path, h1] of [
        [`/production/biochem-production-flow?${q}`, 'Production flow · Biochem'],
        [`/production/biochem-machines?${q}`, 'Machines and assets · Biochem'],
        [`/production/biochem-manufacturing?${q}&tab=families`, 'Biochem manufacturing'],
        [`/production/biochem-manufacturing?${q}&tab=batches`, 'Biochem manufacturing'],
        [`/production/biochem-labs?${q}&tab=rnd`, 'Labs · R&D and testing'],
        [`/production/biochem-labs?${q}&tab=instruments`, 'Labs · R&D and testing'],
        [`/production/biochem-production-entry?${q}`, 'Production entry · new batch'],
      ] as const) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible()
        await expectNoSeriousA11y(page)
      }

      await page.goto(`/production/biochem-costing?${q}`)
      await expect(page.getByTestId('rates-missing')).toContainText(batch?.batch_no ?? '')
      await expect(page.getByTestId('rates-missing')).toContainText('Overhead per kg of bulk')
      await expectNoSeriousA11y(page)

      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`/me/factory-manager?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Factory manager home' })).toBeAttached()
      await expect(page.getByTestId('fh-open')).toHaveText('0', { timeout: 20_000 })
      await expectNoSeriousA11y(page)
      await page.setViewportSize({ width: 820, height: 1180 })
      await page.goto(`/lab?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Lab panel' })).toBeAttached()
      await expect(page.getByRole('tab', { name: /Today/ })).toBeVisible()
      await expectNoSeriousA11y(page)
      await thirdPage.goto(`/lab?${q}`)
      await expect(thirdPage.getByRole('heading', { level: 1, name: 'Lab panel' })).toBeAttached()
      await expectNoSeriousA11y(thirdPage)
    } finally {
      await people.cleanup()
      await staffCtx.close()
      await thirdCtx.close()
    }
  })
})
