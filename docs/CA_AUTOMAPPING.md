# CA jobs done automatically from the law (and what is left for the CA)

Done on **05-11-2026** by the assistant, on the DEV database, for **SFB** (Southfield Biochem Pvt Ltd) and **SFP** (Southfield Plastics Pvt Ltd).
Both are private limited companies, so **Companies Act 2013, Schedule III, Division I** is applied unless the CA says otherwise.

> Everything below is marked **"auto-mapped on 05-11-2026 by the assistant per Schedule III / Tally inheritance — CA to confirm"**.
> **No CA confirmation was recorded**: `acct.schedule3_map.ca_confirmed` is `false` for every row and `api.confirm_schedule3_map` was **not** called.
> Where the answer needs judgment, or is a rate, threshold or method choice, nothing was decided (section B).
> This is a design checklist, not legal advice (`.agents/rules/india-law.md`). No real ledger, party or item name or figure is written here.

How it is traced:

- Account groups and Tally-group maps: created through `api.upsert_account_group` and `api.set_tally_group_map` as the Admin login (`mapped_by` / `mapped_at` on `ops.tally_group_map`).
- Schedule III lines: `api.set_schedule3_map` (`set_by` / `set_at` on `acct.schedule3_map`). The RPC has no note field, so each row also has an `audit.user_log` entry (`setting_changed`) carrying the note above, the company, the group and the line code.
- Repeatable scripts: [scripts/ca-automap-groups.mjs](../scripts/ca-automap-groups.mjs) and [scripts/ca-automap-schedule3.mjs](../scripts/ca-automap-schedule3.mjs). Both use the existing RPCs only, print counts only, and never overwrite a mapping somebody already set.

---

## A. Done automatically

### A1. Custom Tally groups (Q-44) — Tally's inheritance rule

**Rule (Tally):** a user-created group takes the nature of the nearest *predefined* group above it. The group masters in `ops.import_rows` carry `parent` (and `reserved`, which is empty for every custom group). Walk `parent` up until a predefined group is found.

**What was done:** each custom group was recreated as a **child** of its parent's ERP account group (so the owner's sub-group names are kept), with the ancestor's nature and party flag (a sub-group of Sundry Debtors is still a debtors group, so its ledgers become parties exactly like the existing ones). It was then mapped with `api.set_tally_group_map` (the "Map this head" RPC) and the waiting rows were loaded with `api.import_process`.

| Company | Custom groups mapped | Nearest predefined ancestor → number of custom groups under it |
|---|---|---|
| SFB | 20 (18 directly under a predefined group, 2 one level deeper) | Sundry Debtors 6 · Fixed Assets 4 · Loans & Advances (Asset) 4 + 2 nested below one of them · Capital Account 1 · Current Liabilities 1 · Loans (Liability) 1 · Misc. Expenses (ASSET) 1 |
| SFP | 6 | Fixed Assets 3 · Capital Account 1 · Loans & Advances (Asset) 1 · Misc. Expenses (ASSET) 1 |

Result (counts):

| Company | ERP account groups | Accounts | Parties | Open `map_head` items |
|---|---|---|---|---|
| SFB before → after | 28 → 48 | 1,058 → 1,533 | 733 → 1,042 | 21 → 1 |
| SFP before → after | 28 → 34 | 464 → 537 | 360 → 360 (no debtors/creditors sub-group existed) | 7 → 1 |

Left on purpose: **ledgers whose Tally master has no parent group** (1 open item per company, a few rows). They are not guessed; the owner must say which group they belong to (Bug fixer → "Map this head: (no group)").

Not caused by mapping, but now visible: 105 SFB ledger rows fail to load with a database error (a party address check and a 6-character pincode column), and "possible duplicate" / "missing GSTIN" items exist for the newly loaded parties. These are Bug fixer items for the owner/developer, not CA decisions.

### A2. Schedule III mapping (Q-38) — deterministic rule table

Only groups whose Schedule III line follows from the group's own definition are mapped. The tiebreaker is Tally's group nature (asset / liability / income / expense). A script guard refuses a line whose side does not match the group's nature. Custom child groups are **not** mapped one by one: `api.schedule3_statements` already uses the nearest mapped ancestor, so they follow their parent.

