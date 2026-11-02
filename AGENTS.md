# Southfield Group ERP — agent rules (always on)

This file sets the rules for any coding agent working in this repo. Antigravity reads it automatically.

## What this repo is

The ERP for Southfield Group:

- **Southfield Biochem Pvt Ltd:** cosmetics, soap, detergents and perfume. Factory at Chalissery, with an R&D lab and a testing lab. Shops in Kochi and Coimbatore, plus field sales.
- **Southfield Plastics Pvt Ltd:** injection moulding, moulds, components, mixer grinder assembly and export.

It replaces Tally, paper and WhatsApp for both companies.

**Stack:** React + TypeScript (strict) on Vercel, Supabase (Postgres, Auth, Storage, Edge Functions) in **Mumbai (`ap-south-1`)**, and GitHub.

## Read before you work

| File | What it is |
|---|---|
| `docs/prompts/SOUTHFIELD_ERP_PROMPT.md` | The complete prompt. Part 1: what the system does, the architecture and the phases (§0–§30). Part 2: how every screen looks and behaves (§UX-1 to §UX-14). Part 3: WhatsApp sending of invoices, statements and reminders (§WA) and the AI help assistant for staff (§HELP). |
| `docs/spec/SOUTHFIELD_ERP_SPEC.md` | Full specification and the acceptance checks for each phase |
| `docs/design/PAGE_INVENTORY.md` | Every screen, with its route, device, role and workflow |
| `docs/design/WORKFLOWS.md` | The 17 workflows |
| `docs/design/tokens.css` | Design tokens |
| `design-reference/` | Approved screens, as images and sources. Kept local and never committed. |
| `docs/IMPLEMENTATION_STATUS.md` | Where the work stands, and the open questions |

## Non-negotiables

1. **The approved design is final.** Match `design-reference/` and don't redesign. Use the tokens, IBM Plex Sans and Mono, and the sidebar order exactly as given.
2. **Reference figures are not data.** Never copy numbers, names or IDs from the design files into code, seeds or tests. Every value on screen comes from Supabase.
3. **Business logic lives only in Postgres functions (RPCs).** Each one runs in a single transaction, is idempotent through a `client_request_id`, locks the rows it changes, and checks rights, state, period, stock and limits. The browser never decides a posted amount, tax, stock or pay.
4. **Row-level security is on every table.** Rights are also checked inside every RPC, so hiding a button is never the security.
5. **Ledgers are append-only:** stock, GL, material consumption and audit history. Never update or delete a posted record. A correction is a reversal plus a new document, both linked to the original.
6. **The audit trail can't be switched off or edited** (Companies (Accounts) Rules, Rule 3(1)).
7. **GST:**
   - The rate comes from the HSN table with effective dates.
   - No taxable sale without GST.
   - A bill without GST needs a lawful reason and can only be created by Admin.
   - Every bill appears in the books, the returns and the CA's view.
   - A move between places on the same GSTIN uses a delivery challan. A move to another GSTIN uses a tax invoice with IGST.
8. **Cash limits:**
   - Refuse a receipt of ₹2 lakh or more from one person in a day.
   - Warn on a cash payment over ₹10,000 to one person in a day and offer payment by bank.
9. **Segregation of duties:**
   - A batch maker can't QC-release their own batch.
   - A picker can't close their own transfer.
   - Nobody approves their own request.
10. **Privacy (DPDP):**
    - Aadhaar is stored masked (last 4 digits only).
    - Bank account numbers are masked in lists.
    - Bank statement passwords are never stored.
    - GPS is recorded only on duty and kept for 90 days.
    - WhatsApp goes only to verified numbers that have given consent.
    - Staff messages carry links, never salary, KYC or bank details.
    - No figures without GST go into internal alerts.
    - The help assistant runs with the user's own rights, never changes data, and never sends salary, KYC, bank details or figures without GST to the AI model.
11. **Secrets:**
    - The browser gets only the Supabase URL and the publishable (anon) key.
    - The service-role or secret key lives only in Edge Function and CI secrets.
    - Never commit `.env` files.
12. **Data stays in India.** Supabase runs in `ap-south-1`, Edge Functions run in `ap-south-1` through regional invocation, and any Vercel functions run in `bom1`. Backups go only to Indian locations. Real business data never goes into Git, CI, fixtures or screenshots.
13. **Production safety:**
    - No migration runs on prod outside the approved GitHub environment.
    - No destructive change (drop, a rename that moves data, a type change) without a written plan and the owner's approval.
14. **Money and quantities:**
    - Money is `numeric(18,2)` and quantities are `numeric(18,3)`. No floats.
    - Display uses Indian grouping (`en-IN`), dates as DD-MM-YYYY, and the financial year runs April to March in IST.
15. **Done means verified.** A module is done only when its whole workflow passes against the database:
    - pgTAP tests for RLS and the RPCs
    - a Playwright test that asserts the database state
    - an axe check
    - A screen that only looks right is not done.

## How to work

- **One phase at a time** (Part 1 §28 of the prompt). Plan, write the data contracts in `docs/DATABASE_SCHEMA.md`, build in small PR-sized slices, test, update the docs, and report.
- **Stop for the owner's review at the end of every phase.**
- **When a decision belongs to the owner or the CA,** add it under "Open questions" in `docs/IMPLEMENTATION_STATUS.md`, take the safest reading, and say so. Never invent tax rates, legal thresholds, people or prices.
- **Keep the existing conventions** when the repo already has them. Record any change and its reason in `docs/ERP_ARCHITECTURE.md`.
- **Use the workflows:**

  | Workflow | Use it to |
  |---|---|
  | `/next-phase` | Plan and build the next phase |
  | `/build-screen` | Build one screen from its reference |
  | `/db-change` | Make a database change safely |
  | `/verify` | Run every check before a PR |

## Commands

These are the expected commands. Adjust them to the repo's package manager and record the real ones here.

- `pnpm dev`: run the app
- `pnpm lint`, `pnpm typecheck` and `pnpm test`: lint, type-check, and run Vitest
- `supabase start`, `supabase db reset` and `supabase test db`: local database, migrations plus seed, and pgTAP
- `supabase gen types typescript --local > src/shared/database.types.ts`
- `pnpm e2e`: Playwright, including the axe checks
- `pnpm build`
