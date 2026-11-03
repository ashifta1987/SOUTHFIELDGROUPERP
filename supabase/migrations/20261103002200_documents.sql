-- 20261103002200_documents.sql
-- Phase 3: sales documents (tax invoice, bill of supply, delivery challan, credit note) and purchase bills with GST
-- computed only in Postgres: rate from the HSN table on the document date, CGST+SGST inside the state or IGST across
-- states (place of supply), MRP check, due date from terms, lawful reason for bills without GST (Admin only),
-- gap-free numbers at posting, balanced GL through posting rules, and the WhatsApp outbox row in the same
-- transaction. Posted documents are never edited: corrections are credit notes or reversals. Additive.

create table sales.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin_id uuid not null references core.gstins (id),
  doc_type text not null check (doc_type in ('sales_invoice', 'bill_of_supply', 'delivery_challan', 'credit_note')),
  doc_no text,
  doc_date date not null,
  party_id uuid not null references master.parties (id),
  place_of_supply char(2) not null,
  tax_class text not null default 'taxable' check (tax_class in ('taxable', 'without_gst')),
  lawful_reason text check (lawful_reason in ('exempt_or_nil', 'non_gst', 'export_lut', 'challan_not_sold')),
  against_id uuid references sales.documents (id),
  reason text,
  terms_days int not null default 0,
  due_date date,
  taxable numeric(18, 2) not null default 0,
  cgst numeric(18, 2) not null default 0,
  sgst numeric(18, 2) not null default 0,
  igst numeric(18, 2) not null default 0,
  cess numeric(18, 2) not null default 0,
  round_off numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'posted', 'cancelled')),
  voucher_id uuid references acct.vouchers (id),
  irn text,
  eway_bill_no text,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  posted_by uuid references auth.users (id),
  unique (company_id, gstin_id, doc_type, doc_no),
  check (tax_class = 'taxable' or lawful_reason is not null)
);
create index on sales.documents (company_id, doc_date);
create index on sales.documents (party_id);

create table sales.document_lines (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references sales.documents (id) on delete cascade,
  line_no int not null,
  product_id uuid references master.products (id),
  description text not null,
  hsn_code text,
  uom text not null default 'NOS',
  qty numeric(18, 3) not null check (qty > 0),
  rate numeric(18, 2) not null check (rate >= 0),
  discount numeric(18, 2) not null default 0 check (discount >= 0),
  taxable numeric(18, 2) not null default 0,
  gst_rate numeric(9, 4) not null default 0,
  cgst numeric(18, 2) not null default 0,
  sgst numeric(18, 2) not null default 0,
  igst numeric(18, 2) not null default 0,
  cess numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  unique (document_id, line_no)
);

create table purch.bills (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin_id uuid not null references core.gstins (id),
  party_id uuid not null references master.parties (id),
  supplier_bill_no text not null,
  supplier_bill_date date not null,
  bill_date date not null,
  doc_no text,
  place_of_supply char(2) not null,
  itc_eligible boolean not null default true,
  reverse_charge boolean not null default false,
  terms_days int not null default 0,
  due_date date,
  msme_due boolean not null default false,
  taxable numeric(18, 2) not null default 0,
  cgst numeric(18, 2) not null default 0,
  sgst numeric(18, 2) not null default 0,
  igst numeric(18, 2) not null default 0,
  cess numeric(18, 2) not null default 0,
  round_off numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'posted', 'cancelled')),
  voucher_id uuid references acct.vouchers (id),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  unique (company_id, party_id, supplier_bill_no)
);
create index on purch.bills (company_id, bill_date);
create index on purch.bills (party_id);

create table purch.bill_lines (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references purch.bills (id) on delete cascade,
  line_no int not null,
  product_id uuid references master.products (id),
  account_id uuid references acct.accounts (id),
  description text not null,
  hsn_code text,
  uom text not null default 'NOS',
  qty numeric(18, 3) not null check (qty > 0),
  rate numeric(18, 2) not null check (rate >= 0),
  discount numeric(18, 2) not null default 0,
  taxable numeric(18, 2) not null default 0,
  gst_rate numeric(9, 4) not null default 0,
  cgst numeric(18, 2) not null default 0,
  sgst numeric(18, 2) not null default 0,
  igst numeric(18, 2) not null default 0,
  cess numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  unique (bill_id, line_no)
);

