# Southfield ERP: Antigravity prompt pack

This folder sets up a GitHub repo so that Google Antigravity can build the Southfield ERP with React, Supabase and Vercel. It follows the design canvas you approved and the build specification.

## What's inside

| Path | What it is | Goes to GitHub? |
|---|---|---|
| `AGENTS.md` | Rules Antigravity follows on every turn | Yes |
| `.agents/rules/` | UI rules (when editing `src/`), database rules (when editing `supabase/`), Indian law rules (loaded when relevant) | Yes |
| `.agents/workflows/` | Workflows: `/next-phase`, `/build-screen`, `/db-change`, `/verify` | Yes |
| `docs/prompts/SOUTHFIELD_ERP_PROMPT.md` | **The one complete prompt.** Part 1 is your prompt, fixed for Southfield (the full system build). Part 2 is UX/UI. Part 3 is WhatsApp automation (invoices, statements, reminders, receipts) and the AI help assistant for staff. Then the final execution command, and an appendix of prompts to paste, one per session. | Yes |
| `docs/design/PAGE_INVENTORY.md` | All 132 screens, with route, device, role and workflow | Yes |
| `docs/design/WORKFLOWS.md` | The 17 workflows and their hand-offs | Yes |
| `docs/design/tokens.css` | Colours, fonts and sizes from the design | Yes |
| `docs/spec/` | Place for the full build specification (step 3 below) | Yes |
| `design-reference/` | 132 screen images and static HTML pages, with every figure masked, plus the three logos | **No. Keep it on your computer only.** |
| `.gitignore`, `.env.example` | Keeps secrets and the design reference out of Git | Yes |

In `design-reference/`, **every figure is masked as `X`**: amounts, balances, quantities, counts and percentages. Names, GSTINs and dates are still shown. Antigravity can read it from your computer, and `.gitignore` stops it being pushed to GitHub. Keep the repo **private** anyway.

## One-time set-up (about an hour)

1. **GitHub.** Create a **private** repo, for example `southfield-erp`. Copy everything in this folder into it, including the hidden `.agents/` folder and `.gitignore`. If the repo already has a `.gitignore`, add the lines from ours to it.
2. **Supabase.**
   - Create two projects, `southfield-dev` and `southfield-prod`, both in **South Asia (Mumbai)**.
   - In each project, turn off public sign-ups and turn on MFA.
   - Keep the database password in your own password manager. Never paste it into Antigravity.
3. **The build specification.**
   - Open the build document. Its heading is "Southfield ERP — Corrected Build Prompt"; your artifacts list may still show it as "Plastic Factory ERP — Corrected Build Prompt".
   - Download it as **Markdown**.
   - Save it as `docs/spec/SOUTHFIELD_ERP_SPEC.md`.

   The prompts depend on it for the detail and the acceptance checks of each phase.
