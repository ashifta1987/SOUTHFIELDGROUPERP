import { readFileSync, existsSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { restAsSignedInUser } from './phase3-sales-setup'
import { ddmmyyyy, todayIst } from './phase4-setup'
import { addItem, createPhase5Company, givePeople, postOpening } from './phase5-setup'

/**
 * Phase 7 · operations and accounts screens against the DEV database, on a fresh synthetic company (E2EK####), with the
 * synthetic staff user given the investor and finance-head roles for this company for one hour:
 * job-work challan issued (DB order + posted delivery challan + job_work_out ledger rows) and partly received (balance on
 * screen = DB) · repair request raised as a breakdown → spares issued (DB issue ledger row) → closed with the downtime
 * the server computed (DB) · licence document uploaded (storage object + DB row) and a renewal recorded (DB) ·
 * depreciation refused with the missing-setting message (no run in the DB) · a partner request from the investor decided
 * by Admin (DB) and Admin's own request refused (DB unchanged) · month-end checklist opened, a task done by Admin and
 * checked by the staff user (Admin's own check refused; DB), the month closed (DB), a posting into it refused with the
 * message, and Admin reopens it with a reason (DB) · axe on every screen. Every value is synthetic.
 */

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const f of ['.env.local', '.env.test.local']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && m[1]) env[m[1]] = (m[2] ?? '').trim()
    }
  }
  return env
}
async function accessToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'))
    const raw = k ? localStorage.getItem(k) : null
    return raw ? (JSON.parse(raw) as { access_token: string }).access_token : ''
  })
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function prevMonthStart(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 2, 1)).toISOString().slice(0, 10)
}
function monthName(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)))
}
/** "YYYY-MM-DDTHH:mm" in the browser's local time, minutes ago. */
function localMinutesAgo(min: number): string {
  const d = new Date(Date.now() - min * 60_000)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}
async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 })
}
async function alertWith(page: Page, re: RegExp) {
  await expect(page.getByRole('alert').filter({ hasText: re }).first()).toBeVisible({ timeout: 20_000 })
}

