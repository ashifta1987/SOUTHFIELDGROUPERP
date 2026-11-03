# DPDP checklist

Phase 9 (go-live readiness). Maps each duty under the **Digital Personal Data Protection Act 2023** and the DPDP Rules 2025, and each item of `AGENTS.md` rule 10, to where the ERP enforces it. This is an engineering checklist, not legal advice: the owner and the company's legal adviser confirm the notice texts, retention periods and the grievance contact before go-live.

Legend: **Built** = enforced in code and covered by a test · **Process** = an owner/staff procedure (no code) · **Gap** = not yet done; must be closed or accepted in writing before go-live.

## 1. AGENTS.md rule 10 (privacy)

| # | Rule | Where it is enforced | Test | Status |
|---|---|---|---|---|
| 10.1 | Aadhaar stored masked (last 4 only) | `master.people.aadhaar_last4` is the only Aadhaar column in the database; `api.people` shows `aadhaar_masked`; the import engine keeps only the last 4 on load (`20261103001300_import_engine.sql`) | `10_hr_screens.sql`, `16_company_people.sql` | Built |
| 10.2 | Bank account numbers masked in lists | Column grants: `master.party_bank_accounts` / `bank_change_requests` full number not selectable by clients (`20261103001000_masters.sql`); views show last 4; staff bank `account_last4` | `05_masters.sql`, `25_security.sql` (no direct table writes) | Built |
| 10.3 | Bank statement passwords never stored | Bank statement import takes the password in the browser/Edge Function call only; no column exists for it | Code review (no column) | Built |
| 10.4 | GPS only on duty, kept 90 days | `field` schema: points accepted only inside an open duty; setting `field.gps_retention_days` = 90; daily `pg_cron` job `gps-retention-purge` → `app.purge_gps()` (`20261103006200_field_sales.sql`); Phase 8 GPS intake keeps the same rule and clears webhook payloads after 90 days (`app.integration_sweep`) | `19_field_sales.sql` | Built (prod: confirm the cron job exists — GO_LIVE_CHECKLIST §6) |
| 10.5 | WhatsApp only to verified numbers with consent | `msg` sender checks `whatsapp_consent` + verified number; STOP opts out; dev/preview allow-list (`WHATSAPP_TEST_ALLOWLIST`) | `11_staff_help.sql`, `17_delivery_sales.sql`, `e2e/phase3-whatsapp.spec.ts` | Built |
| 10.6 | Staff messages carry links, never salary/KYC/bank | Staff templates carry a link only (payslip-ready has no amount) | `08_money_payroll.sql` | Built |
| 10.7 | No figures without GST in internal alerts | Alerts and reminders built from GST documents only; `without_gst` rows excluded by RLS (`app.can_see_bill_class`) | `17_delivery_sales.sql`, `18_gst_reports.sql` | Built |
| 10.8 | Help assistant: user's own rights, read-only, no salary/KYC/bank/without-GST to the model | Help tools run with the user's JWT (RLS); server-side redaction before the model call | `11_staff_help.sql`, help eval set | Built (provider still TBD — §4) |

## 2. DPDP Act 2023 / Rules 2025 duties

| Duty (section) | What the ERP does | Status |
|---|---|---|
| Lawful purpose and notice (s.4, s.5; Rules r.3) | Purposes per data type are listed in `docs/SECURITY.md` §5. First-use notices: GPS (salesman/driver phone app), help assistant, WhatsApp consent in Customer KYC. **Gap:** the final notice texts (English + Malayalam) for staff, customers and investors need the legal adviser's wording; a staff privacy notice must be handed over at onboarding. | Gap (texts) |
| Consent and withdrawal (s.6) | WhatsApp consent recorded with time (`party_contacts.whatsapp_consent`, `consent_at`); STOP withdraws immediately; GPS works only on duty after notice. Employment data is processed under "legitimate uses" (s.7(i) employment) — no consent form needed for payroll/attendance, but the notice is still given. | Built / Process |
| Legitimate uses (s.7) | Books of account, GST, payroll, PF/ESI and statutory registers are kept to comply with law (s.7(c), (i)). | Process |
| Accuracy (s.8(3)) | Masters have KYC review by a second person; corrections go through RPCs with audit history. | Built |
| Security safeguards (s.8(5); Rules r.6) | RLS on every table (238/238), rights re-checked in every RPC, MFA for Admin/finance/CA/investor (`security.enforce_mfa`), encrypted transport (HSTS), CSP, audit trail, append-only ledgers, secrets only in Edge Function/CI secrets, quarterly RLS audit (`scripts/rls-audit.mjs`), secrets scan in CI. See `docs/SECURITY.md` → Phase 9 review. | Built |
| Breach notification (s.8(6); Rules r.7) | Steps in §5 below: notify the Data Protection Board and each affected person **without delay**, and a detailed report to the Board **within 72 hours**. | Process |
| Retention and erasure when purpose ends (s.8(7); Rules r.8) | GPS 90 days (purge job); webhook payloads 90 days; WhatsApp content 12 months, delivery events 90 days; help conversations 12 months. Books of account, vouchers and GST records kept **8 years** from the end of the FY (Companies Act s.128(5); CGST s.36 needs 72 months from the annual-return due date) — these are a lawful exception to erasure. **Gap:** a scheduled purge for WhatsApp content (12 months) and help conversations (12 months) is documented but not yet a `pg_cron` job; a staff-exit retention rule (payroll kept 8 years; KYC copies after exit) needs the owner's decision. | Gap (purge jobs, exit rule) |
| Grievance contact (s.8(10); Rules r.9) | **Gap:** name and publish a grievance officer / contact (email + phone) in the notices and the help pages. | Gap |
| Data principal rights — access (s.11) | Process §4: staff see their own payslips/attendance in the staff app; customers get statements over WhatsApp; a full summary is produced by Admin on request. | Process |
| Correction and erasure (s.12) | Corrections via the normal edit RPCs (audit-logged). Erasure: personal fields not needed by law are cleared by Admin; records needed for books/GST/payroll are kept with a note of the legal basis. **Gap:** no single "erase person" RPC yet — Admin does it field by field. | Gap (tooling) |
| Nominee (s.14) | Process: recorded on request in the person's notes. | Process |
| Children's data (s.9) | Not processed (no staff under 18; customers are businesses). Process: HR confirms age at onboarding. | Process |
| Cross-border transfer (s.16) | All processing in India (see §3). The AI model and WhatsApp provider must offer an India region or be confirmed as permitted. | Gap until providers chosen |
| Significant Data Fiduciary (s.10) | Not expected at this size. Re-check if notified by the government. | Process |