4. **Vercel.**
   - Import the GitHub repo.
   - Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`: the dev values for Preview, the prod values for Production.
   - Turn on Deployment Protection for previews.
   - **Never add the service-role or secret key to Vercel.**
5. **WhatsApp.** You can do this later, before Phase 3 goes live.
   - Verify each company in Meta Business Manager.
   - Choose a WhatsApp Business number for each company and add a payment method.
   - Decide whether to connect to Meta directly or through a provider such as Gupshup, Interakt, AiSensy or Wati.
   - Until then, the build uses a mock server and test numbers.
6. **AI help assistant.**
   - Choose the AI provider: Gemini on Vertex AI, Claude, or another.
   - The API key goes only into Supabase Edge Function secrets.
7. **Import computer for Tally backups.**
   - Pick one Windows PC in the office (or a Windows machine in India) with a TallyPrime licence. The Tally bridge runs there.
   - The bridge restores your TBK backup files into a separate folder, never over your live Tally, and reads them into the ERP.
   - Tally XML or Excel exports don't need this computer.
8. **Antigravity.**
   - Open the repo folder.
   - Check that the rules show up under Customizations, and that the workflows appear when you type `/`.

## How to run the build

- Open a new Agent Manager conversation in Antigravity and either paste the whole of `docs/prompts/SOUTHFIELD_ERP_PROMPT.md`, or paste the **Session 1** block from its appendix (which tells the agent to read the file). Let it run.
- For each later phase, paste the next Session block from the appendix into a new conversation.
- **At the end of each phase, Antigravity stops.** Review the screenshots in `docs/review/phase-N/`, the report, and the open questions in `docs/IMPLEMENTATION_STATUS.md`. Then start the next session.
- Load your real Tally data yourself, through the Import screen on the Mumbai prod project, after Phase 2 passes. You can upload the same TBK backup files. Duplicates are matched or sent to the Bug fixer, never created twice. Never put the files in the repo.
- Production database changes run only when you approve them in GitHub.

## What was fixed in your original prompt

1. **"The UI already exists, don't redesign it."**
   - The approved UI is your design canvas: 132 screens, now in `design-reference/`, with a page inventory.
   - The prompt now builds the React screens to match it, and stops Antigravity copying design figures into code.
2. **Generic modules replaced with Southfield's real ones.**
   - Added Biochem's cosmetics and soap manufacturing (bulk by weight, packaging in Nos, two labs, QC release by a second person, free items and gift packs) and Plastics' moulds, injection, mixer grinder assembly and export.
   - Electronics PCB/SMT is kept as an option that stays off until you need it.
3. **Indian law added.**
   - GST by HSN with the 22-Sep-2025 rates; challan versus IGST invoice for Kochi and Coimbatore.
   - E-invoice and e-way bill; the ₹2 lakh cash block and ₹10,000 cash warning; TDS.
   - The audit trail rule, with books in India.
   - Schedule III; labour codes; Legal Metrology and Cosmetics Rules labels; the MSME 45-day rule; DPDP.
4. **Bills without GST.** Only Admin sees them, but each one needs a lawful reason and stays in the books, the returns and the CA's view.
5. **Your data and control screens added:** Tally migration with the Bug fixer queue, special permissions with time limits, the transaction log, the Office admin role, and the CA's read-only view.
6. **Sales and distribution added:** route sales with GPS, a full salesman portal (route plan, each customer's balance, queries and order history, a product library, orders, collections, end-of-day handover), the Kochi and Coimbatore shops, credit control, two-person stock transfers, complaints, private label and agents.
6a. **Customer and supplier KYC, credit periods, outstanding and ledgers added:** GSTIN checks, document lists, bank-change control, MSME 45-day rules, due dates nobody can edit, bill-wise outstanding with ageing, party and general ledgers, statements and yearly balance confirmations.
7. **Your real roles** replace the generic list. There is one staff list across both companies, WhatsApp-number sign-in, and Malayalam, Hindi and Bhojpuri screens.
8. **The stack made concrete:**
   - Supabase and Vercel in Mumbai.
   - All business logic in database functions, with ledgers that can't be edited, row security on every table, and idempotent posting.
   - Backups only inside India.
   - Production migrations need your approval.
9. **Phases reordered for Southfield**, with a review stop after each one and paste-in prompts for every session.
10. **New:** WhatsApp automation for invoices, statements, reminders and receipts, and an AI help assistant that staff can talk to in their own language when something in the ERP goes wrong.

## Decisions still yours

- Which PC will be the import computer for Tally backups.
- What a salesman sees as a customer's balance: the full balance (the same as the customer's own statement) or GST bills only. The build starts with GST bills only until you decide.
- WhatsApp: one number per company or one for the group, and Meta directly or a provider.
- The AI model provider for the help assistant.
- A second QC person, besides the chemist.
- Licence numbers and expiry dates.
- With the CA: GST rates by HSN, lawful reasons for bills without GST, e-invoice start date, PF/ESI and overtime settings, and the treatment of free items.
- Whether the Nellimattam godown is closed.