-- Posted headers and lines can no longer change (except status → cancelled through the reversal RPC).
create or replace function app.lock_posted_doc() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and old.status <> 'draft' then
    raise exception 'posted documents are never deleted; reverse instead' using errcode = 'P0001', hint = 'posting.no_delete';
  end if;
  if tg_op = 'UPDATE' and old.status = 'posted' and (new.status = 'posted' or new.total <> old.total or new.doc_no is distinct from old.doc_no) and current_setting('app.allow_posted_update', true) is distinct from 'on' then
    raise exception 'a posted document cannot be edited; issue a credit note or reverse it' using errcode = 'P0001', hint = 'posting.locked';
  end if;
  return coalesce(new, old);
end $$;
create trigger sales_doc_lock before update or delete on sales.documents for each row execute function app.lock_posted_doc();
create trigger purch_bill_lock before update or delete on purch.bills for each row execute function app.lock_posted_doc();

create or replace function app.lock_posted_lines() returns trigger
language plpgsql set search_path = '' as $$
declare v_status text;
begin
  if tg_table_name = 'document_lines' then select status into v_status from sales.documents where id = coalesce(new.document_id, old.document_id);
  else select status into v_status from purch.bills where id = coalesce(new.bill_id, old.bill_id); end if;
  if v_status is distinct from 'draft' then
    raise exception 'lines of a posted document cannot change' using errcode = 'P0001', hint = 'posting.locked';
  end if;
  return coalesce(new, old);
end $$;
create trigger sales_lines_lock before insert or update or delete on sales.document_lines for each row execute function app.lock_posted_lines();
create trigger purch_lines_lock before insert or update or delete on purch.bill_lines for each row execute function app.lock_posted_lines();