## 3. Data stays in India — processors

| Processor | What it holds | Region | Contract / DPA | Status |
|---|---|---|---|---|
| Supabase (Postgres, Auth, Storage, Edge Functions) | All ERP data, files, sessions | `ap-south-1` (Mumbai); Edge Functions invoked with region `ap-south-1` | Supabase DPA (owner to accept in the dashboard) | Built (DEV); prod to create in `ap-south-1` |
| Vercel | Static app only; no personal data at rest; any functions pinned to `bom1` (`vercel.json` → `regions`) | `bom1` (Mumbai) for functions; static assets on the global CDN (no personal data) | Vercel DPA | Built |
| GitHub | Code only — never real data (`AGENTS.md` rule 12); CI uses synthetic data | US (code only) | GitHub terms | Built |
| Backups | Supabase daily backups + PITR in the same region; second copy by an India-hosted `pg_dump` runner | India only | — | Gap until the runner is set up (`docs/DEPLOYMENT_GUIDE.md` → Backups) |
| WhatsApp provider (Meta Cloud API or a BSP) | Customer/staff numbers, message content | **TBD (Q-13)** — prefer a BSP with India hosting | DPA needed | Gap |
| AI model provider (help assistant) | Redacted questions and screen help text only | **TBD (Q-14)** — must be an India-region endpoint | DPA needed | Gap |
| GSP (e-invoice / e-way bill) | Invoice data for IRN | India (GSTN ecosystem) | GSP agreement | Gap until chosen |
| GPS provider (if a vendor device feed is used) | Vehicle/staff location | **TBD** | DPA needed | Gap until chosen |

## 4. Data principal requests — process

1. Request arrives (email/WhatsApp/in person) → Office admin logs it in the Bug fixer as a "privacy request" with the date (the clock starts).
2. Verify identity (staff: employee code + phone; customer: registered contact; never act on an unverified number).
3. **Access:** Admin exports the person's own records (profile, contact, consent history, payslips/attendance for staff; statements for customers). Never include other people's data or figures without GST unless the person is entitled.
4. **Correction:** use the normal edit screens; the audit trail keeps before/after.
5. **Erasure:** clear fields not needed by law (contacts, photos, GPS older than 90 days is already gone, help conversations, marketing consent). Keep books of account, vouchers, GST and payroll records for the statutory period with a note "kept under s.128 Companies Act / s.36 CGST / labour law". Reply to the person explaining what was kept and why.
6. Withdrawal of WhatsApp consent: STOP or untick in Customer KYC — immediate.
7. Reply within the time the Rules set (owner to confirm the service level; target 30 days). Close the Bug fixer item with the reply attached.

## 5. Personal data breach — steps

1. **Contain** (minutes): rotate the Supabase secret key / DB password / provider tokens as relevant; revoke sessions (Auth → sign out all users) if accounts are involved; turn on Vercel Attack Mode if traffic-based.
2. **Assess** (hours): what data, whose, how many people, since when — use `audit.row_history`, `audit.user_log`, Supabase logs.
3. **Notify the Data Protection Board** without delay with the initial facts, and a **detailed report within 72 hours** (nature, extent, timing, likely impact, mitigation, notifications made).
4. **Notify each affected person** without delay, in plain language (English/Malayalam): what happened, likely consequences, what we did, what they can do, the grievance contact.
5. If payment/bank data is involved also inform the bank; if a processor caused it, require their incident report.
6. **Record** in `docs/SECURITY.md` §11 Incident log; review and add a test or control so it cannot recur.

## 6. Gaps to close or accept before go-live

| # | Gap | Owner |
|---|---|---|
| D-1 | Final privacy notice texts (staff, customers, investors; English + Malayalam) and the grievance contact | Owner + legal adviser |
| D-2 | Purge jobs for WhatsApp content (12 months) and help conversations (12 months) | Build (next slice) |
| D-3 | Staff-exit retention rule (KYC copies, contacts) | Owner |
| D-4 | "Erase person" helper for Admin (today: field by field) | Build (next slice) |
| D-5 | Choose WhatsApp, AI, GSP and GPS providers with India hosting and sign DPAs | Owner |
| D-6 | India-hosted second backup copy (`pg_dump` runner) | Owner (infra) |
| D-7 | Accept Supabase and Vercel DPAs in their dashboards | Owner |
