-- 20261103003300_law_rules_phase3.sql
-- Phase 3 law register status: rules now enforced inside the posting RPCs and covered by pgTAP.
-- Additive data change only (status/enforced_in/test_ref text on core.law_rules).

update core.law_rules set status = 'built',
  enforced_in = 'api.post_sales_document (tax from HSN by date; without GST only Admin with a lawful reason)',
  test_ref = 'supabase/tests/07_documents.sql'
where code = 'GST-1';

update core.law_rules set -- stays 'planned' until fully built (status allows planned/built/needs_ca)
  enforced_in = 'app.compute_tax (CGST+SGST in the state, IGST across states). Delivery challan for same-GSTIN moves arrives with stock in Phase 4.',
  test_ref = 'supabase/tests/07_documents.sql'
where code = 'GST-3';

update core.law_rules set status = 'built',
  enforced_in = 'app.cash_check via api.post_receipt / post_sales receipts; limit in setting cash.receipt_block_amount',
  test_ref = 'supabase/tests/08_money_payroll.sql'
where code = 'CASH-1';

update core.law_rules set status = 'built',
  enforced_in = 'app.cash_check via api.post_payment / api.give_staff_cash (reason required, flagged for Admin); limit in setting cash.payment_warn_amount',
  test_ref = 'supabase/tests/08_money_payroll.sql, supabase/tests/10_hr_screens.sql'
where code = 'CASH-2';

update core.law_rules set status = 'built',
  enforced_in = 'api.post_sales_document refuses a unit price including tax above the MRP in force on the bill date',
  test_ref = 'supabase/tests/07_documents.sql'
where code = 'LM-1';

update core.law_rules set -- stays 'planned' until fully built (status allows planned/built/needs_ca)
  enforced_in = 'User lists mask phones; staff Aadhaar/PAN/bank stored or shown masked (api.save_staff, api.staff_kyc); salary reads logged; WhatsApp only to consented numbers (api.set_allow_list); staff templates refuse pay/KYC/bank words. GPS retention arrives with field sales.',
  test_ref = 'supabase/tests/10_hr_screens.sql, supabase/tests/11_staff_help.sql'
where code = 'DPDP-1';
