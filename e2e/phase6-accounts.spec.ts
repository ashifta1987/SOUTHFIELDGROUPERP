import { expect, test, type Locator, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4, randomPan, syntheticGstin } from './phase2-parties-helpers'
import { createPhase4Company, postBill, todayIst } from './phase4-setup'
import { addItem, userIdByEmail } from './phase5-setup'

/**
 * Phase 6 accounts, GST and messaging screens against the DEV database, on a fresh synthetic company (E2EK####):
 * a B2B and a B2C invoice and a purchase bill are posted through the RPCs; the GST page shows the same totals as
 * api.gstr1_summary / gstr3b_summary / itc_register; Schedule III mapping is set and the CA's confirmation recorded
 * (rows asserted) with the balance check shown; the trial balance balances and drills into a ledger and a statement;
 * on WhatsApp & email a cost cap is set (row asserted), a reminder run queues a reminder only for the consented contact
 * (outbox rows asserted) and a received payment proof becomes a task that Admin closes (row asserted). axe on every
 * screen and tab. Every value is synthetic.
 */

const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmt = (v: unknown) => nf.format(Number(v ?? 0))
function monthRange(iso: string) {
  const [y, m] = iso.split('-').map(Number)
  const last = new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate()
  const month = iso.slice(0, 7)
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}
async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 })
}
async function expectRowHas(row: Locator, values: unknown[]) {
  for (const v of values) await expect(row).toContainText(fmt(v))
}

type Heads = { taxable: number; cgst: number; sgst: number; igst: number; total?: number }

