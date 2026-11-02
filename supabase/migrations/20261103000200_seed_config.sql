-- 20261103000200_seed_config.sql
-- Configuration seeds (not business data): roles from §2.4, the rights catalogue (module × action and the
-- special rights from the Users screen), the accountant's starting rights template, document types, forms
-- and the Indian-law rule register. No companies, people, GSTINs, rates or amounts are seeded.
-- Also: a user profile for every auth user, and the bootstrap of Owner/Admin from server-set app_metadata.

insert into core.roles (key, label, view_kind, sign_in, mfa_required, sort) values
  ('owner', 'Owner', 'all', 'both', true, 1),
  ('admin', 'Admin', 'all', 'both', true, 2),
  ('ca', 'CA', 'all-readonly', 'email', true, 3),
  ('auditor', 'Auditor', 'all-readonly', 'email', true, 4),
  ('md', 'Managing Director', 'gst', 'both', true, 10),
  ('gm', 'General Manager', 'gst', 'both', false, 11),
  ('finance_head', 'Finance Head', 'gst', 'both', true, 12),
  ('accountant', 'Accountant', 'gst', 'both', true, 13),
  ('office_admin', 'Office admin', 'gst', 'both', true, 14),
  ('production_manager', 'Production Manager', 'gst', 'phone', false, 20),
  ('chemist', 'Chemist', 'gst', 'phone', false, 21),
  ('qc_releaser', 'QC releaser', 'gst', 'phone', false, 22),
  ('supervisor', 'Supervisor', 'gst', 'phone', false, 23),
  ('factory_staff', 'Factory labour and packing staff', 'gst', 'phone', false, 24),
  ('mould_manager', 'Mould manager', 'gst', 'phone', false, 30),
  ('injection_manager', 'Injection manager', 'gst', 'phone', false, 31),
  ('assembly', 'Assembly', 'gst', 'phone', false, 32),
  ('quality', 'Quality', 'gst', 'phone', false, 33),
  ('machine_operator', 'Machine operator', 'gst', 'phone', false, 34),
  ('buyer_logistics', 'Buying, logistics and petty cash', 'gst', 'phone', false, 40),
  ('factory_manager', 'Factory manager and working partner', 'gst', 'phone', false, 41),
  ('sales_manager', 'Sales manager', 'gst', 'phone', false, 50),
  ('salesman', 'Salesman', 'gst', 'phone', false, 51),
  ('shop_staff', 'Shop staff', 'gst', 'phone', false, 52),
  ('driver', 'Driver', 'gst', 'phone', false, 53),
  ('designer', 'Designer', 'gst', 'phone', false, 60),
  ('digital_marketer', 'Digital marketer', 'gst', 'phone', false, 61),
  ('admin_assistant', 'Admin assistant', 'gst', 'phone', false, 62),
  ('staff', 'Employee (staff app)', 'gst', 'phone', false, 90),
  ('investor', 'Partner / investor', 'gst', 'both', true, 95);

-- Module rights: view / create / edit / cancel / approve / export for each module.
insert into core.rights (key, module, action, label, sort)
select m.module || '.' || a.action, m.module, a.action, m.label || ' · ' || a.label, m.sort * 10 + a.sort
from (values
  ('cash_book', 'Cash book', 1), ('sales_invoices', 'Sales invoices', 2), ('purchase_bills', 'Purchase bills', 3),
  ('receipts_payments', 'Receipts and payments', 4), ('gst', 'GST page', 5), ('reports', 'Reports', 6),
  ('inventory', 'Inventory', 7), ('production', 'Production', 8), ('sales', 'Sales', 9), ('purchase', 'Purchase', 10),
  ('logistics', 'Logistics', 11), ('exports', 'Exports', 12), ('hr', 'HR and payroll', 13), ('accounts', 'Accounts', 14)
) as m(module, label, sort)
cross join (values ('view', 'View', 1), ('create', 'Create', 2), ('edit', 'Edit', 3), ('cancel', 'Cancel', 4), ('approve', 'Approve', 5), ('export', 'Export', 6)) as a(action, label, sort);

insert into core.rights (key, module, action, label, sort) values
  ('home.view', 'home', 'view', 'Home', 1),
  ('staff.self', 'staff', 'self', 'Own staff app (pay, leave, details)', 2),
  ('admin.view', 'admin', 'view', 'Admin menu (read)', 900),
  ('org.view', 'org', 'view', 'Companies, branches, GSTINs and places (read)', 901),
  ('users.view', 'users', 'view', 'Users and rights (read)', 902),
  ('logs.view', 'logs', 'view', 'User log and transaction log', 903),
  ('settings.view', 'settings', 'view', 'Settings and numbering (read)', 904);

