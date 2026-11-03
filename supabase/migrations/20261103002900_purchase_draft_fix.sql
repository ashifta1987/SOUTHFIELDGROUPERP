-- 20261103002900_purchase_draft_fix.sql
-- Fix: save_purchase_draft failed for a supplier with no MSME category (msme_due null) or no company terms row
-- (terms_days null). Both now default to false / 0. Same function otherwise; replaces it in place.

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
  v_terms := coalesce(v_terms, 0);
  v_msme := coalesce(v_party.msme_category in ('micro', 'small'), false);
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

notify pgrst, 'reload schema';