test.describe('Phase 6 · accounts, GST, Schedule III and WhatsApp', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('GST returns match the server, Schedule III is mapped and confirmed, reminders and inbox tasks work', async ({ page }) => {
    test.setTimeout(360_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase4Company(page)
    const api = s.api
    const companyId = s.companyId
    const tag = s.code.slice(4)
    const today = todayIst()
    const { from, to } = monthRange(today)
    const adminId = await userIdByEmail(api, creds.admin.email)

    // ── Books for sales on the fresh company ──
    await api.rpc('upsert_doc_series', { p: { company_id: companyId, gstin_id: s.gstinId, doc_type: 'sales_invoice', fy_id: s.fyId, prefix: 'ESI', pad: 4, next_no: 1 } })
    const groups = await api.view<{ id: string; name: string }>('account_groups', `company_id=eq.${companyId}&select=id,name`)
    const gDuties = groups.find((g) => g.name === 'E2E Test Duties and Taxes')?.id
    const gSales = (await api.rpc<{ id: string }>('upsert_account_group', { p: { company_id: companyId, name: 'E2E Test Sales', nature: 'income', is_party_group: null } })).id
    const acc = async (name: string, groupId: string | undefined) => (await api.rpc<{ id: string }>('upsert_account', { p: { company_id: companyId, group_id: groupId, name } })).id
    const salesAccountName = 'E2E Test Sales Account'
    for (const [event, id] of [
      ['sales.taxable', await acc(salesAccountName, gSales)],
      ['gst.output_cgst', await acc('E2E Test Output CGST', gDuties)],
      ['gst.output_sgst', await acc('E2E Test Output SGST', gDuties)],
      ['gst.output_igst', await acc('E2E Test Output IGST', gDuties)],
    ] as const) {
      await api.rpc('set_posting_rule', { p_company_id: companyId, p_event: event, p_account_id: id, p_note: 'E2E test' })
    }
    const product = await addItem(s, { suffix: 'F', name: `E2E Test Soap ${tag}`, uom: 'NOS', kind: 'finished' })

    // A registered customer whose contact agreed to WhatsApp, and an unregistered one whose contact did not.
    const b2bDigits = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
    const b2cDigits = `8${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
    const b2bName = `E2E Test B2B Buyer ${tag}${rand4()}`
    const b2cName = `E2E Test B2C Buyer ${tag}${rand4()}`
    const b2bGstin = syntheticGstin(randomPan(), '32')
    const b2b = await api.rpc<{ id: string }>('upsert_party', {
      p: { company_id: companyId, legal_name: b2bName, is_customer: true, customer_type: 'wholesale', gst_status: 'registered', gstin: b2bGstin, state_code: '32', address: 'E2E Test Road', city: 'Thrissur', pincode: '680001', whatsapp: `+91${b2bDigits}`, whatsapp_consent: true, contact_name: 'E2E Test Contact', force: true },
    })
    const b2c = await api.rpc<{ id: string }>('upsert_party', {
      p: { company_id: companyId, legal_name: b2cName, is_customer: true, customer_type: 'retail_shop', state_code: '32', address: 'E2E Test Road', city: 'Thrissur', pincode: '680001', whatsapp: `+91${b2cDigits}`, whatsapp_consent: false, contact_name: 'E2E Test Contact', force: true },
    })
    for (const id of [b2b.id, b2c.id]) await api.rpc('set_party_kyc', { p_party_id: id, p_status: 'verified', p_note: 'E2E test' })

    // ── A B2B and a B2C invoice, and a purchase bill ──
    const docNos: string[] = []
    for (const [partyId, qty, rate] of [
      [b2b.id, '2', '100'],
      [b2c.id, '1', '300'],
    ] as const) {
      const d = await api.rpc<{ id: string }>('save_sales_draft', { p: { company_id: companyId, gstin_id: s.gstinId, doc_type: 'sales_invoice', doc_date: today, party_id: partyId, lines: [{ product_id: product.id, qty, rate, discount: '0' }] } })
      docNos.push((await api.rpc<{ doc_no: string }>('post_sales_document', { p_document_id: d.id })).doc_no)
    }
    const billNo = `E2E-${tag}-P1`
    await postBill(s, { supplierId: s.suppliers.consented.id, productId: s.items.plain.id, qty: '3', rate: '50', billNo })

    // ── GST page = server summaries ──
    const g1 = await api.rpc<{ totals: Heads & { total: number }; b2b: (Heads & { party_gstin: string })[]; b2cs: (Heads & { pos: string })[]; all_supplies: boolean }>('gstr1_summary', { p_company_id: companyId, p_gstin_id: null, p_from: from, p_to: to }, false)
    const g3 = await api.rpc<{ outward_taxable: Heads; itc_available: Heads & { bills: number } }>('gstr3b_summary', { p_company_id: companyId, p_gstin_id: null, p_from: from, p_to: to }, false)
    const itc = await api.rpc<{ supplier_bill_no: string; itc: number; taxable: number }[]>('itc_register', { p_company_id: companyId, p_from: from, p_to: to }, false)
    expect(g1.b2b).toHaveLength(1)
    expect(g1.b2cs.length).toBeGreaterThan(0)
    expect(itc).toHaveLength(1)

    await page.goto(`/accounts/gst?company=${companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: /^GST · / })).toBeVisible()
    await settled(page)
    const totals = page.getByRole('region', { name: 'GSTR-1 totals', exact: true }).getByRole('row').nth(1)
    await expectRowHas(totals, [g1.totals.taxable, g1.totals.cgst, g1.totals.sgst, g1.totals.igst, g1.totals.total])
    const b2bRow = page.getByRole('region', { name: 'B2B · registered buyers' }).getByRole('row').filter({ hasText: b2bGstin })
    await expectRowHas(b2bRow, [g1.b2b[0]?.taxable, g1.b2b[0]?.cgst, g1.b2b[0]?.sgst, g1.b2b[0]?.total])
    const b2csRow = page.getByRole('region', { name: 'B2C small · by place of supply and rate' }).getByRole('row').nth(1)
    await expectRowHas(b2csRow, [g1.b2cs[0]?.taxable, g1.b2cs[0]?.cgst, g1.b2cs[0]?.sgst])
    await expect(page.getByRole('region', { name: 'GST this month' })).toContainText(`₹${fmt(g1.totals.taxable)}`)
    // Admin sees the separate card for bills without GST.
    expect(g1.all_supplies).toBe(true)
    await expect(page.getByRole('heading', { name: 'Bills without GST in the returns' })).toBeVisible()
    await expectNoSeriousA11y(page)

    await page.getByRole('tab', { name: 'GSTR-3B' }).click()
    await settled(page)
    const r3b = page.getByRole('region', { name: 'GSTR-3B summary' })
    await expectRowHas(r3b.getByRole('row').filter({ hasText: '3.1(a)' }), [g3.outward_taxable.taxable, g3.outward_taxable.cgst, g3.outward_taxable.sgst])
    await expectRowHas(r3b.getByRole('row').filter({ hasText: '4(A)' }), [g3.itc_available.cgst, g3.itc_available.sgst])
    await expectNoSeriousA11y(page)

    await page.getByRole('tab', { name: 'ITC register' }).click()
    await settled(page)
    const itcRegion = page.getByRole('region', { name: 'Purchase bills · input tax credit' })
    await expectRowHas(itcRegion.getByRole('row').filter({ hasText: billNo }), [itc[0]?.taxable, itc[0]?.itc])
    await expect(itcRegion.getByRole('row').filter({ hasText: 'Credit this month' })).toContainText(fmt(itc[0]?.itc))
    await expectNoSeriousA11y(page)

    // ── Schedule III: map two groups, record the CA's confirmation, balance check ──
    await page.goto(`/accounts/schedule-iii-statements?company=${companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: /Financial statements · Schedule III/ })).toBeVisible()
    await settled(page)
    await page.getByLabel('Line for E2E Test Debtors').selectOption({ label: 'Current assets · Trade receivables' })
    await expect
      .poll(async () => (await api.view<{ line_code: string | null }>('schedule3_map', `company_id=eq.${companyId}&group_name=eq.E2E%20Test%20Debtors&select=line_code`))[0]?.line_code, { timeout: 15_000 })
      .toBe('trade_receivables')
    await settled(page)
    await page.getByLabel('Line for E2E Test Sales').selectOption({ label: 'Revenue from operations' })
    await expect
      .poll(async () => (await api.view<{ line_code: string | null }>('schedule3_map', `company_id=eq.${companyId}&group_name=eq.E2E%20Test%20Sales&select=line_code`))[0]?.line_code, { timeout: 15_000 })
      .toBe('revenue_operations')
    await page.getByRole('button', { name: 'Record CA confirmation' }).click()
    const confirmDialog = page.getByRole('dialog', { name: "Record the CA's confirmation" })
    await confirmDialog.getByLabel("CA's note (who confirmed it and how)").fill('E2E Test: CA confirmed the mapping by email')
    await expectNoSeriousA11y(page)
    await confirmDialog.getByRole('button', { name: 'Record confirmation' }).click()
    await expect(confirmDialog).toBeHidden({ timeout: 15_000 })
    const mapRows = await api.view<{ line_code: string | null; ca_confirmed: boolean; ca_note: string | null }>('schedule3_map', `company_id=eq.${companyId}&line_code=not.is.null&select=line_code,ca_confirmed,ca_note`)
    expect(mapRows).toHaveLength(2)
    expect(mapRows.every((r) => r.ca_confirmed && r.ca_note === 'E2E Test: CA confirmed the mapping by email')).toBe(true)
    const s3 = await api.rpc<{ totals: { assets: number; equity_liabilities: number; difference: number }; mapping_confirmed_by_ca: boolean; balance_sheet: { code: string; amount: number }[] }>(
      'schedule3_statements',
      { p_company_id: companyId, p_from: fyStart(today), p_to: today },
      false,
    )
    expect(Number(s3.totals.difference)).toBe(0)
    expect(s3.mapping_confirmed_by_ca).toBe(true)
    const check = page.getByRole('status', { name: 'Balance check' })
    await expect(check).toContainText('Balanced · assets equal equity and liabilities', { timeout: 15_000 })
    await expect(check).toContainText(`₹${fmt(s3.totals.assets)}`)
    await expect(check).toContainText('Mapping confirmed by the CA')
    const receivables = s3.balance_sheet.find((l) => l.code === 'trade_receivables')
    await expect(page.getByRole('row').filter({ hasText: 'Trade receivables' }).first()).toContainText(fmt(receivables?.amount))
    await expectNoSeriousA11y(page)

    // ── Financials: trial balance balanced, ledger drill-down, statement of account ──
    const tb = await api.rpc<{ closing: number }[]>('trial_balance', { p_company_id: companyId, p_from: fyStart(today), p_to: today }, false)
    expect(Math.round(tb.reduce((sum, r) => sum + Number(r.closing) * 100, 0))).toBe(0)
    await page.goto(`/accounts/financials?company=${companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Financials' })).toBeVisible()
    await settled(page)
    await expect(page.getByText('Balanced · debits equal credits')).toBeVisible({ timeout: 15_000 })
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: salesAccountName, exact: true }).click()
    await settled(page)
    await expect(page.getByRole('heading', { name: `Ledger · ${salesAccountName}` })).toBeVisible()
    for (const no of docNos) await expect(page.getByRole('row').filter({ hasText: no })).toBeVisible()
    await expectNoSeriousA11y(page)
    await page.getByRole('tab', { name: 'Statement of account' }).click()
    await page.getByLabel('Customer or supplier').selectOption({ label: b2bName })
    await settled(page)
    await expect(page.getByRole('row').filter({ hasText: docNos[0] ?? '' })).toBeVisible({ timeout: 15_000 })
    await expectNoSeriousA11y(page)

    // ── WhatsApp & email: cost cap, reminders, inbox task ──
    await page.goto('/admin/whatsapp-and-email')
    await expect(page.getByRole('heading', { level: 1, name: 'WhatsApp, SMS and email' })).toBeVisible()
    await page.getByRole('tab', { name: 'Cost caps' }).click()
    await settled(page)
    const capForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save cap' }) })
    await capForm.getByLabel('Company').selectOption({ label: s.shortName })
    await capForm.getByLabel('Monthly cap').fill('5000')
    await capForm.getByLabel('Alert at (%)').fill('80')
    await capForm.getByRole('button', { name: 'Save cap' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Cap saved' })).toBeVisible({ timeout: 15_000 })
    const [capRow] = await api.view<{ monthly_cap: number; alert_pct: number }>('msg_cost_caps', `company_id=eq.${companyId}&select=monthly_cap,alert_pct`)
    expect(Number(capRow?.monthly_cap)).toBe(5000)
    expect(Number(capRow?.alert_pct)).toBe(80)
    await expectNoSeriousA11y(page)

    await page.getByRole('tab', { name: 'Payment reminders' }).click()
    await settled(page)
    await expect(page.getByText(/on the due date/).first()).toBeVisible()
    const runForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Run now' }) })
    await runForm.getByLabel('Company').selectOption({ label: s.shortName })
    await runForm.getByLabel('For date').fill(today)
    await runForm.getByRole('button', { name: 'Run now' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Queued 1 · skipped 1' })).toBeVisible({ timeout: 15_000 })
    const reminders = await api.view<{ party_id: string; status: string; skip_reason: string | null }>('msg_outbox', `company_id=eq.${companyId}&event=eq.sales.payment_reminder&select=party_id,status,skip_reason`)
    expect(reminders.filter((r) => r.status === 'queued').map((r) => r.party_id)).toEqual([b2b.id])
    expect(reminders.find((r) => r.party_id === b2c.id)).toMatchObject({ status: 'skipped', skip_reason: 'no consent recorded' })
    await expectNoSeriousA11y(page)

    await page.getByRole('tab', { name: 'Inbox tasks' }).click()
    await settled(page)
    const recForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Record message' }) })
    await recForm.getByLabel('Company').selectOption({ label: s.shortName })
    await recForm.getByLabel("From (customer's number)").fill(b2bDigits)
    await recForm.getByLabel('Message type').selectOption('image')
    await recForm.getByLabel('Message text').fill('E2E Test payment screenshot')
    await recForm.getByRole('button', { name: 'Record message' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Recorded · task created: Payment proof' })).toBeVisible({ timeout: 15_000 })
    const [task] = await api.view<{ id: string; kind: string; status: string; priority: string }>('msg_tasks', `party_id=eq.${b2b.id}&select=id,kind,status,priority`)
    expect(task).toMatchObject({ kind: 'payment_proof', status: 'open', priority: 'urgent' })
    await settled(page)
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: `Mark done: ${b2bName}` }).click()
    const doneDialog = page.getByRole('dialog', { name: 'Mark the task done' })
    await doneDialog.getByLabel('Note (optional)').fill('E2E Test: payment seen in the bank')
    await doneDialog.getByRole('button', { name: 'Mark done' }).click()
    await expect(doneDialog).toBeHidden({ timeout: 15_000 })
    const [closed] = await api.view<{ status: string; resolved_by: string; note: string }>('msg_tasks', `id=eq.${task?.id}&select=status,resolved_by,note`)
    expect(closed).toEqual({ status: 'done', resolved_by: adminId, note: 'E2E Test: payment seen in the bank' })
  })
})

function fyStart(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return `${(m ?? 1) >= 4 ? y : (y ?? 2000) - 1}-04-01`
}