| Tally group (SFB and SFP, same rule) | Schedule III line (Division I) | Reference | Confidence |
|---|---|---|---|
| Sundry Debtors | Trade receivables | Part I Balance Sheet, Current assets (b)(iii) | High |
| Sundry Creditors | Trade payables | Part I Balance Sheet, Current liabilities (b)(ii) | High |
| Bank Accounts | Cash and cash equivalents | Part I, Current assets (b)(iv) | High |
| Cash-in-Hand | Cash and cash equivalents | Part I, Current assets (b)(iv) | High |
| Bank OD A/c | Short-term borrowings (loans repayable on demand from banks) | Part I, Current liabilities (b)(i) | High — an overdraft is repayable on demand |
| Fixed Assets | Property, plant and equipment | Part I, Non-current assets (a)(i) | High (CA to check any intangible or capital work-in-progress inside) |
| Stock-in-Hand | Inventories | Part I, Current assets (b)(ii) | High |
| Reserves & Surplus | Reserves and surplus | Part I, Shareholders' funds (a)(b) | High |
| Sales Accounts | Revenue from operations | Part II Statement of P&L, I | High |
| Indirect Incomes | Other income | Part II, II | High (non-operating income) |

Result: **10 groups mapped in SFB and 10 in SFP**, all `ca_confirmed = false`.

**Statements run** (`api.schedule3_statements`, FY 2026-27, Admin view): both statements are *draft · before audit* and `mapping_confirmed_by_ca = false`.

| Company | Groups with no mapped line (of total) | Balance sheet check (assets = equity + liabilities) |
|---|---|---|
| SFB | 28 of 48 | Can be evaluated, **does not agree**: the balance-sheet lines are not complete (unmapped groups are shown on their natural side under "Not yet mapped"), no opening balances were applied and only loaded vouchers are in the GL. |
| SFP | 21 of 34 | Can be evaluated, **does not agree** for the same reasons. |

