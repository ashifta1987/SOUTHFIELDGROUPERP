-- 20261103004500_inventory_view_fixes.sql
-- 1) Blind receive: while a transfer is in transit, the dispatched / in-transit totals and the picked quantity are hidden
--    from the receiving side in api.transfers and api.transfer_lines too (api.transfer_items already hid them).
--    Visible to the picker, the carrier, or someone with transfer.approve — same rule as api.transfer_items.
-- 2) api.products gains needs_incoming_test and is_scrap (appended columns) for the GRN and scrap pickers.
-- Additive: view definitions only; same columns and types, two columns appended to api.products.

create or replace function app.transfer_qty_hidden(p_company uuid, p_status text, p_picked_by uuid, p_carried_by uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select p_status = 'in_transit' and auth.uid() is distinct from p_picked_by and auth.uid() is distinct from p_carried_by
         and not app.can(p_company, 'transfer.approve')
$$;
grant execute on function app.transfer_qty_hidden(uuid, text, uuid, uuid) to authenticated;

create or replace view api.transfers with (security_invoker = true) as
select t.id, t.company_id, t.doc_no, t.transfer_date, t.status, t.from_place_id, fp.name as from_place_name, t.to_place_id, tp.name as to_place_name,
       t.from_gstin_id, fg.gstin as from_gstin, t.to_gstin_id, tg.gstin as to_gstin, t.gst_doc_kind, t.sales_document_id, d.doc_no as gst_doc_no,
       t.needed_by, t.note, t.vehicle_no, t.carrier_name,
       t.requested_by, ru.display_name as requested_by_name, t.requested_at, t.approved_by, au.display_name as approved_by_name, t.approved_at,
       t.picked_by, pu.display_name as picked_by_name, t.picked_at, t.carried_by, cu.display_name as carried_by_name, t.dispatched_at,
       t.received_by, rcu.display_name as received_by_name, t.received_at, t.witness_by, t.closed_by, t.closed_at, t.cancel_reason,
       case when h.hidden then null else coalesce(x.dispatched, 0) end::numeric(18,3) as qty_dispatched, coalesce(x.accepted, 0)::numeric(18,3) as qty_accepted,
       coalesce(x.quarantined, 0)::numeric(18,3) as qty_quarantined, coalesce(x.returned, 0)::numeric(18,3) as qty_returned,
       coalesce(x.lost, 0)::numeric(18,3) as qty_lost, case when h.hidden then null else coalesce(x.in_transit, 0) end::numeric(18,3) as qty_in_transit,
       -- dispatched = accepted + quarantined + returned + approved loss + still in transit
       case when h.hidden then null else
         coalesce(x.dispatched, 0) = coalesce(x.accepted, 0) + coalesce(x.quarantined, 0) + coalesce(x.returned, 0) + coalesce(x.lost, 0) + coalesce(x.in_transit, 0) end as balanced,
       t.status in ('received', 'reconciled') and coalesce(x.in_transit, 0) = 0 as can_close,
       case when t.status in ('in_transit', 'received') and t.dispatched_at is not null then extract(day from now() - t.dispatched_at)::int end as days_open
from inv.transfers t
join core.places fp on fp.id = t.from_place_id
join core.places tp on tp.id = t.to_place_id
join core.gstins fg on fg.id = t.from_gstin_id
join core.gstins tg on tg.id = t.to_gstin_id
cross join lateral (select app.transfer_qty_hidden(t.company_id, t.status, t.picked_by, t.carried_by) as hidden) h
left join sales.documents d on d.id = t.sales_document_id
left join (select transfer_id, sum(qty_dispatched) as dispatched, sum(qty_accepted) as accepted, sum(qty_quarantined) as quarantined, sum(qty_returned) as returned,
                  sum(qty_lost) as lost, sum(qty_in_transit) as in_transit from inv.transfer_items group by transfer_id) x on x.transfer_id = t.id
left join core.user_profiles ru on ru.user_id = t.requested_by left join core.user_profiles au on au.user_id = t.approved_by
left join core.user_profiles pu on pu.user_id = t.picked_by left join core.user_profiles cu on cu.user_id = t.carried_by
left join core.user_profiles rcu on rcu.user_id = t.received_by;

create or replace view api.transfer_lines with (security_invoker = true) as
select l.id, l.transfer_id, l.line_no, l.product_id, p.code as product_code, p.name as product_name, p.uom, l.lot_id, lt.lot_no, l.qty_requested, l.qty_approved, l.note,
       case when app.transfer_qty_hidden(t.company_id, t.status, t.picked_by, t.carried_by) then null
            else coalesce((select sum(i.qty_dispatched) from inv.transfer_items i where i.line_id = l.id), 0) end::numeric(18,3) as qty_picked
from inv.transfer_lines l join inv.transfers t on t.id = l.transfer_id join master.products p on p.id = l.product_id left join inv.lots lt on lt.id = l.lot_id;

create or replace view api.products with (security_invoker = true) as
select p.id, p.code, p.name, p.group_id, g.name as group_name, p.family, p.kind, p.hsn_code, p.uom, p.net_qty, p.net_qty_uom, p.pack_size,
       p.barcode, p.licence_no, p.label, p.status, p.created_at,
       (select m.mrp from master.product_mrp_history m where m.product_id = p.id and m.effective_from <= current_date order by m.effective_from desc limit 1) as mrp,
       (select r.rate from master.hsn_rates r where r.hsn_code = p.hsn_code and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date) order by r.effective_from desc limit 1) as gst_rate,
       coalesce((select array_agg(pc.company_id) from master.product_companies pc where pc.product_id = p.id and pc.active), '{}') as company_ids,
       (select count(*) from master.product_aliases a where a.product_id = p.id)::int as alias_count,
       p.needs_incoming_test, p.is_scrap
from master.products p left join master.product_groups g on g.id = p.group_id;

notify pgrst, 'reload schema';