do $$
declare t text;
begin
  foreach t in array array['sales.documents', 'sales.document_lines', 'purch.bills', 'purch.bill_lines'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on %s from anon, authenticated', t);
    execute format('grant select on %s to authenticated', t);
  end loop;
end $$;
create policy sales_docs_read on sales.documents for select to authenticated
  using ((app.can(company_id, 'sales_invoices.view') or app.can(company_id, 'sales.view')) and app.can_see_bill_class(tax_class));
create policy sales_lines_read on sales.document_lines for select to authenticated
  using (exists (select 1 from sales.documents d where d.id = document_id and (app.can(d.company_id, 'sales_invoices.view') or app.can(d.company_id, 'sales.view')) and app.can_see_bill_class(d.tax_class)));
create policy purch_bills_read on purch.bills for select to authenticated using (app.can(company_id, 'purchase_bills.view') or app.can(company_id, 'purchase.view'));
create policy purch_lines_read on purch.bill_lines for select to authenticated
  using (exists (select 1 from purch.bills b where b.id = bill_id and (app.can(b.company_id, 'purchase_bills.view') or app.can(b.company_id, 'purchase.view'))));

-- ─────────── Tax computation (the only place GST is worked out) ───────────
-- lines: [{product_id, description, hsn_code, uom, qty, rate, discount}] → computed lines + totals.
create or replace function app.compute_tax(p_our_state text, p_pos text, p_date date, p_without_gst boolean, p_lines jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  l jsonb; v_out jsonb := '[]'::jsonb; v_hsn text; v_rate numeric; v_class text; v_taxable numeric; v_tax numeric; v_c numeric; v_s numeric; v_i numeric;
  t_taxable numeric := 0; t_c numeric := 0; t_s numeric := 0; t_i numeric := 0; v_total numeric; v_round numeric; v_n int := 0; v_uom text; v_desc text;
  v_intra boolean := p_our_state = p_pos;
begin
  for l in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    select coalesce(nullif(l ->> 'hsn_code', ''), p.hsn_code), coalesce(nullif(l ->> 'uom', ''), p.uom), coalesce(nullif(l ->> 'description', ''), p.name)
      into v_hsn, v_uom, v_desc
    from (select 1) x left join master.products p on p.id = nullif(l ->> 'product_id', '')::uuid;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('doc.qty', 'every line needs a quantity above zero', '22023'); end if;
    v_taxable := round((l ->> 'qty')::numeric * coalesce((l ->> 'rate')::numeric, 0) - coalesce((l ->> 'discount')::numeric, 0), 2);
    if v_taxable < 0 then perform app.raise_rule('doc.discount', 'a discount cannot be more than the line value', '22023'); end if;
    v_rate := 0; v_class := 'taxable';
    if v_hsn is not null then
      select r.rate, r.tax_class into v_rate, v_class from master.hsn_rates r
       where r.hsn_code = v_hsn and r.effective_from <= p_date and (r.effective_to is null or r.effective_to >= p_date) order by r.effective_from desc limit 1;
    end if;
    if not p_without_gst and v_rate is null then
      perform app.raise_rule('gst.no_rate', 'no GST rate for HSN ' || coalesce(v_hsn, '(none)') || ' on this date; set it on Product master → HSN and GST rates', '22023');
    end if;
    if p_without_gst then v_rate := 0; end if;
    v_tax := round(v_taxable * coalesce(v_rate, 0) / 100, 2);
    if v_intra then v_c := round(v_tax / 2, 2); v_s := v_tax - v_c; v_i := 0; else v_c := 0; v_s := 0; v_i := v_tax; end if;
    t_taxable := t_taxable + v_taxable; t_c := t_c + v_c; t_s := t_s + v_s; t_i := t_i + v_i;
    v_out := v_out || jsonb_build_object('line_no', v_n, 'product_id', nullif(l ->> 'product_id', ''), 'description', v_desc, 'hsn_code', v_hsn, 'uom', coalesce(v_uom, 'NOS'),
      'qty', (l ->> 'qty')::numeric, 'rate', coalesce((l ->> 'rate')::numeric, 0), 'discount', coalesce((l ->> 'discount')::numeric, 0), 'taxable', v_taxable,
      'gst_rate', coalesce(v_rate, 0), 'tax_class', coalesce(v_class, 'taxable'), 'cgst', v_c, 'sgst', v_s, 'igst', v_i, 'cess', 0, 'total', v_taxable + v_tax);
  end loop;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'add at least one line', '22023'); end if;
  v_total := t_taxable + t_c + t_s + t_i;
  v_round := round(v_total) - v_total;
  return jsonb_build_object('lines', v_out, 'taxable', t_taxable, 'cgst', t_c, 'sgst', t_s, 'igst', t_i, 'cess', 0, 'round_off', v_round, 'total', v_total + v_round,
                            'intra_state', v_intra, 'amount_in_words', app.amount_in_words(v_total + v_round));
end $$;

-- Live preview for the document screen: the same function the posting uses (the browser never computes tax).
create or replace function api.preview_tax(p_gstin_id uuid, p_party_id uuid, p_place_of_supply text, p_date date, p_without_gst boolean, p_lines jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_our text; v_pos text;
begin
  select state_code into v_our from core.gstins where id = p_gstin_id;
  v_pos := coalesce(nullif(p_place_of_supply, ''), (select state_code from master.parties where id = p_party_id), v_our);
  return app.compute_tax(v_our, v_pos, coalesce(p_date, current_date), coalesce(p_without_gst, false), p_lines) || jsonb_build_object('place_of_supply', v_pos, 'our_state', v_our);
end $$;

-- ─────────── Sales documents ───────────
-- Save (create or replace) a draft: header + lines; the server computes and stores the tax.
create or replace function api.save_sales_draft(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_gstin core.gstins; v_party master.parties; v_calc jsonb;
  v_pos text; v_type text := coalesce(p ->> 'doc_type', 'sales_invoice'); v_without boolean; v_terms int := 0; v_res jsonb; l jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'save_sales_draft'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then
    select company_id into v_company from sales.documents where id = v_id and status = 'draft' for update;
    if v_company is null then perform app.raise_rule('posting.locked', 'only drafts can be changed', '22023'); end if;
  end if;
  perform app.require(v_company, 'sales_invoices.create');
  select * into v_gstin from core.gstins where id = (p ->> 'gstin_id')::uuid and company_id = v_company;
  if v_gstin.id is null then perform app.raise_rule('org.gstin_other_company', 'choose a GSTIN of this company', '22023'); end if;
  select * into v_party from master.parties where id = (p ->> 'party_id')::uuid;
  if v_party.id is null or not v_party.is_customer then perform app.raise_rule('party.missing', 'choose a customer', '22023'); end if;
  v_without := v_type in ('bill_of_supply', 'delivery_challan');
  if v_without and not app.is_admin() then perform app.raise_rule('gst.without_admin_only', 'only Admin can make a document without GST', '42501'); end if;
  v_pos := coalesce(nullif(p ->> 'place_of_supply', ''), v_party.state_code, v_gstin.state_code);
  select coalesce(t.days, 0) into v_terms from master.party_companies pc left join master.credit_terms t on t.id = pc.credit_term_id where pc.party_id = v_party.id and pc.company_id = v_company;
  v_calc := app.compute_tax(v_gstin.state_code, v_pos, (p ->> 'doc_date')::date, v_without, coalesce(p -> 'lines', '[]'::jsonb));
  if v_id is null then
    insert into sales.documents (company_id, gstin_id, doc_type, doc_date, party_id, place_of_supply, tax_class, lawful_reason, against_id, reason, terms_days, notes, created_by)
    values (v_company, v_gstin.id, v_type, (p ->> 'doc_date')::date, v_party.id, v_pos, case when v_without then 'without_gst' else 'taxable' end,
            case when v_without then coalesce(nullif(p ->> 'lawful_reason', ''), case when v_type = 'delivery_challan' then 'challan_not_sold' end) end,
            nullif(p ->> 'against_id', '')::uuid, nullif(p ->> 'reason', ''), coalesce(v_terms, 0), nullif(p ->> 'notes', ''), auth.uid())
    returning id into v_id;
  else
    delete from sales.document_lines where document_id = v_id;
    update sales.documents set gstin_id = v_gstin.id, doc_type = v_type, doc_date = (p ->> 'doc_date')::date, party_id = v_party.id, place_of_supply = v_pos,
      tax_class = case when v_without then 'without_gst' else 'taxable' end,
      lawful_reason = case when v_without then coalesce(nullif(p ->> 'lawful_reason', ''), case when v_type = 'delivery_challan' then 'challan_not_sold' end) end,
      against_id = nullif(p ->> 'against_id', '')::uuid, reason = nullif(p ->> 'reason', ''), terms_days = coalesce(v_terms, 0), notes = nullif(p ->> 'notes', '')
    where id = v_id;
  end if;
  for l in select * from jsonb_array_elements(v_calc -> 'lines') loop
    insert into sales.document_lines (document_id, line_no, product_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, cess, total)
    values (v_id, (l ->> 'line_no')::int, nullif(l ->> 'product_id', '')::uuid, l ->> 'description', l ->> 'hsn_code', l ->> 'uom', (l ->> 'qty')::numeric, (l ->> 'rate')::numeric,
            (l ->> 'discount')::numeric, (l ->> 'taxable')::numeric, (l ->> 'gst_rate')::numeric, (l ->> 'cgst')::numeric, (l ->> 'sgst')::numeric, (l ->> 'igst')::numeric, 0, (l ->> 'total')::numeric);
  end loop;
  update sales.documents set taxable = (v_calc ->> 'taxable')::numeric, cgst = (v_calc ->> 'cgst')::numeric, sgst = (v_calc ->> 'sgst')::numeric,
         igst = (v_calc ->> 'igst')::numeric, round_off = (v_calc ->> 'round_off')::numeric, total = (v_calc ->> 'total')::numeric where id = v_id;
  v_res := jsonb_build_object('id', v_id, 'totals', v_calc - 'lines');
  return app.request_done(p_client_request_id, 'save_sales_draft', v_res);
end $$;

-- Post a draft: every rule checked again, number taken, GL written, message queued — all in one transaction.
create or replace function api.post_sales_document(p_client_request_id uuid, p_document_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; d sales.documents; v_party master.parties; v_fy uuid; v_no text; v_voucher uuid; v_lines jsonb := '[]'::jsonb; v_party_acc uuid; v_res jsonb;
  v_taxable_line int; v_mrp numeric; l record; v_sales_event text; v_company_name text; v_orig sales.documents; v_credit_total numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_sales_document'); if v_prev is not null then return v_prev; end if;
  select * into d from sales.documents where id = p_document_id for update;
  if d.id is null or d.status <> 'draft' then perform app.raise_rule('posting.locked', 'only a draft can be posted', '22023'); end if;
  perform app.require(d.company_id, case when d.doc_type = 'credit_note' then 'sales_invoices.approve' else 'sales_invoices.create' end);
  perform app.check_backdate(d.company_id, d.doc_date);
  v_fy := app.fy_for(d.company_id, d.doc_date);
  select * into v_party from master.parties where id = d.party_id;

  -- GST rules (§6, India law): no taxable sale without GST; without GST only by Admin with a lawful reason.
  if d.tax_class = 'without_gst' then
    if not app.is_admin() then perform app.raise_rule('gst.without_admin_only', 'only Admin can post a document without GST', '42501'); end if;
    if d.lawful_reason is null then perform app.raise_rule('gst.reason_required', 'a document without GST needs a lawful reason', '22023'); end if;
    if d.lawful_reason in ('exempt_or_nil', 'non_gst') then
      select count(*) into v_taxable_line from sales.document_lines x
       where x.document_id = d.id and exists (select 1 from master.hsn_rates r where r.hsn_code = x.hsn_code and r.effective_from <= d.doc_date
                                               and (r.effective_to is null or r.effective_to >= d.doc_date) and r.rate > 0 and r.tax_class = 'taxable');
      if v_taxable_line > 0 then perform app.raise_rule('gst.taxable_without_gst', 'a taxable product cannot be billed without GST', '42501'); end if;
    end if;
  end if;
  -- Legal Metrology: never sell above MRP (price including tax per unit).
  for l in select x.*, p.name from sales.document_lines x left join master.products p on p.id = x.product_id where x.document_id = d.id and x.product_id is not null loop
    select mrp into v_mrp from master.product_mrp_history where product_id = l.product_id and effective_from <= d.doc_date order by effective_from desc limit 1;
    if v_mrp is not null and (l.total / l.qty) > v_mrp + 0.005 then
      perform app.raise_rule('price.above_mrp', 'the price of ' || coalesce(l.name, l.description) || ' including tax is above its MRP', '22023');
    end if;
  end loop;
  -- Until KYC is complete: cash sales only (due today).
  update sales.documents set due_date = d.doc_date + case when v_party.kyc_status = 'verified' then d.terms_days else 0 end where id = d.id;

  if d.doc_type = 'credit_note' then
    select * into v_orig from sales.documents where id = d.against_id and status = 'posted' and party_id = d.party_id;
    if v_orig.id is null then perform app.raise_rule('doc.credit_needs_invoice', 'a credit note must be against a posted invoice of this customer', '22023'); end if;
    select coalesce(sum(total), 0) into v_credit_total from sales.documents where against_id = v_orig.id and doc_type = 'credit_note' and status = 'posted';
    if v_credit_total + d.total > v_orig.total then perform app.raise_rule('doc.credit_exceeds', 'credit notes cannot exceed the invoice', '22023'); end if;
  end if;

  v_no := app.take_doc_number(d.company_id, d.gstin_id, d.doc_type, v_fy);

  if d.doc_type <> 'delivery_challan' then
    v_party_acc := app.party_account(d.company_id, d.party_id, 'debtors');
    v_sales_event := case when d.tax_class = 'without_gst' then 'sales.without_gst' else 'sales.taxable' end;
    if d.doc_type = 'credit_note' then
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', app.rule_account(d.company_id, 'sales.returns'), 'dr', d.taxable),
        jsonb_build_object('account_id', case when d.cgst > 0 then app.rule_account(d.company_id, 'gst.output_cgst') end, 'dr', d.cgst),
        jsonb_build_object('account_id', case when d.sgst > 0 then app.rule_account(d.company_id, 'gst.output_sgst') end, 'dr', d.sgst),
        jsonb_build_object('account_id', case when d.igst > 0 then app.rule_account(d.company_id, 'gst.output_igst') end, 'dr', d.igst),
        jsonb_build_object('account_id', case when d.round_off <> 0 then app.rule_account(d.company_id, 'round_off') end, 'dr', greatest(d.round_off, 0), 'cr', greatest(-d.round_off, 0)),
        jsonb_build_object('account_id', v_party_acc, 'party_id', d.party_id, 'cr', d.total));
    else
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_party_acc, 'party_id', d.party_id, 'dr', d.total),
        jsonb_build_object('account_id', app.rule_account(d.company_id, v_sales_event), 'cr', d.taxable),
        jsonb_build_object('account_id', case when d.cgst > 0 then app.rule_account(d.company_id, 'gst.output_cgst') end, 'cr', d.cgst),
        jsonb_build_object('account_id', case when d.sgst > 0 then app.rule_account(d.company_id, 'gst.output_sgst') end, 'cr', d.sgst),
        jsonb_build_object('account_id', case when d.igst > 0 then app.rule_account(d.company_id, 'gst.output_igst') end, 'cr', d.igst),
        jsonb_build_object('account_id', case when d.round_off <> 0 then app.rule_account(d.company_id, 'round_off') end, 'cr', greatest(d.round_off, 0), 'dr', greatest(-d.round_off, 0)));
    end if;
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_lines from jsonb_array_elements(v_lines) e where e ->> 'account_id' is not null;
    v_voucher := app.post_voucher(jsonb_build_object('company_id', d.company_id, 'fy_id', v_fy, 'voucher_type', case when d.doc_type = 'credit_note' then 'credit_note' else 'sales' end,
      'doc_no', v_no, 'voucher_date', d.doc_date, 'party_id', d.party_id, 'narration', d.doc_type || ' ' || v_no, 'tax_class', d.tax_class,
      'source_table', 'sales.documents', 'source_id', d.id, 'client_request_id', p_client_request_id), v_lines);
    if d.doc_type = 'credit_note' then
      insert into acct.bill_allocations (company_id, voucher_id, party_id, against_kind, against_id, amount) values (d.company_id, v_voucher, d.party_id, 'sales_document', d.against_id, d.total);
    end if;
  end if;

  update sales.documents set status = 'posted', doc_no = v_no, voucher_id = v_voucher, posted_at = now(), posted_by = auth.uid() where id = d.id;

  select short_name into v_company_name from core.companies where id = d.company_id;
  if d.doc_type in ('sales_invoice', 'bill_of_supply', 'credit_note') then
    perform app.enqueue_message(jsonb_build_object('company_id', d.company_id, 'event', case when d.doc_type = 'credit_note' then 'sales.credit_note' else 'sales.invoice_posted' end,
      'template', case when d.doc_type = 'credit_note' then 'credit_note_issued' else 'invoice_posted' end, 'party_id', d.party_id,
      'doc_type', 'sales.documents', 'doc_id', d.id, 'stage', 'posted',
      'params', jsonb_build_object('customer', v_party.legal_name, 'doc_no', v_no, 'date', to_char(d.doc_date, 'DD-MM-YYYY'), 'amount', d.total,
                                   'due_date', to_char(d.doc_date + d.terms_days, 'DD-MM-YYYY'), 'company', v_company_name, 'reason', d.reason)));
  end if;
  v_res := jsonb_build_object('id', d.id, 'doc_no', v_no, 'voucher_id', v_voucher, 'total', d.total);
  return app.request_done(p_client_request_id, 'post_sales_document', v_res);
end $$;

create or replace function api.cancel_sales_document(p_client_request_id uuid, p_document_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; d sales.documents; v_rev uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_sales_document'); if v_prev is not null then return v_prev; end if;
  select * into d from sales.documents where id = p_document_id for update;
  perform app.require(d.company_id, 'sales_invoices.cancel');
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  if d.status = 'draft' then
    delete from sales.documents where id = d.id;
    v_res := jsonb_build_object('id', d.id, 'deleted_draft', true);
    return app.request_done(p_client_request_id, 'cancel_sales_document', v_res);
  end if;
  if d.status <> 'posted' then perform app.raise_rule('posting.already_reversed', 'already cancelled', '22023'); end if;
  if exists (select 1 from acct.bill_allocations a where a.against_kind = 'sales_document' and a.against_id = d.id group by a.against_id having sum(a.amount) <> 0) then
    perform app.raise_rule('doc.has_receipts', 'receipts or credit notes are set against this document; reverse them first', '22023');
  end if;
  if d.voucher_id is not null then v_rev := app.reverse_voucher(d.voucher_id, p_client_request_id, p_reason); end if;
  perform set_config('app.allow_posted_update', 'on', true);
  update sales.documents set status = 'cancelled', notes = coalesce(notes || ' · ', '') || 'Cancelled: ' || p_reason where id = d.id;
  perform set_config('app.allow_posted_update', 'off', true);
  update msg.outbox set status = 'cancelled', skip_reason = 'document cancelled' where doc_type = 'sales.documents' and doc_id = d.id and status = 'queued';
  v_res := jsonb_build_object('id', d.id, 'reversal_voucher_id', v_rev);
  return app.request_done(p_client_request_id, 'cancel_sales_document', v_res);
end $$;

-- ─────────── Purchase bills ───────────
create or replace function api.save_purchase_draft(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_gstin core.gstins; v_party master.parties; v_calc jsonb;
  v_pos text; v_terms int := 0; v_msme boolean; v_res jsonb; l jsonb; i int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'save_purchase_draft'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then
    select company_id into v_company from purch.bills where id = v_id and status = 'draft' for update;
    if v_company is null then perform app.raise_rule('posting.locked', 'only drafts can be changed', '22023'); end if;
  end if;
  perform app.require(v_company, 'purchase_bills.create');
  select * into v_gstin from core.gstins where id = (p ->> 'gstin_id')::uuid and company_id = v_company;
  if v_gstin.id is null then perform app.raise_rule('org.gstin_other_company', 'choose a GSTIN of this company', '22023'); end if;
  select * into v_party from master.parties where id = (p ->> 'party_id')::uuid;
  if v_party.id is null or not v_party.is_supplier then perform app.raise_rule('party.missing', 'choose a supplier', '22023'); end if;
  v_pos := coalesce(v_party.state_code, v_gstin.state_code);
  select coalesce(t.days, 0) into v_terms from master.party_companies pc left join master.credit_terms t on t.id = pc.credit_term_id where pc.party_id = v_party.id and pc.company_id = v_company;
  -- MSME: micro and small suppliers are paid within the agreed period, at most 45 days.
  v_msme := v_party.msme_category in ('micro', 'small');
  if v_msme then v_terms := least(coalesce(nullif(v_terms, 0), 45), 45); end if;
  v_calc := app.compute_tax(v_gstin.state_code, v_pos, (p ->> 'supplier_bill_date')::date, false, coalesce(p -> 'lines', '[]'::jsonb));
  if v_id is null then
    insert into purch.bills (company_id, gstin_id, party_id, supplier_bill_no, supplier_bill_date, bill_date, place_of_supply, itc_eligible, reverse_charge, terms_days, msme_due, created_by)
    values (v_company, v_gstin.id, v_party.id, trim(p ->> 'supplier_bill_no'), (p ->> 'supplier_bill_date')::date, coalesce(nullif(p ->> 'bill_date', '')::date, current_date), v_pos,
            coalesce((p ->> 'itc_eligible')::boolean, true), coalesce((p ->> 'reverse_charge')::boolean, false), v_terms, v_msme, auth.uid())
    returning id into v_id;
  else
    delete from purch.bill_lines where bill_id = v_id;
    update purch.bills set supplier_bill_no = trim(p ->> 'supplier_bill_no'), supplier_bill_date = (p ->> 'supplier_bill_date')::date, party_id = v_party.id, place_of_supply = v_pos,
      itc_eligible = coalesce((p ->> 'itc_eligible')::boolean, itc_eligible), reverse_charge = coalesce((p ->> 'reverse_charge')::boolean, reverse_charge), terms_days = v_terms, msme_due = v_msme
    where id = v_id;
  end if;
  for l in select * from jsonb_array_elements(v_calc -> 'lines') loop
    i := i + 1;
    insert into purch.bill_lines (bill_id, line_no, product_id, account_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, total)
    values (v_id, (l ->> 'line_no')::int, nullif(l ->> 'product_id', '')::uuid, nullif((p -> 'lines' -> (i - 1)) ->> 'account_id', '')::uuid, l ->> 'description', l ->> 'hsn_code', l ->> 'uom',
            (l ->> 'qty')::numeric, (l ->> 'rate')::numeric, (l ->> 'discount')::numeric, (l ->> 'taxable')::numeric, (l ->> 'gst_rate')::numeric, (l ->> 'cgst')::numeric,
            (l ->> 'sgst')::numeric, (l ->> 'igst')::numeric, (l ->> 'total')::numeric);
  end loop;
  update purch.bills set taxable = (v_calc ->> 'taxable')::numeric, cgst = (v_calc ->> 'cgst')::numeric, sgst = (v_calc ->> 'sgst')::numeric, igst = (v_calc ->> 'igst')::numeric,
         round_off = (v_calc ->> 'round_off')::numeric, total = (v_calc ->> 'total')::numeric where id = v_id;
  v_res := jsonb_build_object('id', v_id, 'totals', v_calc - 'lines');
  return app.request_done(p_client_request_id, 'save_purchase_draft', v_res);
end $$;

create or replace function api.post_purchase_bill(p_client_request_id uuid, p_bill_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; b purch.bills; v_fy uuid; v_no text; v_voucher uuid; v_lines jsonb; v_party_acc uuid; v_res jsonb; v_exp jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_purchase_bill'); if v_prev is not null then return v_prev; end if;
  select * into b from purch.bills where id = p_bill_id for update;
  if b.id is null or b.status <> 'draft' then perform app.raise_rule('posting.locked', 'only a draft can be posted', '22023'); end if;
  perform app.require(b.company_id, 'purchase_bills.create');
  perform app.check_backdate(b.company_id, b.bill_date);
  v_fy := app.fy_for(b.company_id, b.bill_date);
  v_no := 'PB/' || substr((select label from core.financial_years where id = v_fy), 3) || '/' || lpad((select count(*) + 1 from purch.bills where company_id = b.company_id and status <> 'draft')::text, 5, '0');
  v_party_acc := app.party_account(b.company_id, b.party_id, 'creditors');
  -- Expense / purchase lines: a line's own account, else the purchase rule.
  select coalesce(jsonb_agg(jsonb_build_object('account_id', coalesce(x.account_id, app.rule_account(b.company_id, 'purchase.taxable')), 'dr', x.taxable)), '[]'::jsonb) into v_exp
  from purch.bill_lines x where x.bill_id = b.id;
  v_lines := v_exp || jsonb_build_array(
    jsonb_build_object('account_id', case when b.cgst > 0 then app.rule_account(b.company_id, case when b.itc_eligible then 'gst.input_cgst' else 'purchase.taxable' end) end, 'dr', b.cgst),
    jsonb_build_object('account_id', case when b.sgst > 0 then app.rule_account(b.company_id, case when b.itc_eligible then 'gst.input_sgst' else 'purchase.taxable' end) end, 'dr', b.sgst),
    jsonb_build_object('account_id', case when b.igst > 0 then app.rule_account(b.company_id, case when b.itc_eligible then 'gst.input_igst' else 'purchase.taxable' end) end, 'dr', b.igst),
    jsonb_build_object('account_id', case when b.round_off <> 0 then app.rule_account(b.company_id, 'round_off') end, 'dr', greatest(b.round_off, 0), 'cr', greatest(-b.round_off, 0)),
    jsonb_build_object('account_id', v_party_acc, 'party_id', b.party_id, 'cr', b.total));
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_lines from jsonb_array_elements(v_lines) e where e ->> 'account_id' is not null;
  v_voucher := app.post_voucher(jsonb_build_object('company_id', b.company_id, 'fy_id', v_fy, 'voucher_type', 'purchase', 'doc_no', v_no, 'voucher_date', b.bill_date,
    'party_id', b.party_id, 'narration', 'Supplier bill ' || b.supplier_bill_no, 'source_table', 'purch.bills', 'source_id', b.id, 'client_request_id', p_client_request_id), v_lines);
  update purch.bills set status = 'posted', doc_no = v_no, voucher_id = v_voucher, posted_at = now(), due_date = b.supplier_bill_date + b.terms_days where id = b.id;
  v_res := jsonb_build_object('id', b.id, 'doc_no', v_no, 'voucher_id', v_voucher);
  return app.request_done(p_client_request_id, 'post_purchase_bill', v_res);
end $$;

-- ─────────── Read views ───────────
create or replace view api.sales_documents with (security_invoker = true) as
select d.id, d.company_id, c.short_name as company_name, d.gstin_id, g.gstin, g.state_code as our_state, d.doc_type, d.doc_no, d.doc_date, d.party_id, p.legal_name as party_name,
       p.gstin as party_gstin, d.place_of_supply, d.tax_class, d.lawful_reason, d.against_id, d.reason, d.terms_days, d.due_date, d.taxable, d.cgst, d.sgst, d.igst, d.cess,
       d.round_off, d.total, d.status, d.voucher_id, d.irn, d.eway_bill_no, d.notes, d.created_at, d.posted_at,
       coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'sales_document' and a.against_id = d.id), 0)::numeric(18,2) as settled,
       app.amount_in_words(d.total) as amount_in_words
from sales.documents d join core.companies c on c.id = d.company_id join core.gstins g on g.id = d.gstin_id join master.parties p on p.id = d.party_id;
create or replace view api.sales_document_lines with (security_invoker = true) as
select id, document_id, line_no, product_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, cess, total from sales.document_lines;
create or replace view api.purchase_bills with (security_invoker = true) as
select b.id, b.company_id, b.gstin_id, b.party_id, p.legal_name as party_name, p.msme_category, b.supplier_bill_no, b.supplier_bill_date, b.bill_date, b.doc_no, b.place_of_supply,
       b.itc_eligible, b.reverse_charge, b.terms_days, b.due_date, b.msme_due, b.taxable, b.cgst, b.sgst, b.igst, b.round_off, b.total, b.status, b.voucher_id, b.created_at,
       coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'purchase_bill' and a.against_id = b.id), 0)::numeric(18,2) as settled
from purch.bills b join master.parties p on p.id = b.party_id;
create or replace view api.purchase_bill_lines with (security_invoker = true) as
select id, bill_id, line_no, product_id, account_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, total from purch.bill_lines;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';
