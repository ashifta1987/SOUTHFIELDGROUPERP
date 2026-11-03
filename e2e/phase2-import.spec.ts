import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

/** Random letters, so synthetic party names never look like an earlier run's (no "possible duplicate"). */
function letters(n: number) {
  const a = 'bcdfghjklmnpqrstvwxz'
  return Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join('')
}

/** A tiny synthetic TallyPrime XML export: one group, two ledgers (one under an unmapped group) and one voucher. */
function tallyXml(tag: string, party: string, odd: string) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>E2E Test Books ${tag}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE><GROUP NAME="Sundry Debtors"><GUID>e2e-${tag}-grp-1</GUID><PARENT>Current Assets</PARENT><ALTERID>11</ALTERID></GROUP></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="${party}"><GUID>e2e-${tag}-led-1</GUID><ALTERID>12</ALTERID><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>-250.00</OPENINGBALANCE>
<BILLALLOCATIONS.LIST><NAME>E2E-${tag}-B1</NAME><BILLDATE>20260401</BILLDATE><OPENINGBALANCE>-250.00</OPENINGBALANCE></BILLALLOCATIONS.LIST></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="${odd}"><GUID>e2e-${tag}-led-2</GUID><ALTERID>13</ALTERID><PARENT>E2E Odd Group</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Receipt"><GUID>e2e-${tag}-vch-1</GUID><ALTERID>14</ALTERID><DATE>20260415</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>E2E-${tag}-1</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><AMOUNT>100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
}

async function pickCompany(page: Page, code: string) {
  const main = page.getByRole('main')
  const select = main.getByRole('combobox', { name: 'Company' })
  const tab = main.getByRole('tab', { name: `E2E Test Company ${code}` })
  await expect(select.or(tab).first()).toBeVisible()
  if (await select.count()) {
    await select.selectOption({ label: `${code} · E2E Test Company ${code}` })
  } else {
    await main.getByRole('tab', { name: `E2E Test Company ${code}` }).click()
  }
  await expect(page).toHaveURL(/company=/)
}

/** Result table cell: Type, Created, Linked, Aliased, Skipped, Bug, Changed, Error, Waiting. */
const COL = { created: 1, linked: 2, skipped: 4, bug: 5 }

test.describe('Phase 2 · Import data and Tally books', () => {
  test.skip(!hasCreds, 'needs .env.test.local')
  test.setTimeout(180_000)

  test('Tally XML import: unmapped heads wait, mapping loads them, the same file again is skipped', async ({ page }) => {
    const code = `E2E${Date.now().toString(36).slice(-4).toUpperCase()}`
    const tag = Date.now().toString(36)
    const party = `E2E ${letters(6)} ${letters(5)}`
    const odd = `E2E ${letters(6)} ${letters(5)}`
    const file = { name: `e2e-${tag}.xml`, mimeType: 'text/xml', buffer: Buffer.from(tallyXml(tag, party, odd), 'utf-8') }

    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()

    // 1. A synthetic company.
    await page.goto('/admin/companies')
    await page.getByRole('button', { name: 'Add company' }).first().click()
    const cDialog = page.getByRole('dialog')
    await cDialog.getByLabel('Short code').fill(code)
    await cDialog.getByLabel('Legal name').fill(`E2E Test Company ${code}`)
    await cDialog.getByRole('button', { name: 'Save' }).click()
    await expect(cDialog).toBeHidden()

    // 2. Tally books: pick it and add the ERP group "E2E Debtors".
    await page.goto('/admin/import-data/tally-biochem')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Tally books')
    await pickCompany(page, code)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`E2E Test Company ${code}`)
    const companyId = new URL(page.url()).searchParams.get('company') as string
    await page.getByRole('button', { name: 'Add account group' }).click()
    const gDialog = page.getByRole('dialog')
    await gDialog.getByLabel('Group', { exact: true }).fill('E2E Debtors')
    await gDialog.getByLabel('Nature').selectOption('asset')
    await gDialog.getByLabel('Party group').selectOption('debtors')
    await gDialog.getByRole('button', { name: 'Save' }).click()
    await expect(gDialog).toBeHidden()
    await expect(page.getByRole('region', { name: 'Account groups' }).getByRole('row').filter({ hasText: 'E2E Debtors' })).toBeVisible()
    await expectNoSeriousA11y(page)

    // 3. Import the XML: both ledgers wait for a mapping (Bug fixer), the voucher loads.
    await page.goto(`/admin/import-data?company=${companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Import data' })).toBeVisible()
    await expect(page.getByRole('button', { name: /From Tally/ })).toHaveAttribute('aria-pressed', 'true')
    await page.getByLabel('File', { exact: true }).setInputFiles(file)
    await expect(page.getByRole('heading', { level: 2, name: `${file.name} · 4 rows read` })).toBeVisible()
    await expect(page.getByRole('region', { name: 'First rows of the file' })).toContainText(party)
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: 'Import 4 rows' }).click()
    const result = page.getByRole('region', { name: 'Result by type' })
    await expect(result).toBeVisible({ timeout: 60_000 })
    const ledgers = result.getByRole('row').filter({ hasText: 'Ledgers' })
    await expect(ledgers.getByRole('cell').nth(COL.bug)).toHaveText('2')
    await expect(result.getByRole('row').filter({ hasText: 'Vouchers' }).getByRole('cell').nth(COL.created)).toHaveText('1')
    await expect(page.getByText(/wait in the Bug fixer/)).toBeVisible()
    await expectNoSeriousA11y(page)

    // 4. Map both Tally groups to E2E Debtors and load the waiting ledgers again.
    await page.goto(`/admin/import-data/tally-biochem?company=${companyId}`)
    const mapping = page.getByRole('region', { name: 'Tally groups waiting for a mapping' })
    for (const g of ['Sundry Debtors', 'E2E Odd Group']) {
      await mapping.getByLabel(`ERP account group for ${g}`).selectOption({ label: 'E2E Debtors' })
      await mapping.getByRole('button', { name: `Map ${g}` }).click()
      await expect(mapping.getByRole('row').filter({ hasText: g })).toHaveCount(0)
    }
    await page.getByRole('button', { name: /Load waiting ledgers again for IMP-/ }).click()
    await expect(page.getByText(/Batch IMP-\S+ loaded again:/)).toBeVisible({ timeout: 60_000 })
    await page.reload()
    const accounts = page.getByRole('region', { name: 'Accounts', exact: true })
    await expect(accounts.getByRole('row').filter({ hasText: party })).toBeVisible()
    await expect(accounts.getByRole('row').filter({ hasText: odd })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Opening bills' }).getByRole('row').filter({ hasText: `E2E-${tag}-B1` })).toBeVisible()
    await expectNoSeriousA11y(page)

    // 5. The same file again: every ledger and the voucher are skipped by their Tally IDs.
    await page.goto(`/admin/import-data?company=${companyId}`)
    await page.getByLabel('File', { exact: true }).setInputFiles(file)
    await page.getByRole('button', { name: 'Import 4 rows' }).click()
    await expect(result).toBeVisible({ timeout: 60_000 })
    await expect(result.getByRole('row').filter({ hasText: 'Ledgers' }).getByRole('cell').nth(COL.skipped)).toHaveText('2')
    await expect(result.getByRole('row').filter({ hasText: 'Vouchers' }).getByRole('cell').nth(COL.skipped)).toHaveText('1')
    await expect(page.getByRole('region', { name: 'Import batches' }).getByRole('row')).toHaveCount(3)
  })
})