test.describe('Phase 7 · operations and accounts', () => {
  test.skip(!hasCreds || !creds.staff.email, 'needs .env.test.local with admin and staff logins')

  test('Job work · maintenance · licences · depreciation guard · partner requests · month-end close', async ({ page, browser }) => {
    test.setTimeout(900_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase5Company(page)
    const api = s.api
    const cid = s.companyId
    const tag = s.tag
    const q = `company=${cid}`
    const today = todayIst()
    const branchName = `E2E Test Factory ${tag}`
    const storesLabel = `${s.stores.name} · ${branchName}`

    // Set-up: a challan series for the GSTIN, an item to send for job work, spares in the stores, a machine.
    await api.rpc('upsert_doc_series', { p: { company_id: cid, gstin_id: s.gstinId, doc_type: 'delivery_challan', fy_id: s.fyId, prefix: 'DC', pad: 4, next_no: 1 } })
    const blank = await addItem(s, { suffix: 'JB', name: `E2E Test Barrel Blank ${tag}`, uom: 'NOS', kind: 'component' })
    await postOpening(s, s.stores.id, [
      { productId: blank.id, qty: '10', unitCost: '200' },
      { productId: s.items.plain.id, qty: '5', unitCost: '80' },
    ])
    const machCode = `E2EMC${tag}`.toUpperCase()
    const machName = `E2E Test Press ${tag}`
    await api.rpc('upsert_asset', { p: { company_id: cid, code: machCode, name: machName, kind: 'injection_machine', place_id: s.line.id } })

    const people = await givePeople(s, { staff: ['investor', 'finance_head'] })
    const users = await api.rpc<{ user_id: string; display_name: string }[]>('list_users', {}, false)
    const staffName = users.find((u) => u.user_id === people.staffId)?.display_name ?? ''
    const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const staffPage = await staffCtx.newPage()
    try {
      // ── 1. Job work: challan issued (DB order, challan, stock moved), then part received (balance = DB) ──
      await page.goto(`/production/job-work?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Job work' })).toBeVisible()
      await settled(page)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'New job-work challan' }).click()
      let dlg = page.getByRole('dialog')
      await dlg.getByLabel('Job worker').selectOption({ label: s.suppliers.other.name })
      await dlg.getByLabel('Process', { exact: true }).fill('E2E Test machining')
      await dlg.getByLabel('Kind of goods').selectOption('inputs')
      await dlg.getByLabel('Send from').selectOption({ label: storesLabel })
      await dlg.getByLabel('Item 1', { exact: true }).selectOption({ label: `${blank.code} · ${blank.name}` })
      await dlg.getByLabel('Quantity 1', { exact: true }).fill('6')
      await expectNoSeriousA11y(page)
      await dlg.getByRole('button', { name: 'Issue challan' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      type JW = { id: string; doc_no: string; challan_no: string | null; challan_document_id: string | null; status: string; return_by: string | null; jw_place_id: string }
      const [jw] = await api.view<JW>('v_job_work_orders', `company_id=eq.${cid}&select=id,doc_no,challan_no,challan_document_id,status,return_by,jw_place_id`)
      expect(jw?.status).toBe('sent')
      expect(jw?.challan_no).toBeTruthy()
      expect(jw?.return_by).toBe(`${Number(today.slice(0, 4)) + 1}${today.slice(4)}`)
      const [challan] = await api.view<{ doc_type: string; status: string; doc_no: string }>('sales_documents', `id=eq.${jw?.challan_document_id}&select=doc_type,status,doc_no`)
      expect(challan).toMatchObject({ doc_type: 'delivery_challan', status: 'posted', doc_no: jw?.challan_no })
      const outMoves = await api.view<{ place_id: string; qty: number }>('stock_movements', `company_id=eq.${cid}&move_type=eq.job_work_out&product_id=eq.${blank.id}&select=place_id,qty`)
      expect(outMoves.find((m) => m.place_id === s.stores.id)?.qty).toBe(-6)
      expect(outMoves.find((m) => m.place_id === jw?.jw_place_id)?.qty).toBe(6)
      await expect(page.getByRole('cell', { name: new RegExp(jw?.doc_no ?? 'x') })).toBeVisible()

      await page.getByRole('button', { name: `Open job work ${jw?.doc_no}` }).click()
      await page.getByRole('button', { name: 'Record goods back' }).click()
      dlg = page.getByRole('dialog')
      await expect(dlg.getByLabel('What came back, line 1')).toHaveValue('returned')
      await dlg.getByLabel('Quantity back, line 1').fill('4')
      await expectNoSeriousA11y(page)
      await dlg.getByRole('button', { name: 'Record goods back' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      const [line] = await api.view<{ balance: number; qty_settled: number }>('v_job_work_lines', `order_id=eq.${jw?.id}&select=balance,qty_settled`)
      expect(Number(line?.balance)).toBe(2)
      await expect(page.getByTestId('jw-balance-1')).toHaveAttribute('data-value', String(line?.balance), { timeout: 20_000 })
      await expect(page.getByTestId('jw-status')).toHaveText('Part received')
      const [jw2] = await api.view<{ status: string }>('v_job_work_orders', `id=eq.${jw?.id}&select=status`)
      expect(jw2?.status).toBe('part_received')
      await expectNoSeriousA11y(page)

      // ── 2. Maintenance: breakdown → spares issued (DB ledger) → closed with downtime (DB) ──
      const fault = `E2E Test hydraulic leak ${tag}`
      await page.goto(`/production/maintenance?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Machine care and maintenance' })).toBeVisible()
      await settled(page)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Report breakdown' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('Machine', { exact: true }).selectOption({ label: `${machCode} · ${machName}` })
      await dlg.getByLabel('What is wrong').fill(fault)
      await expect(dlg.getByLabel('The machine has stopped (breakdown)')).toBeChecked()
      await dlg.getByLabel('Broke down at').fill(localMinutesAgo(125))
      await expectNoSeriousA11y(page)
      await dlg.getByRole('button', { name: 'Raise repair request' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      type RR = { id: string; doc_no: string; status: string; is_breakdown: boolean; downtime_minutes: number | null }
      let [rr] = await api.view<RR>('v_repair_requests', `company_id=eq.${cid}&select=id,doc_no,status,is_breakdown,downtime_minutes`)
      expect(rr).toMatchObject({ status: 'new', is_breakdown: true })
      const [asset] = await api.view<{ status: string }>('assets', `company_id=eq.${cid}&code=eq.${machCode}&select=status`)
      expect(asset?.status).toBe('repair')
      await page.getByRole('button', { name: new RegExp(fault) }).click()
      await page.getByRole('button', { name: 'Issue spares' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('From stores').selectOption({ label: storesLabel })
      await dlg.getByLabel('Item 1', { exact: true }).selectOption({ label: `${s.items.plain.code} · ${s.items.plain.name}` })
      await dlg.getByLabel('Quantity 1', { exact: true }).fill('2')
      await dlg.getByRole('button', { name: 'Issue spares' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      const [sp] = await api.view<{ doc_no: string; qty: number }>('v_spares_issues', `repair_request_id=eq.${rr?.id}&select=doc_no,qty`)
      expect(Number(sp?.qty)).toBe(2)
      const issueMoves = await api.view<{ qty: number; place_id: string }>('stock_movements', `company_id=eq.${cid}&move_type=eq.issue&doc_no=eq.${encodeURIComponent(sp?.doc_no ?? '')}&select=qty,place_id`)
      expect(issueMoves).toHaveLength(1)
      expect(issueMoves[0]).toMatchObject({ qty: -2, place_id: s.stores.id })
      await expect(page.getByRole('cell', { name: sp?.doc_no ?? 'x' })).toBeVisible({ timeout: 20_000 })

      await page.getByRole('button', { name: 'Done · running again' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('What was done').fill('E2E Test seal replaced')
      await dlg.getByRole('button', { name: 'Close request' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      ;[rr] = await api.view<RR>('v_repair_requests', `id=eq.${rr?.id}&select=id,doc_no,status,is_breakdown,downtime_minutes`)
      expect(rr?.status).toBe('done')
      expect(Number(rr?.downtime_minutes)).toBeGreaterThanOrEqual(124)
      await expect(page.getByTestId('mt-downtime')).toHaveAttribute('data-value', String(rr?.downtime_minutes), { timeout: 20_000 })
      await expect(page.getByTestId('mt-status')).toHaveText('Done')
      const [asset2] = await api.view<{ status: string }>('assets', `company_id=eq.${cid}&code=eq.${machCode}&select=status`)
      expect(asset2?.status).toBe('active')
      await expectNoSeriousA11y(page)

      // ── 3. Licence: document uploaded (storage object + DB row), renewal recorded (DB) ──
      const licNo = `E2E-LIC-${tag}${rand4()}`
      const firstTo = addDays(today, 20)
      const lic = await api.rpc<{ id: string }>('upsert_licence', { p: { company_id: cid, kind: 'fire', licence_no: licNo, issued_by: 'E2E Test Authority', valid_from: today, valid_to: firstTo } })
      await page.goto(`/admin/licences-and-documents?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Licences, certificates and documents' })).toBeVisible()
      await settled(page)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: `Open Fire NOC ${licNo}` }).click()
      await page.getByRole('button', { name: 'Add document' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('File', { exact: true }).setInputFiles({ name: 'e2e-test-licence.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% E2E test file, synthetic\n') })
      await expectNoSeriousA11y(page)
      await dlg.getByRole('button', { name: 'Upload' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      const [doc] = await api.view<{ path: string; kind: string }>('v_licence_documents', `licence_id=eq.${lic.id}&select=path,kind`)
      expect(doc?.kind).toBe('licence_copy')
      expect(doc?.path.startsWith(`${cid}/licences/`)).toBe(true)
      const env = readEnv()
      const token = await accessToken(page)
      const obj = await fetch(`${env.VITE_SUPABASE_URL}/storage/v1/object/authenticated/documents/${doc?.path}`, { headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '', Authorization: `Bearer ${token}` } })
      expect(obj.status).toBe(200)
      expect(await obj.text()).toContain('E2E test file')
      await expect(page.getByRole('button', { name: /^Open Licence copy uploaded/ })).toBeVisible({ timeout: 20_000 })

      const newTo = addDays(today, 400)
      await page.getByRole('button', { name: 'Renew', exact: true }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('New valid until').fill(newTo)
      await dlg.getByRole('button', { name: 'Record renewal' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      const [ren] = await api.view<{ old_valid_to: string; new_valid_to: string }>('v_licence_renewals', `licence_id=eq.${lic.id}&select=old_valid_to,new_valid_to`)
      expect(ren).toMatchObject({ old_valid_to: firstTo, new_valid_to: newTo })
      const [reg] = await api.view<{ valid_to: string; renewal_status: string }>('v_licence_register', `id=eq.${lic.id}&select=valid_to,renewal_status`)
      expect(reg).toMatchObject({ valid_to: newTo, renewal_status: 'renewed' })
      await expect(page.getByTestId('lic-valid-to')).toHaveText(ddmmyyyy(newTo), { timeout: 20_000 })
      await expectNoSeriousA11y(page)

      // ── 4. Asset register: depreciation refused with the missing setting named ──
      const month = prevMonthStart(today)
      const monthLabel = monthName(month)
      await page.goto(`/admin/asset-register?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Asset register' })).toBeVisible()
      await settled(page)
      await expectNoSeriousA11y(page)
      await page.getByLabel('Month', { exact: true }).selectOption({ label: monthLabel })
      await page.getByRole('button', { name: 'Run depreciation' }).click()
      await alertWith(page, /depreciation\.method/)
      await alertWith(page, /CA decides/)
      expect(await api.view('v_depreciation_runs', `company_id=eq.${cid}&select=id`)).toHaveLength(0)
      await expectNoSeriousA11y(page)

      // ── 5. Partners: partner with the staff user's portal sign-in; the investor's request decided by Admin; Admin's own refused ──
      const partnerName = `E2E Test Partner ${tag}`
      await page.goto(`/accounts/partners-and-profit-sharing?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Partners and profit sharing' })).toBeVisible()
      await settled(page)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Add partner' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('Name', { exact: true }).fill(partnerName)
      await dlg.getByLabel('Investor portal sign-in (optional)').selectOption({ label: staffName })
      await dlg.getByLabel('Share %').fill('10')
      await expectNoSeriousA11y(page)
      await dlg.getByRole('button', { name: 'Save' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      const [partner] = await api.view<{ id: string; user_id: string; share_pct: number }>('v_partners', `company_id=eq.${cid}&select=id,user_id,share_pct`)
      expect(partner).toMatchObject({ user_id: people.staffId, share_pct: 10 })
      await expect(page.getByRole('cell', { name: partnerName, exact: true })).toBeVisible()

      await signInWithEmail(staffPage, creds.staff)
      await expect(staffPage).not.toHaveURL(/sign-in$/, { timeout: 20_000 })
      const staffApi = await restAsSignedInUser(staffPage)
      const fromInvestor = await staffApi.rpc<{ id: string; doc_no: string }>('submit_partner_request', { p_kind: 'info', p: { company_id: cid, purpose: 'E2E Test question about the plan' } })

      await page.goto(`/accounts/partner-requests?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Partner requests' })).toBeVisible()
      await settled(page)
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: `Approve ${fromInvestor.doc_no}` }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Approve' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      type PR = { status: string; decided_by: string | null; requested_by: string }
      const [decided] = await api.view<PR>('v_partner_requests', `id=eq.${fromInvestor.id}&select=status,decided_by,requested_by`)
      expect(decided).toMatchObject({ status: 'approved', decided_by: people.adminId, requested_by: people.staffId })
      await expect(page.getByTestId(`pr-status-${fromInvestor.doc_no}`)).toHaveText('Approved')

      await page.getByRole('button', { name: 'Record a request' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('Partner', { exact: true }).selectOption({ label: partnerName })
      await dlg.getByLabel('Request', { exact: true }).selectOption({ label: 'Question' })
      await dlg.getByLabel('Question', { exact: true }).fill('E2E Test question recorded by Admin')
      await expectNoSeriousA11y(page)
      await dlg.getByRole('button', { name: 'Record request' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      const [own] = await api.view<{ id: string; doc_no: string }>('v_partner_requests', `company_id=eq.${cid}&requested_by=eq.${people.adminId}&select=id,doc_no`)
      await page.getByRole('button', { name: `Approve ${own?.doc_no}` }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Approve' }).click()
      await alertWith(page, /Nobody decides their own request/)
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      const [ownAfter] = await api.view<PR>('v_partner_requests', `id=eq.${own?.id}&select=status,decided_by,requested_by`)
      expect(ownAfter).toMatchObject({ status: 'submitted', decided_by: null })

      await page.goto(`/accounts/directors-and-investment?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Directors and investment' })).toBeVisible()
      await settled(page)
      await expectNoSeriousA11y(page)

      // ── 6. Month-end close: checklist, done by Admin, checked by the staff user, close, posting refused, reopen ──
      const [period] = await api.view<{ period_id: string }>('v_period_status', `company_id=eq.${cid}&month_start=eq.${month}&select=period_id`)
      await page.goto(`/accounts/month-end-close?${q}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Month-end close' })).toBeVisible()
      await settled(page)
      await expect(page.getByLabel('Month', { exact: true })).toHaveValue(period?.period_id ?? 'x')
      await expectNoSeriousA11y(page)
      await page.getByRole('button', { name: 'Open checklist' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Open checklist' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      const [cl] = await api.view<{ id: string; tasks: number }>('v_close_checklists', `period_id=eq.${period?.period_id}&select=id,tasks`)
      expect(Number(cl?.tasks)).toBeGreaterThan(1)
      type CT = { id: string; title: string; status: string; done_by: string | null; checked_by: string | null }
      const tasks = await api.view<CT>('v_close_tasks', `checklist_id=eq.${cl?.id}&select=id,title,status,done_by,checked_by&order=sort`)
      const [first, second, ...rest] = tasks
      await page.getByRole('button', { name: `Mark done: ${first?.title}` }).click()
      await expect(page.getByRole('button', { name: `Check: ${first?.title}` })).toBeVisible({ timeout: 20_000 })
      let [t1] = await api.view<CT>('v_close_tasks', `id=eq.${first?.id}&select=id,title,status,done_by,checked_by`)
      expect(t1).toMatchObject({ status: 'done', done_by: people.adminId })
      await page.getByRole('button', { name: `Check: ${first?.title}` }).click()
      await alertWith(page, /cannot also check it/)
      ;[t1] = await api.view<CT>('v_close_tasks', `id=eq.${first?.id}&select=id,title,status,done_by,checked_by`)
      expect(t1).toMatchObject({ status: 'done', checked_by: null })
      await expectNoSeriousA11y(page)

      await staffPage.goto(`/accounts/month-end-close?${q}`)
      await expect(staffPage.getByRole('heading', { level: 1, name: 'Month-end close' })).toBeVisible({ timeout: 20_000 })
      await settled(staffPage)
      await staffPage.getByRole('button', { name: `Check: ${first?.title}` }).click()
      await expect(staffPage.getByRole('button', { name: `Check: ${first?.title}` })).toBeHidden({ timeout: 20_000 })
      ;[t1] = await api.view<CT>('v_close_tasks', `id=eq.${first?.id}&select=id,title,status,done_by,checked_by`)
      expect(t1).toMatchObject({ status: 'checked', done_by: people.adminId, checked_by: people.staffId })
      await expectNoSeriousA11y(staffPage)

      // One task moved on from the screen, the rest through the same RPC.
      await page.reload()
      await settled(page)
      await page.getByRole('button', { name: `Move to next month: ${second?.title}` }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByLabel('Why it moves').fill('E2E test: statement not received')
      await dlg.getByRole('button', { name: 'Move to next month' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      for (const x of rest) await api.rpc('carry_close_task', { p_task_id: x.id, p_reason: 'E2E test: moved on' })
      await page.reload()
      await settled(page)
      await page.getByRole('button', { name: 'Close the month' }).click()
      dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Close the month' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      type PS = { status: string; last_action: string | null; last_reason: string | null }
      let [ps] = await api.view<PS>('v_period_status', `period_id=eq.${period?.period_id}&select=status,last_action,last_reason`)
      expect(ps).toMatchObject({ status: 'closed', last_action: 'closed' })

      // A posting dated in the closed month is refused (depreciation journal for that month).
      await page.goto(`/admin/asset-register?${q}`)
      await settled(page)
      await page.getByLabel('Month', { exact: true }).selectOption({ label: `${monthLabel} · closed` })
      await page.getByRole('button', { name: 'Run depreciation' }).click()
      await alertWith(page, /This month is closed/)
      expect(await api.view('v_depreciation_runs', `company_id=eq.${cid}&select=id`)).toHaveLength(0)

      // Admin reopens with a reason (logged).
      const reason = 'E2E test: reopen to correct a synthetic entry'
      await page.goto(`/accounts/month-end-close?${q}`)
      await settled(page)
      await page.getByRole('button', { name: 'Reopen a month · Admin' }).click()
      dlg = page.getByRole('dialog')
      await expect(dlg.getByLabel('Month', { exact: true })).toHaveValue(period?.period_id ?? 'x')
      await dlg.getByLabel('Reason (at least 10 characters)').fill(reason)
      await expectNoSeriousA11y(page)
      await dlg.getByRole('button', { name: 'Reopen month' }).click()
      await expect(dlg).toBeHidden({ timeout: 20_000 })
      ;[ps] = await api.view<PS>('v_period_status', `period_id=eq.${period?.period_id}&select=status,last_action,last_reason`)
      expect(ps).toMatchObject({ status: 'open', last_action: 'reopened', last_reason: reason })
    } finally {
      await staffCtx.close()
      await people.cleanup()
    }
  })
})
