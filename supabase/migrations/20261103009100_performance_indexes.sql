-- 20261103009100_performance_indexes.sql — Phase 9: lists under 1 s at 50,000 rows (Part 1 §28 Phase 9).
-- Measured with scripts/perf-measure.mjs on the synthetic "E2E Perf" company (scripts/perf-seed.mjs); before/after
-- timings in docs/TEST_RESULTS.md → "Phase 9 performance". Additive only: new indexes, new read helpers, and
-- equivalent rewrites of read policies (no policy is widened; each keeps exactly the same rule).
--
-- Why the policies change: RLS predicates such as app.can(company_id, 'accounts.view') call a SECURITY DEFINER
-- function for every row scanned — and api views are security_invoker, so every joined table (companies, GSTINs,
-- parties, user profiles) adds its own per-row calls. At 50k rows that cost seconds. The rewrite evaluates the rule
-- once per query instead (Supabase's documented pattern: wrap the function in a sub-select so it becomes an initPlan):
--   app.can(company_id, R)            ≡  company_id = any ((select app.companies_with(R))::uuid[])
--   app.can_read_company(company_id)  ≡  company_id = any ((select app.readable_companies())::uuid[])
--   app.can_see_bill_class(tax_class) ≡  tax_class not in ('without_gst','unclassified') or (select app.sees_all_classes())
--   app.can_see_party(id)             ≡  (select app.sees_all_classes()) or id in (select app.visible_party_ids())
-- companies_with(R) is literally "every company c for which app.can(c, R)", so the rule is unchanged by construction;
-- the RLS pgTAP files (02, 05, 07, 12, 17, 23, 25) re-prove it.

-- ─────────── Read helpers (evaluated once per statement inside policies) ───────────
create or replace function app.companies_with(p_right text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.id), '{}'::uuid[]) from core.companies c where app.can(c.id, p_right)
$$;

create or replace function app.companies_with_any(p_rights text[]) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.id), '{}'::uuid[]) from core.companies c where exists (select 1 from unnest(p_rights) r where app.can(c.id, r))
$$;

create or replace function app.readable_companies() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.id), '{}'::uuid[]) from core.companies c where app.can_read_company(c.id)
$$;

create or replace function app.sees_all_classes() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.current_view() in ('all', 'all-readonly')
$$;

-- Parties linked to a company the user can see, with sales, purchase or accounts rights there (= app.can_see_party).
create or replace function app.visible_party_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct pc.party_id from master.party_companies pc
  where pc.company_id = any (app.readable_companies())
    and pc.company_id = any (app.companies_with_any(array['sales.view', 'purchase.view', 'accounts.view']))
$$;

revoke all on function app.companies_with(text), app.companies_with_any(text[]), app.readable_companies(), app.sees_all_classes(), app.visible_party_ids() from public, anon;
grant execute on function app.companies_with(text), app.companies_with_any(text[]), app.readable_companies(), app.sees_all_classes(), app.visible_party_ids() to authenticated;

-- ─────────── Equivalent read policies on the large and the always-joined tables ───────────
alter policy companies_read on core.companies using (id = any ((select app.readable_companies())::uuid[]));
alter policy gstins_read on core.gstins using (company_id = any ((select app.readable_companies())::uuid[]));
alter policy branches_read on core.branches using (company_id = any ((select app.readable_companies())::uuid[]));
alter policy fy_read on core.financial_years using (company_id = any ((select app.readable_companies())::uuid[]));
alter policy places_read on core.places using (company_id = any ((select app.readable_companies())::uuid[]));
alter policy pcompanies_read on master.product_companies using (company_id = any ((select app.readable_companies())::uuid[]));
alter policy profiles_read on core.user_profiles using (user_id = (select auth.uid()) or (select app.can(null, 'users.view')));
alter policy grants_read on core.special_grants using (user_id = (select auth.uid()) or (select app.can(null, 'users.view')));
alter policy row_history_read on audit.row_history using ((select app.can(null, 'logs.view')));

alter policy parties_read on master.parties using ((select app.sees_all_classes()) or id in (select app.visible_party_ids()));
alter policy party_companies_read on master.party_companies
  using (company_id = any ((select app.readable_companies())::uuid[]) and ((select app.sees_all_classes()) or party_id in (select app.visible_party_ids())));

alter policy sales_docs_read on sales.documents
  using (company_id = any ((select app.companies_with_any(array['sales_invoices.view', 'sales.view']))::uuid[])
         and (tax_class not in ('without_gst', 'unclassified') or (select app.sees_all_classes())));
