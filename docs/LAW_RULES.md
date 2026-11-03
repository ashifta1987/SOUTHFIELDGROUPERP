# Indian law rules: where each is enforced

The same register is stored in `core.law_rules` and shown on the **Built to Indian law** screen. Rates and thresholds live in `core.settings` with effective dates, never in code. The CA confirms each one before go-live. This is a design checklist, not legal advice.

| Code | Rule | Enforcement point | Test | Status |
|---|---|---|---|---|
| AUD-1 | Audit trail can't be disabled; books in India (Companies (Accounts) Rules, Rule 3(1)) | `app.audit_trigger` on every business table; `app.reject_change` blocks update/delete/truncate on `audit.row_history`; no client writes; DB in ap-south-1 | `supabase/tests/01_audit.sql` | **Built (Phase 1)** |
| VIEW-1 | Bills without GST are in the books but seen only by Admin and the CA | `app.can_see_tax_class` in RLS of every document table | `supabase/tests/02_rights.sql` | **Built (Phase 1)**, applied to document tables from Phase 3 |
| SOD-1 | Nobody approves their own request | Check constraint on `core.special_grant_requests`; `api.decide_special_permission` | `supabase/tests/03_grants.sql` | **Built (Phase 1)** |
| NUM-1 | Tax invoice number unique in the FY, at most 16 characters | `app.take_doc_number` (row lock, `core.doc_numbers_issued`) | `supabase/tests/04_numbering.sql` | **Built (Phase 1)** |
| GST-1 | No taxable sale without GST; a bill without GST needs a lawful reason, Admin only | `api.post_sales_document`, `app.compute_tax` | `07_documents.sql` | **Built (Phase 3)** |
| GST-2 | GST rate by HSN with effective dates | `master.hsn_rates` | — | Needs CA (Phase 2) |
| GST-3 | Place of supply: CGST+SGST / IGST; same GSTIN moves on a delivery challan | `app.compute_tax` (CGST+SGST / IGST) | `07_documents.sql` | Partly built (Phase 3: tax by place of supply; challan with stock in Phase 4) |
| CASH-1 | Cash receipt of ₹2 lakh or more from one person in a day refused | `app.cash_check` in `post_receipt`, `field_collect` (salesman), `shop_sale` (counter); setting `cash.receipt_block_amount` | `08_money_payroll.sql`, `19_field_sales.sql` | **Built (Phase 3)** |
| CASH-2 | Cash payment over ₹10,000 to one person in a day: warning, bank offered | `app.cash_check` in `post_payment`, `give_staff_cash`; setting `cash.payment_warn_amount` | `08_money_payroll.sql`, `10_hr_screens.sql` | **Built (Phase 3)** |
| EINV-1 | E-invoice (IRN) above the turnover threshold | `core.gstins.einvoice_enabled` + Edge Function | — | Needs CA (Phase 8) |
| EWB-1 | E-way bill above the threshold | `api.start_trip` refuses a dispatch without an e-way bill number (`dispatch.eway_required`) unless its value is under setting `eway.threshold_amount` (unset = always required); generation through the portal in Phase 8 | `17_delivery_sales.sql` | Partly built (Phase 6); threshold per state needs CA |
| MSME-1 | Pay within agreed terms, at most 45 days | Purchase RPCs, payables report | — | Planned (Phase 4) |
| LM-1 | Never sell above MRP; label data | `api.post_sales_document` (MRP in force on bill date) | `07_documents.sql` | **Built (Phase 3)** (label data with products/labels later) |
| COS-1 | Cosmetics Rules 2020: expired licence blocks production | `app.check_licence` in `api.plan_batch` and every production entry (`app.lock_batch`); licences in `core.licences`, Admin entry only | `14_production_biochem.sql` | **Built (Phase 5)** |
| PROD-1 | A batch maker cannot QC-release their own batch | `app.batch_makers` in `api.qc_release_batch`, `qc_reject_batch`, `assign_shift_duties`; `record_quality_inspection` (`sod.inspector_maker`) | `14_production_biochem.sql`, `15_production_plastics.sql` | **Built (Phase 5)** |
| PROD-2 | Packaging and bulk reconciliation before close | `app.batch_recon`, `api.reconcile_packaging`, `api.close_batch`; tolerance setting `production.bulk_loss_pct` (unset = exact) | `14_production_biochem.sql` | **Built (Phase 5)** |
| GST-FREE | Free items, gifts, combo packs (CBIC circular 92/11/2019, s.17(5)(h), s.8) | `prod.packs.gst_treatment` set by Admin with the CA's note; trigger `pack_billing_guard` refuses an unset pack on a sales document | `14_production_biochem.sql` | Needs CA (Q-23) |
| LAB-1 | Labour codes: wage slips, overtime, PF/ESI | Payroll RPCs | — | Needs CA (Phase 3) |
| DPDP-1 | DPDP Act 2023: purpose, consent, masking, retention | `api.list_users` masks phone numbers; HR/field tables later | `10_hr_screens.sql`, `11_staff_help.sql` | Partly built (Phase 3: staff Aadhaar/PAN/bank masked, salary reads logged, WhatsApp consent-only, no pay/KYC/bank in staff templates; GPS retention with field sales) |
| GST-RET | Every supply in the returns workings (GSTR-1, GSTR-3B), incl. nil-rated, exempt, non-GST | `api.gstr1_summary`, `api.gstr3b_summary` from posted documents; without-GST sections only in the Admin/CA view | `18_gst_reports.sql` | **Built (Phase 6)**; filing via GSP in Phase 8 |
| EXP-LUT | Export zero-rated under LUT; invoice in foreign currency with INR at the recorded rate | `api.post_export_invoice` (lawful reason `export_lut`, Admin only, valid LUT on the date; else IGST with place of supply 96); `sales.export_invoices` | `17_delivery_sales.sql` | **Built (Phase 6)**; LUT details entered by Admin |
| SCH-III | Schedule III statements | `api.schedule3_statements` via `acct.schedule3_map` (Admin sets, CA confirms) | `18_gst_reports.sql` | Built (Phase 6), mapping needs CA |
| DPDP-GPS | GPS only on duty, after notice, kept 90 days | `field.duty_sessions` (notice required), `api.record_locations` (`gps.off_duty`), `app.purge_gps` + pg_cron `gps-retention-purge` | `19_field_sales.sql` | **Built (Phase 6)** |
| WA-1 | WhatsApp only to verified consented numbers; STOP opts out; utility templates; reminders in business hours | `app.enqueue_message` (skipped without consent), `app.schedule_reminders` (10:00 IST send_after), `app.record_inbound` (STOP), `api.reply_inbound` (24-hour window, consent) | `18_gst_reports.sql` | **Built (Phase 6)** (sending waits for the provider, Q-13) |
