# Indian law rules: where each is enforced

The same register is stored in `core.law_rules` and shown on the **Built to Indian law** screen. Rates and thresholds live in `core.settings` with effective dates, never in code. The CA confirms each one before go-live. This is a design checklist, not legal advice.

| Code | Rule | Enforcement point | Test | Status |
|---|---|---|---|---|
| AUD-1 | Audit trail can't be disabled; books in India (Companies (Accounts) Rules, Rule 3(1)) | `app.audit_trigger` on every business table; `app.reject_change` blocks update/delete/truncate on `audit.row_history`; no client writes; DB in ap-south-1 | `supabase/tests/01_audit.sql` | **Built (Phase 1)** |
| VIEW-1 | Bills without GST are in the books but seen only by Admin and the CA | `app.can_see_tax_class` in RLS of every document table | `supabase/tests/02_rights.sql` | **Built (Phase 1)**, applied to document tables from Phase 3 |
| SOD-1 | Nobody approves their own request | Check constraint on `core.special_grant_requests`; `api.decide_special_permission` | `supabase/tests/03_grants.sql` | **Built (Phase 1)** |
| NUM-1 | Tax invoice number unique in the FY, at most 16 characters | `app.take_doc_number` (row lock, `core.doc_numbers_issued`) | `supabase/tests/04_numbering.sql` | **Built (Phase 1)** |
| GST-1 | No taxable sale without GST; a bill without GST needs a lawful reason, Admin only | Sales posting RPCs | — | Planned (Phase 3) |
| GST-2 | GST rate by HSN with effective dates | `master.hsn_rates` | — | Needs CA (Phase 2) |
| GST-3 | Place of supply: CGST+SGST / IGST; same GSTIN moves on a delivery challan | Sales posting RPCs | — | Planned (Phase 3) |
| CASH-1 | Cash receipt of ₹2 lakh or more from one person in a day refused | Cash book RPC; amount in settings | — | Planned (Phase 3) |
| CASH-2 | Cash payment over ₹10,000 to one person in a day: warning, bank offered | Cash book RPC; amount in settings | — | Planned (Phase 3) |
| EINV-1 | E-invoice (IRN) above the turnover threshold | `core.gstins.einvoice_enabled` + Edge Function | — | Needs CA (Phase 8) |
| EWB-1 | E-way bill above the threshold | Dispatch RPC; thresholds per state in settings | — | Planned (Phase 8) |
| MSME-1 | Pay within agreed terms, at most 45 days | Purchase RPCs, payables report | — | Planned (Phase 4) |
| LM-1 | Never sell above MRP; label data | Sales posting RPCs | — | Planned (Phase 3) |
| COS-1 | Cosmetics Rules 2020: expired licence blocks production | Production RPCs | — | Planned (Phase 5) |
| LAB-1 | Labour codes: wage slips, overtime, PF/ESI | Payroll RPCs | — | Needs CA (Phase 3) |
| DPDP-1 | DPDP Act 2023: purpose, consent, masking, retention | `api.list_users` masks phone numbers; HR/field tables later | — | Partly built (Phase 1: masking in user lists) |