-- Special rights (Users screen, right panel; Special permissions screen).
insert into core.rights (key, module, action, label, hint, kind, admin_only, never_grantable, grantable_by_permission, sort) values
  ('tax.enter_without_gst', 'tax', 'enter_without_gst', 'Enter sales or purchases without GST', 'Admin only · lawful reason required · cannot be given to anyone else', 'special', true, true, false, 1000),
  ('tax.view_without_gst', 'tax', 'view_without_gst', 'See transactions without GST', 'Automatic for Admin, read-only for the CA · nobody else', 'special', true, true, false, 1001),
  ('tax.override', 'tax', 'override', 'Change tax treatment', 'Rate or HSN on a bill line · still needs a second approver', 'special', false, false, true, 1002),
  ('cost.view', 'cost', 'view', 'See cost and margin', 'Cost sheets, stock value, profitability', 'special', false, false, false, 1003),
  ('payroll.run', 'payroll', 'run', 'See and run payroll', 'Salaries, advances and payslips', 'special', false, false, true, 1004),
  ('kyc.view', 'kyc', 'view', 'View KYC documents', 'Staff, supplier and buyer ID proofs', 'special', false, false, false, 1005),
  ('data.import', 'data', 'import', 'Load Tally data', 'Upload and check Tally files', 'special', false, false, true, 1006),
  ('data.export', 'data', 'export', 'Export data', 'Download lists and reports', 'special', false, false, true, 1007),
  ('period.reopen', 'period', 'reopen', 'Reopen a closed day or month', 'Change entries after the close', 'special', false, false, true, 1008),
  ('entries.backdate', 'entries', 'backdate', 'Back-date entries', 'Enter or edit entries dated in the past', 'special', false, false, true, 1009),
  ('payments.approve', 'payments', 'approve', 'Approve payments', 'Approve bills and payments up to a limit', 'special', false, false, true, 1010),
  ('cash.pay_over_limit', 'cash', 'pay_over_limit', 'Pay in cash above the daily limit', 'For one person in one day · reason seen by Admin', 'special', false, false, true, 1011),
  ('bugfix.fix', 'bugfix', 'fix', 'Fix in books', 'Close problems from Tally loads', 'special', false, false, true, 1012),
  ('users.manage', 'users', 'manage', 'Manage users and rights', 'Admin only', 'special', true, true, false, 1013),
  ('org.manage', 'org', 'manage', 'Add companies, branches and GSTINs', 'Admin only', 'special', true, false, false, 1014),
  ('tasks.manage', 'tasks', 'manage', 'Create tasks and assign them', 'Admin only · staff see their own tasks', 'special', true, false, false, 1015),
  ('forms.manage', 'forms', 'manage', 'Add tabs, forms and fields', 'Admin only · every change is logged', 'special', true, false, false, 1016),
  ('products.manage', 'products', 'manage', 'Add products, groups and prices', 'Admin only · see Product master', 'special', true, false, false, 1017),
  ('online.publish', 'online', 'publish', 'Publish products to online stores', 'Admin only', 'special', true, false, false, 1018),
  ('backup.restore', 'backup', 'restore', 'Restore a backup', 'Admin only, with a second code', 'special', true, true, false, 1019),
  ('settings.manage', 'settings', 'manage', 'Change settings and numbering', 'Admin only', 'special', true, false, false, 1020),
  -- The never-grantable list from §6: nobody can be given these, not even under a special permission.
  ('audit.disable', 'audit', 'disable', 'Turn off or edit the audit trail', 'Never allowed (Companies (Accounts) Rules, Rule 3(1))', 'special', true, true, false, 1100),
  ('posted.delete', 'posted', 'delete', 'Delete a posted entry', 'Never allowed · post a reversal instead', 'special', true, true, false, 1101),
  ('period.edit_closed', 'period', 'edit_closed', 'Edit a closed period directly', 'Never allowed · reopen under a permission instead', 'special', true, true, false, 1102),
  ('returns.edit_filed', 'returns', 'edit_filed', 'Change filed returns', 'Never allowed', 'special', true, true, false, 1103),
  ('secrets.view', 'secrets', 'view', 'View passwords or secrets', 'Never allowed', 'special', true, true, false, 1104),
  ('rights.give', 'rights', 'give', 'Give out rights', 'Never allowed as a special permission', 'special', true, true, false, 1105);

-- Everyone signed in sees Home; staff-app roles get their own staff app.
insert into core.role_rights (role_key, right_key)
select r.key, 'home.view' from core.roles r where r.view_kind = 'gst';
insert into core.role_rights (role_key, right_key)
select r.key, 'staff.self' from core.roles r where r.view_kind = 'gst' and r.key not in ('investor');