alter policy vouchers_read on acct.vouchers
  using ((tax_class not in ('without_gst', 'unclassified') or (select app.sees_all_classes()))
         and (company_id = any ((select app.companies_with('accounts.view'))::uuid[])
              or (mode = 'cash' and company_id = any ((select app.companies_with('cash_book.view'))::uuid[]))));
alter policy gl_read on acct.gl_entries
  using (company_id = any ((select app.companies_with('accounts.view'))::uuid[]) and (tax_class not in ('without_gst', 'unclassified') or (select app.sees_all_classes())));
alter policy open_bills_read on acct.open_bills
  using (company_id = any ((select app.companies_with('accounts.view'))::uuid[]) and (tax_class not in ('without_gst', 'unclassified') or (select app.sees_all_classes())));
alter policy alloc_read on acct.bill_allocations using (company_id = any ((select app.companies_with('accounts.view'))::uuid[]));
alter policy accounts_read on acct.accounts using (company_id = any ((select app.companies_with('accounts.view'))::uuid[]));
alter policy ledger_read on inv.stock_ledger using (company_id = any ((select app.companies_with('inventory.view'))::uuid[]));
alter policy lots_read on inv.lots using (company_id = any ((select app.companies_with_any(array['inventory.view', 'purchase.view', 'qc.test', 'qc.release']))::uuid[]));
alter policy outbox_read on msg.outbox using ((select app.sees_all_classes()) or company_id = any ((select app.companies_with('accounts.view'))::uuid[]));

-- ─────────── Indexes matching the list queries (filter columns first, then the sort order) ───────────
create index if not exists documents_company_date_no_idx on sales.documents (company_id, doc_date desc, doc_no desc);
create index if not exists documents_company_created_idx on sales.documents (company_id, created_at desc);
create index if not exists documents_company_posted_idx on sales.documents (company_id, posted_at desc);
create index if not exists vouchers_company_posted_idx on acct.vouchers (company_id, posted_at desc);
create index if not exists vouchers_company_type_posted_idx on acct.vouchers (company_id, voucher_type, posted_at desc);
create index if not exists vouchers_company_type_date_idx on acct.vouchers (company_id, voucher_type, voucher_date desc);
create index if not exists gl_entries_company_date_id_idx on acct.gl_entries (company_id, entry_date desc, id desc);
create index if not exists gl_entries_company_account_date_id_idx on acct.gl_entries (company_id, account_id, entry_date desc, id desc);
create index if not exists stock_ledger_company_date_id_idx on inv.stock_ledger (company_id, move_date desc, id desc);
create index if not exists stock_ledger_company_id_desc_idx on inv.stock_ledger (company_id, id desc);
create index if not exists stock_ledger_company_product_place_idx on inv.stock_ledger (company_id, product_id, place_id);
create index if not exists bill_allocations_against_amount_idx on acct.bill_allocations (against_kind, against_id) include (amount);
create index if not exists outbox_created_idx on msg.outbox (created_at desc);
create index if not exists outbox_status_created_idx on msg.outbox (status, created_at desc);
create index if not exists outbox_company_event_created_idx on msg.outbox (company_id, event, created_at desc);
create index if not exists row_history_table_at_idx on audit.row_history (table_name, at desc);
create index if not exists party_companies_company_customer_idx on master.party_companies (company_id) where is_customer;

-- ─────────── Sales register totals (server-side, so a paged list still shows the right month totals) ───────────
-- Read-only; RLS applies (security invoker), so a GST-view user's totals never include bills without GST.
create or replace function api.sales_register_totals(p_company_id uuid, p_from date, p_to date)
returns table (tax_class text, doc_type text, docs bigint, taxable numeric, cgst numeric, sgst numeric, igst numeric, cess numeric, total numeric)
language sql stable security invoker set search_path = '' as $$
  select d.tax_class, d.doc_type, count(*), sum(d.taxable)::numeric(18,2), sum(d.cgst)::numeric(18,2), sum(d.sgst)::numeric(18,2), sum(d.igst)::numeric(18,2),
         sum(d.cess)::numeric(18,2), sum(d.total)::numeric(18,2)
  from sales.documents d
  where d.company_id = p_company_id and d.status = 'posted' and d.doc_type <> 'delivery_challan' and d.doc_date between p_from and p_to
  group by d.tax_class, d.doc_type
$$;
revoke all on function api.sales_register_totals(uuid, date, date) from public, anon;
grant execute on function api.sales_register_totals(uuid, date, date) to authenticated;

analyze sales.documents; analyze acct.vouchers; analyze acct.gl_entries; analyze inv.stock_ledger; analyze acct.bill_allocations; analyze msg.outbox; analyze audit.row_history;

notify pgrst, 'reload schema';