The difference is expected today and is not an error to fix in code. It closes only after Q-45 (opening balances applied with the CA's sign-off) and the CA's decisions in B1.

### A3. Other items already set or coded from the law (no action by the assistant needed)

| Item | Where | Status |
|---|---|---|
| Cash receipt block (s.269ST in the rule text of the repo; see AGENTS.md rule 8) and cash payment warning (s.40A(3)) | settings `cash.receipt_block_amount`, `cash.payment_warn_amount` (global, seeded) | Seeded and enforced. CA confirms the legal references (Q-27). |
| MSME payment terms: 45-day cap, s.15 MSMED Act 15 days when no days are agreed | `msme.warn_days`, `msme.selling_rule` and the dues view | Coded. Whether the company is a registered micro/small enterprise is the CA's (B2). |
| E-invoice cancel window | setting `einvoice.cancel_window_hours` (seeded) | Seeded per the IRP rule. |
| Audit trail, append-only ledgers, India-only data | database design | In force, nothing to map. |
| Opening bills | `acct.open_bills` | **Left `unclassified`.** A bill without GST needs Admin and one of the four lawful reasons (`.agents/rules/india-law.md`). |
| Trial Balance and Stock Summary | `ops.tally_reports` | **Not applied.** Needs the owner's opening date and the CA's sign-off (Q-45). Nothing was posted to the GL or stock. |

---

## B. NOT done, and why

### B1. Schedule III lines left for the CA (judgment needed)

| Tally group | Why not mapped | The CA decides |
|---|---|---|
| Capital Account (and the custom "Capital" group under it) | Partners' / shareholders' capital, reserves, current accounts are different lines | Split between Share capital, Reserves and surplus and any loan-from-director treatment (Q-41) |
| Loans (Liability), Secured Loans, Unsecured Loans (and the custom loan group under Loans) | Long-term or short-term depends on repayment terms; may include director/partner money | Long-term borrowings vs Short-term borrowings vs current maturities; s.185 and director-loan declaration |
| Loans & Advances (Asset) and its custom sub-groups (staff, worker advances) | Short-term vs long-term; employee advances vs other | Short-term or long-term loans and advances / other current assets |
| Deposits (Asset) | Security deposits can be current or non-current | Line choice |
| Investments | Current vs non-current | Line choice |
| Duties & Taxes | The sign of each ledger decides Other current liabilities or Other current assets | Mapping by ledger or by sign |
| Provisions | Short-term vs long-term; employee benefits vs other | Line choice |
| Purchase Accounts | Cost of materials consumed vs Purchases of stock-in-trade is a CA choice (and the changes-in-inventories line) | Line choice |
| Direct Expenses, Indirect Expenses | Contain employee costs, finance costs, depreciation and other expenses, each its own line | Mapping by ledger or sub-group |
| Direct Incomes | May be Revenue from operations or Other income | Line choice |
| Misc. Expenses (ASSET) and its custom group | Schedule III no longer carries a "miscellaneous expenditure" asset | Write-off or other line |
| Suspense A/c, Branch / Divisions | Nature depends on the entry | Clear or classify |
| Current Assets, Current Liabilities | Parent heads only; the children are mapped on their own | None, unless ledgers sit directly under them |
| Custom groups under Fixed Assets (e.g. die/mould, vehicle, injection-division assets) | Followed their parent (PPE) by inheritance; one may hold expenditure or capital work-in-progress | Confirm each is PPE, CWIP or intangible |

Screen: **Accounts → Schedule III** (`src/features/accounts/schedule-iii`). The CA's confirmation is recorded by Admin with the CA's note through `api.confirm_schedule3_map` — only after the CA has actually confirmed.

### B2. Rates, thresholds and methods — not decided, not invented

| # | Item | Setting key / place | Legal reference to look at | Status |
|---|---|---|---|---|
| 1 | GST rate by HSN, with effective dates | `master.hsn_rates` (HSN screen) | CGST/IGST rate notifications in force on the document date | Unset except one synthetic row; taxable sale refused without a rate (Q-19). Rates are not stated here. |
| 2 | Lawful reasons for a bill without GST | Admin bill screen | CGST Act, bill of supply / exempt / nil-rated / non-GST / export under LUT | Four reasons only (Q-20). |
| 3 | GST treatment of free items, gift packs, combo packs | `prod.packs.gst_treatment` per pack | CBIC circular 92/11/2019; CGST Act s.17(5)(h), s.8 | Per pack, CA picks (Q-23). |
| 4 | E-invoice applicability and start date | `core.gstins.einvoice_from` via `api.set_einvoice_switch` | Aggregate-turnover threshold notified under the CGST Rules | Off for all GSTINs until the CA confirms (Q-21). |
| 5 | E-way bill threshold by state | `eway.threshold_amount` | CGST Rules, e-way bill provisions and state notifications | Unset: every dispatch needs an e-way number (Q-36). |
| 6 | B2C large invoice value | `gst.b2cl_invoice_value` | GSTR-1 instructions in force | Unset (Q-36). |
| 7 | TDS sections and rates (salary, rent, contractor, professional) | TDS settings (Q-24) | Income-tax Act 2025, TDS chapter and rate schedule | Unset; no rate stated. |
| 8 | TCS rate on marketplace sales | `marketplace.tcs_rate_pct` | CGST Act s.52; Income-tax Act 2025 TCS provisions | Unset, reconciliation shows `rate_not_set` (Q-P8-7). |
| 9 | Depreciation: useful life, residual value, method (WDV or SLM) | `depreciation.useful_life_years`, `depreciation.residual_pct`, `depreciation.method`; fields on `core.assets` | Companies Act 2013 Schedule II (Part C useful-life table) — method is the company's choice | Unset; nothing is computed (Q-P5-4, Q-41). |
| 10 | s.185 exception for loans to directors | `companies_act.s185_exception` (basis, resolution reference) | Companies Act 2013 s.185 | Unset, loan refused (Q-41). |
| 11 | s.186 limit for other loans/investments | `companies_act.s186_limit` | Companies Act 2013 s.186 | Unset, refused (Q-41). |
| 12 | Whether a partner/director balance is capital, loan or current account | Partners screen | Companies Act s.2(31), s.73 deposits; Partnership terms | CA decides per account. |
| 13 | Registered micro/small enterprise status for the selling rule | `msme.selling_rule` | MSMED Act 2006 s.15–16 | Off until confirmed (Q-26, Q-32). |
| 14 | PF / ESI applicability and wage definitions | payroll settings (Q-22) | Code on Wages / Social Security Code (labour codes in force) | Off until confirmed. |
| 15 | Overtime multiplier and paid-leave treatment | `payroll.ot_multiplier` | Labour codes | 2 seeded as in the prompt; CA/HR confirms (Q-28). |
| 16 | Stock valuation method | company setting (Q-25) | Ind AS 2 / AS 2 as applicable | Weighted average, CA confirms. |
| 17 | Credit limits and advance recovery cap | credit and advance settings | Company policy | Not enforced (Q-29, Q-35). |
| 18 | Opening date, opening balances, opening stock | Import → Trial Balance / Stock Summary | Companies (Accounts) Rules | Staged, not applied (Q-45). |
| 19 | Whether the Plastics files belong to Southfield Plastics Pvt Ltd | Import screen | — | Q-46. |
| 20 | Minimum cash balance for the cash-flow indicator | `cash.min_balance` | — | Not created (Q-30). |

---

## C. Questions for the CA (ready to send)

1. **Schedule III — capital and reserves.** Please confirm the mapping of "Capital Account" and its custom "Capital" group between Share capital, Reserves and surplus and any director/partner loan. Open **Accounts → Schedule III**.
2. **Schedule III — borrowings.** For "Loans (Liability)", "Secured Loans", "Unsecured Loans" and the custom loan group: long-term or short-term, and are any loans from directors (s.185)? Open **Accounts → Schedule III** and **Partners**.
3. **Schedule III — loans and advances.** For "Loans & Advances (Asset)" and the staff/worker advance groups: short-term loans and advances or other current assets? Open **Accounts → Schedule III**.
4. **Schedule III — Duties & Taxes, Provisions, Deposits, Investments.** Which line for each (by ledger or by sign)? Open **Accounts → Schedule III**.
5. **Schedule III — expenses and incomes.** Map Purchase Accounts, Direct Expenses, Indirect Expenses and Direct Incomes to the Part II lines (cost of materials, purchases of stock-in-trade, employee benefits, finance costs, depreciation, other expenses). Open **Accounts → Schedule III**.
6. **Confirm the 10 automatic mappings** in each company (Trade receivables, Trade payables, Cash and cash equivalents, Short-term borrowings for Bank OD, PPE, Inventories, Reserves and surplus, Revenue from operations, Other income) and the sub-groups that follow them; then tell the owner so Admin can record your confirmation with your note. Open **Accounts → Schedule III**.
7. **Fixed-asset sub-groups.** Is each custom group under Fixed Assets PPE, capital work-in-progress or intangible? Open **Accounts → Chart of accounts**.
8. **Misc. Expenses (ASSET) groups.** How should they be treated under Schedule III? Open **Accounts → Chart of accounts**.
9. **Opening balances.** What is the opening date, and do you accept the Trial Balance difference shown by Tally before it is applied (Q-45)? Open **Import → Reports**.
10. **GST rates by HSN** with effective dates for every product HSN (Q-19). Open **Masters → HSN rates**.
11. **E-invoice:** is each GSTIN above the notified turnover threshold, and from which date should e-invoice be switched on (Q-21)? Open **GST → E-invoice switch**.
12. **E-way bill:** threshold per state and the cancel window (Q-36, Q-P8-8). Open **Settings**.
13. **TDS:** sections and rates for salary, rent, contractors and professionals (Q-24). Open **Settings → TDS**.
14. **Marketplace TCS rate** and posting rule (Q-P8-7). Open **Settings**.
15. **Depreciation:** method (WDV or SLM), useful life by asset class from Schedule II, and residual percentage (Q-41). Open **Settings → Depreciation** and **Assets**.
16. **s.185 and s.186:** is any exception available for loans to directors, and what is the s.186 limit (Q-41)? Open **Settings → Companies Act**.
17. **MSME:** is either company a registered micro/small enterprise for the selling rule, and are supplier terms to be capped at 45 days (Q-26, Q-32)? Open **Settings**.
18. **Free items, gift and combo packs:** GST treatment per pack (Q-23). Open **Products → Packs**.
19. **PF / ESI and payroll wage definitions** under the labour codes (Q-22, Q-28). Open **Settings → Payroll**.
20. **Stock valuation method** (Q-25) and whether finished goods carry labour and overhead (Q-P5-3). Open **Settings**.
21. **Opening bills without GST:** for each, which of the four lawful reasons applies? (Admin classifies; the assistant did not.) Open **Accounts → Opening bills**.
22. **Partner/director balances:** capital, loan or current account? Open **Partners**.
23. **Confirm** that the Plastics Tally files belong to Southfield Plastics Pvt Ltd (Q-46). Open **Import**.

## Opening balances applied for DEV testing (05-11-2026)

On **05-11-2026** the Trial Balance of each company was applied as opening balances as of **03-11-2026** on the DEV database (owner decision on the date), for testing. **Tally's own "Difference in opening balances" was not hidden or corrected**: SFB 436.00 and SFP 1,69,198.75 sit in the Suspense ledger "Difference in opening balances (Tally) — CA to clear" (Suspense A/c group, credit side), each with a HIGH Bug fixer item for the CA. For SFB the Tally lines Opening Stock and Unadjusted Forex Gain/Loss (not ledgers) are parked, net Cr 35,18,807.89, in "Tally computed lines not carried (Opening Stock, Unadjusted Forex) — CA to clear". **The CA must** find the cause of the difference in Tally, decide how opening stock and the unrealised forex amount reach the books, confirm the 54 accounts that were opened while their duplicate review is still waiting, and clear both Suspense ledgers with approved journals before any of this is used as the books of record. Nothing was posted to the ledger, stock or vouchers; the CA confirmation flags were not touched.