-- Accountant starting rights (template shown on the Users screen; Admin can change it per role).
insert into core.role_rights (role_key, right_key) values
  ('accountant', 'cash_book.view'), ('accountant', 'cash_book.create'), ('accountant', 'cash_book.edit'), ('accountant', 'cash_book.approve'), ('accountant', 'cash_book.export'),
  ('accountant', 'sales_invoices.view'), ('accountant', 'sales_invoices.create'), ('accountant', 'sales_invoices.edit'), ('accountant', 'sales_invoices.cancel'), ('accountant', 'sales_invoices.approve'), ('accountant', 'sales_invoices.export'),
  ('accountant', 'purchase_bills.view'), ('accountant', 'purchase_bills.create'), ('accountant', 'purchase_bills.edit'), ('accountant', 'purchase_bills.cancel'), ('accountant', 'purchase_bills.approve'), ('accountant', 'purchase_bills.export'),
  ('accountant', 'receipts_payments.view'), ('accountant', 'receipts_payments.create'), ('accountant', 'receipts_payments.edit'), ('accountant', 'receipts_payments.approve'), ('accountant', 'receipts_payments.export'),
  ('accountant', 'gst.view'), ('accountant', 'gst.export'),
  ('accountant', 'reports.view'), ('accountant', 'reports.export'),
  ('accountant', 'inventory.view'), ('accountant', 'production.view'),
  ('accountant', 'accounts.view'), ('accountant', 'sales.view'), ('accountant', 'purchase.view'),
  ('accountant', 'data.export');

-- Office admin: runs the office, GST view only; no rights to give, no restore, nothing without GST.
insert into core.role_rights (role_key, right_key) values
  ('office_admin', 'admin.view'), ('office_admin', 'org.view'), ('office_admin', 'users.view'), ('office_admin', 'settings.view'),
  ('office_admin', 'sales.view'), ('office_admin', 'purchase.view'), ('office_admin', 'inventory.view'), ('office_admin', 'hr.view'),
  ('office_admin', 'gst.view'), ('office_admin', 'reports.view');

insert into core.doc_types (key, label, gst_document, max_number_length, sort) values
  ('sales_invoice', 'Sales tax invoice', true, 16, 1),
  ('bill_of_supply', 'Bill of supply', true, 16, 2),
  ('delivery_challan', 'Delivery challan', true, 16, 3),
  ('credit_note', 'Credit note', true, 16, 4),
  ('debit_note', 'Debit note', true, 16, 5),
  ('export_invoice', 'Export invoice', true, 16, 6),
  ('receipt', 'Receipt voucher', false, 20, 10),
  ('payment', 'Payment voucher', false, 20, 11),
  ('journal', 'Journal voucher', false, 20, 12),
  ('contra', 'Contra voucher', false, 20, 13),
  ('purchase_order', 'Purchase order', false, 20, 20),
  ('goods_receipt', 'Goods receipt', false, 20, 21),
  ('stock_transfer', 'Stock transfer', false, 20, 22),
  ('sales_order', 'Sales order', false, 20, 23),
  ('quotation', 'Quotation', false, 20, 24),
  ('batch', 'Production batch', false, 20, 30);

insert into core.forms (key, label, module) values
  ('customer', 'Customer', 'sales'), ('supplier', 'Supplier', 'purchase'), ('product', 'Product', 'inventory'),
  ('staff', 'Staff', 'hr'), ('sales_invoice', 'Sales invoice', 'sales'), ('goods_receipt', 'Goods receipt', 'purchase');

