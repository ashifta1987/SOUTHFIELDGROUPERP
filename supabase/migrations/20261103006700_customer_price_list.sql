-- 20261103006700_customer_price_list.sql
-- Phase 6 gap fix: the customer's price list per company (master.party_companies.price_list_id, added in 006000 and read by
-- api.confirm_sales_order for salesman orders) had no RPC to set it, so a salesman order always failed order.no_price_list.
-- Adds api.set_customer_price_list (office: sales.edit or field.manage) and the read api.customer_price_list (the list and
-- its current net rates, for the take-order screen; the assigned salesman or sales/accounts view). Additive. The row change
-- is recorded by the existing audit trigger on master.party_companies.

create or replace function api.set_customer_price_list(p_client_request_id uuid, p_company_id uuid, p_party_id uuid, p_price_list_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; pc master.party_companies; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_customer_price_list'); if v_prev is not null then return v_prev; end if;
  if app.can(p_company_id, 'sales.edit') then perform app.require(p_company_id, 'sales.edit');
  else perform app.require(p_company_id, 'field.manage'); end if;
  select * into pc from master.party_companies where party_id = p_party_id and company_id = p_company_id and is_customer for update;
  if pc.party_id is null then perform app.raise_rule('party.not_linked', 'this customer is not linked to the company', '22023'); end if;
  if p_price_list_id is not null and not exists (select 1 from master.price_lists where id = p_price_list_id and company_id = p_company_id and active) then
    perform app.raise_rule('price_list.other_company', 'choose an active price list of this company', '22023');
  end if;
  update master.party_companies set price_list_id = p_price_list_id where party_id = p_party_id and company_id = p_company_id;
  v_res := jsonb_build_object('company_id', p_company_id, 'party_id', p_party_id, 'price_list_id', p_price_list_id);
  return app.request_done(p_client_request_id, 'set_customer_price_list', v_res);
end $$;

-- Read: the customer's price list and the current price of each item on it (net of GST: a tax-inclusive list is converted
-- with the HSN rate in force, the same app.list_rate the order uses), with the MRP. Assigned salesman or sales/accounts view.
create or replace function api.customer_price_list(p_company_id uuid, p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_pl master.price_lists; v_items jsonb;
begin
  if not app.can_sales_party(p_company_id, p_party_id) then perform app.raise_rule('rights.missing', 'you cannot see this customer', '42501'); end if;
  select l.* into v_pl from master.party_companies pc join master.price_lists l on l.id = pc.price_list_id
   where pc.party_id = p_party_id and pc.company_id = p_company_id;
  if v_pl.id is null then
    return jsonb_build_object('price_list_id', null, 'name', null, 'tax_inclusive', null, 'items', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id', x.product_id, 'code', x.code, 'name', x.name, 'uom', x.uom, 'min_qty', x.min_qty,
           'price', x.price, 'rate', app.list_rate(v_pl.id, x.product_id, current_date, x.min_qty),
           'mrp', (select m.mrp from master.product_mrp_history m where m.product_id = x.product_id and m.effective_from <= current_date order by m.effective_from desc limit 1))
         order by x.name), '[]'::jsonb)
    into v_items
  from (select distinct on (i.product_id) i.product_id, p.code, p.name, p.uom, i.min_qty, i.price
        from master.price_list_items i join master.products p on p.id = i.product_id
        where i.price_list_id = v_pl.id and i.effective_from <= current_date and p.status = 'active'
        order by i.product_id, i.min_qty, i.effective_from desc) x;
  return jsonb_build_object('price_list_id', v_pl.id, 'name', v_pl.name, 'tax_inclusive', v_pl.tax_inclusive, 'items', v_items);
end $$;

revoke all on function api.set_customer_price_list(uuid, uuid, uuid, uuid) from public, anon;
revoke all on function api.customer_price_list(uuid, uuid) from public, anon;
grant execute on function api.set_customer_price_list(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function api.customer_price_list(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