-- Indian-law register (rules and where they are enforced). Rates and thresholds live in settings, never here.
insert into core.law_rules (code, area, rule, what_erp_does, enforced_in, test_ref, status, phase, sort) values
  ('AUD-1', 'Audit trail', 'Audit trail that cannot be disabled; books kept in India (Companies (Accounts) Rules, Rule 3(1))', 'Append-only row history written by triggers; update/delete rejected; database in Mumbai', 'audit.row_history, app.audit_trigger, app.reject_change', 'supabase/tests/01_audit.sql', 'built', 1, 1),
  ('VIEW-1', 'GST view', 'Bills without GST are recorded in the books but seen only by Admin and the CA', 'Row-level security through app.can_see_tax_class on every document table', 'app.can_see_tax_class', 'supabase/tests/02_rights.sql', 'built', 1, 2),
  ('SOD-1', 'Segregation of duties', 'Nobody approves their own request', 'Check constraint and RPC check on special permission requests', 'core.special_grant_requests, api.decide_special_permission', 'supabase/tests/03_grants.sql', 'built', 1, 3),
  ('NUM-1', 'GST invoice numbers', 'A tax invoice number is unique in the FY and at most 16 characters', 'Gap-free series per company, GSTIN, document type and FY taken under a row lock', 'app.take_doc_number, core.doc_numbers_issued', 'supabase/tests/04_numbering.sql', 'built', 1, 4),
  ('GST-1', 'GST', 'No taxable sale without GST; a bill without GST needs a lawful reason and only Admin can create one', 'Posting RPC refuses taxable HSNs without GST; reasons from a fixed list', 'sales posting RPCs', null, 'planned', 3, 10),
  ('GST-2', 'GST rates', 'GST rate by HSN with effective dates', 'HSN rate table with effective dates; CA confirms every rate', 'master.hsn_rates', null, 'needs_ca', 2, 11),
  ('GST-3', 'Place of supply', 'Same state: CGST + SGST; another state: IGST; same GSTIN moves on a delivery challan', 'Server computes the tax split from the GSTINs; challan vs IGST invoice for branch moves', 'sales posting RPCs', null, 'planned', 3, 12),
  ('CASH-1', 'Cash receipts', 'A cash receipt of ₹2 lakh or more from one person in a day is refused', 'Cash book RPC refuses; threshold kept in settings', 'cash book RPC', null, 'planned', 3, 20),
  ('CASH-2', 'Cash payments', 'Cash payment over ₹10,000 to one person in a day is not deductible', 'Warning with bank payment offered; paying in cash needs a reason Admin sees', 'cash book RPC', null, 'planned', 3, 21),
  ('EINV-1', 'E-invoice', 'IRN for B2B once turnover passes the threshold', 'Switch per GSTIN; IRN fetched before the invoice is final', 'core.gstins.einvoice_enabled, Edge Function', null, 'needs_ca', 8, 30),
  ('EWB-1', 'E-way bill', 'E-way bill above the threshold value', 'Created at dispatch; thresholds per state in settings', 'dispatch RPC', null, 'planned', 8, 31),
  ('MSME-1', 'MSME', 'Payment within agreed terms, at most 45 days', 'Due-date alerts and MSME payables report', 'purchase RPCs', null, 'planned', 4, 40),
  ('LM-1', 'Legal Metrology', 'Never sell above MRP; label carries maker, net quantity and MRP', 'Bill refuses a price above MRP', 'sales posting RPCs', null, 'planned', 3, 50),
  ('COS-1', 'Cosmetics Rules 2020', 'Made under licence; an expired licence blocks production entry', 'Licence on product and label; production RPC checks expiry', 'production RPCs', null, 'planned', 5, 51),
  ('LAB-1', 'Labour codes', 'Wage slip for every worker; overtime at twice the rate; PF/ESI by headcount', 'Payslips and payroll settings', 'payroll RPCs', null, 'needs_ca', 3, 60),
  ('DPDP-1', 'DPDP Act 2023', 'Purpose, notice, consent, masking and retention for personal data', 'Aadhaar last 4 only; bank numbers masked; GPS on duty, 90 days', 'hr/field tables', null, 'planned', 3, 70);

-- ─────────── Profiles for auth users, and the Owner/Admin bootstrap ───────────
-- A profile row is created for every new auth user. If the account was created with a server-set
-- app_metadata.role (only the service role can set it), that role is assigned once, for all companies.
create or replace function app.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_role text := new.raw_app_meta_data ->> 'role';
begin
  insert into core.user_profiles (user_id, display_name, language)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1), right(coalesce(new.phone, ''), 4), 'User'),
    coalesce(nullif(new.raw_user_meta_data ->> 'language', ''), 'en')
  )
  on conflict (user_id) do nothing;
  if v_role is not null and exists (select 1 from core.roles where key = v_role) then
    insert into core.user_roles (user_id, role_key, company_id) values (new.id, v_role, null) on conflict do nothing;
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users for each row execute function app.on_auth_user_created();

-- Backfill existing accounts.
insert into core.user_profiles (user_id, display_name, language)
select u.id,
       coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(u.email, ''), '@', 1), 'User'),
       coalesce(nullif(u.raw_user_meta_data ->> 'language', ''), 'en')
from auth.users u
on conflict (user_id) do nothing;

insert into core.user_roles (user_id, role_key, company_id)
select u.id, u.raw_app_meta_data ->> 'role', null
from auth.users u
where exists (select 1 from core.roles r where r.key = u.raw_app_meta_data ->> 'role')
on conflict do nothing;

-- Group-wide limits Admin fixes for everyone (Special permissions screen). Values are left unset for the owner/CA,
-- except the longest permission window, which the design fixes at 7 days.
insert into core.settings (company_id, key, value, note) values
  (null, 'grants.max_days', '7'::jsonb, 'Longest special permission (Special permissions screen)');

