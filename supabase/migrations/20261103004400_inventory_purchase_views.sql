-- 20261103004400_inventory_purchase_views.sql
-- Phase 4 read side for the screens: stock on hand by place and status (sellable = available only; transit, quarantine,
-- hold and rejected are never sellable), item stock with reorder levels, raw material / component / scrap stock,
-- movements, counts, transfers with the balance check, warehouse tasks, purchase requests, RFQs, quotations, orders,
-- goods receipts, lots and tests, bill captures, price changes, MSME dues, and the buying-logistics home summary.
-- Views are security_invoker, so table RLS decides the rows. Law register updated for MSME-1 and GST-3. Additive.

-- ─────────── Stock ───────────
create or replace view api.lots with (security_invoker = true) as
select l.id, l.company_id, l.product_id, p.code as product_code, p.name as product_name, p.uom, l.lot_no, l.supplier_lot_no, l.mfg_date, l.expiry_date,
       l.source, l.status, l.needs_test, l.grn_id, g.doc_no as grn_no, g.party_id as supplier_id, sp.legal_name as supplier_name,
       l.received_by, ru.display_name as received_by_name, l.received_at, l.released_by, lu.display_name as released_by_name, l.released_at,
       (select t.result from prod.lab_tests t where t.lot_id = l.id order by t.created_at desc, t.id desc limit 1) as last_test_result,
       coalesce((select sum(b.qty) from inv.stock_balances b where b.lot_id = l.id), 0)::numeric(18,3) as qty_on_hand,
       coalesce((select sum(b.qty) from inv.stock_balances b where b.lot_id = l.id and b.bucket = 'quarantine'), 0)::numeric(18,3) as qty_quarantine,
       case when l.expiry_date is null then null else l.expiry_date - current_date end as days_to_expiry
from inv.lots l
join master.products p on p.id = l.product_id
left join purch.goods_receipts g on g.id = l.grn_id
left join master.parties sp on sp.id = g.party_id
left join core.user_profiles ru on ru.user_id = l.received_by
left join core.user_profiles lu on lu.user_id = l.released_by;

-- One row per company, item, lot, place and status bucket.
create or replace view api.stock_on_hand with (security_invoker = true) as
select b.id, b.company_id, c.short_name as company_name, b.product_id, p.code as product_code, p.name as product_name, p.kind as product_kind, p.uom,
       b.place_id, pl.code as place_code, pl.name as place_name, pl.kind as place_kind, pl.branch_id, br.name as branch_name,
       b.lot_id, l.lot_no, l.expiry_date, b.bucket, b.qty, (b.bucket = 'available') as sellable, b.negative_allowance_id is not null as negative_allowed, b.updated_at
from inv.stock_balances b
join core.companies c on c.id = b.company_id
join master.products p on p.id = b.product_id
join core.places pl on pl.id = b.place_id
join core.branches br on br.id = pl.branch_id
left join inv.lots l on l.id = b.lot_id
where b.qty <> 0;

-- One row per company, item and place with a column per status. sellable = available; free = available − reserved.
create or replace view api.stock_summary with (security_invoker = true) as
select b.company_id, b.product_id, p.code as product_code, p.name as product_name, p.kind as product_kind, p.uom, b.place_id, pl.code as place_code, pl.name as place_name,
       coalesce(sum(b.qty) filter (where b.bucket = 'available'), 0)::numeric(18,3) as available,
       coalesce(sum(b.qty) filter (where b.bucket = 'quarantine'), 0)::numeric(18,3) as quarantine,
       coalesce(sum(b.qty) filter (where b.bucket = 'hold'), 0)::numeric(18,3) as hold,
       coalesce(sum(b.qty) filter (where b.bucket = 'in_transit'), 0)::numeric(18,3) as in_transit,
       coalesce(sum(b.qty) filter (where b.bucket = 'rejected'), 0)::numeric(18,3) as rejected,
       sum(b.qty)::numeric(18,3) as total,
       coalesce(sum(b.qty) filter (where b.bucket = 'available'), 0)::numeric(18,3) as sellable,
       coalesce((select sum(r.qty) from inv.reservations r where r.status = 'active' and r.company_id = b.company_id and r.product_id = b.product_id and r.place_id = b.place_id), 0)::numeric(18,3) as reserved
from inv.stock_balances b
join master.products p on p.id = b.product_id
join core.places pl on pl.id = b.place_id
group by b.company_id, b.product_id, p.code, p.name, p.kind, p.uom, b.place_id, pl.code, pl.name;

-- One row per company and item: totals, reorder level, last purchase rate; value only with cost.view.
create or replace view api.item_stock with (security_invoker = true) as
select s.company_id, s.product_id, p.code as product_code, p.name as product_name, p.kind as product_kind, p.uom, pg.name as group_name, p.is_scrap, p.needs_incoming_test,
       s.total, s.sellable, s.quarantine, s.hold, s.in_transit, s.rejected, s.reserved, (s.sellable - s.reserved)::numeric(18,3) as free,
       rl.min_qty as reorder_level, rl.reorder_qty, (rl.min_qty is not null and s.sellable < rl.min_qty) as below_reorder,
       (select h.rate from purch.price_history h where h.company_id = s.company_id and h.product_id = s.product_id order by h.rate_date desc, h.id desc limit 1) as last_rate,
       case when app.can(s.company_id, 'cost.view') then app.avg_cost(s.company_id, s.product_id) end as avg_cost,
       case when app.can(s.company_id, 'cost.view') then round(s.total * coalesce(app.avg_cost(s.company_id, s.product_id), 0), 2) end as stock_value
from (select company_id, product_id, sum(total) as total, sum(sellable) as sellable, sum(quarantine) as quarantine, sum(hold) as hold, sum(in_transit) as in_transit,
             sum(rejected) as rejected, sum(reserved) as reserved
      from api.stock_summary group by company_id, product_id) s
join master.products p on p.id = s.product_id
left join master.product_groups pg on pg.id = p.group_id
left join inv.reorder_levels rl on rl.company_id = s.company_id and rl.product_id = s.product_id and rl.place_id is null;

create or replace view api.raw_material_stock with (security_invoker = true) as
select * from api.item_stock where product_kind in ('raw_material', 'packaging', 'perfumery') and not is_scrap;
create or replace view api.component_stock with (security_invoker = true) as
select * from api.item_stock where product_kind in ('component', 'spares', 'consumable') and not is_scrap;
create or replace view api.scrap_stock with (security_invoker = true) as
select i.*, (select round(x.rate, 2) from sales.document_lines x join inv.scrap_sales ss on ss.sales_document_id = x.document_id
             where x.product_id = i.product_id and ss.company_id = i.company_id order by ss.created_at desc limit 1) as last_sold_rate
from api.item_stock i where i.is_scrap;

-- Movements (every ledger row). Value only with cost.view.
create or replace view api.stock_movements with (security_invoker = true) as
select m.id, m.company_id, m.move_date, m.created_at, m.doc_no, m.move_type, m.product_id, p.code as product_code, p.name as product_name, p.uom,
       m.lot_id, l.lot_no, m.place_id, pl.name as place_name, m.bucket, m.qty,
       case when app.can(m.company_id, 'cost.view') then m.unit_cost end as unit_cost,
       case when app.can(m.company_id, 'cost.view') then m.value end as value,
       m.source_table, m.source_id, m.note, m.negative_allowance_id is not null as negative_allowed, m.created_by, u.display_name as created_by_name
from inv.stock_ledger m
join master.products p on p.id = m.product_id
join core.places pl on pl.id = m.place_id
left join inv.lots l on l.id = m.lot_id
left join core.user_profiles u on u.user_id = m.created_by;

create or replace view api.stock_issues with (security_invoker = true) as
select i.id, i.company_id, i.doc_no, i.kind, i.issue_date, i.product_id, p.code as product_code, p.name as product_name, p.uom, i.lot_id, l.lot_no,
       i.from_place_id, fp.name as from_place_name, i.to_place_id, tp.name as to_place_name, i.qty, i.target_kind, i.target_ref, i.cost_centre, i.against_issue_id,
       i.bucket, i.reason, i.created_by, u.display_name as created_by_name, i.created_at,
       case when i.kind = 'issue' then i.qty - coalesce((select sum(r.qty) from inv.stock_issues r where r.against_issue_id = i.id and r.kind = 'return'), 0) end::numeric(18,3) as qty_still_out
from inv.stock_issues i
join master.products p on p.id = i.product_id
left join inv.lots l on l.id = i.lot_id
left join core.places fp on fp.id = i.from_place_id
left join core.places tp on tp.id = i.to_place_id
left join core.user_profiles u on u.user_id = i.created_by;

create or replace view api.reorder_levels with (security_invoker = true) as
select r.id, r.company_id, r.product_id, p.code as product_code, p.name as product_name, r.place_id, pl.name as place_name, r.min_qty, r.reorder_qty, r.max_qty, r.set_at
from inv.reorder_levels r join master.products p on p.id = r.product_id left join core.places pl on pl.id = r.place_id;

create or replace view api.negative_stock_allowances with (security_invoker = true) as
select a.id, a.company_id, a.product_id, p.code as product_code, p.name as product_name, a.place_id, pl.name as place_name, a.reason, a.valid_from, a.valid_to,
       a.granted_by, g.display_name as granted_by_name, a.granted_at, a.revoked_at, a.revoke_reason,
       (a.revoked_at is null and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())) as active,
       (select count(*) from inv.negative_stock_uses x where x.allowance_id = a.id)::int as uses
from inv.negative_stock_allowances a join master.products p on p.id = a.product_id left join core.places pl on pl.id = a.place_id
left join core.user_profiles g on g.user_id = a.granted_by;

create or replace view api.stock_counts with (security_invoker = true) as
select c.id, c.company_id, c.doc_no, c.count_date, c.place_id, pl.name as place_name, c.blind, c.status, c.note, c.created_by, cu.display_name as created_by_name,
       c.submitted_by, su.display_name as submitted_by_name, c.submitted_at, c.approved_by, au.display_name as approved_by_name, c.posted_at,
       (select count(*) from inv.count_lines x where x.count_id = c.id)::int as lines,
       (select count(*) from inv.count_lines x where x.count_id = c.id and x.counted_qty is not null)::int as counted,
       case when c.status in ('submitted', 'posted') or not c.blind then (select count(*) from inv.count_lines x where x.count_id = c.id and x.counted_qty <> x.system_qty) end::int as differences
from inv.cycle_counts c join core.places pl on pl.id = c.place_id
left join core.user_profiles cu on cu.user_id = c.created_by left join core.user_profiles su on su.user_id = c.submitted_by left join core.user_profiles au on au.user_id = c.approved_by;

-- Blind: the system quantity and the difference are hidden while the count is open.
create or replace view api.stock_count_lines with (security_invoker = true) as
select x.id, x.count_id, x.product_id, p.code as product_code, p.name as product_name, p.uom, x.lot_id, l.lot_no, x.bucket,
       case when c.status in ('submitted', 'posted', 'cancelled') or not c.blind then x.system_qty end as system_qty,
       x.counted_qty,
       case when c.status in ('submitted', 'posted', 'cancelled') or not c.blind then x.counted_qty - x.system_qty end as difference,
       x.counted_by, u.display_name as counted_by_name, x.counted_at, x.reason
from inv.count_lines x join inv.cycle_counts c on c.id = x.count_id join master.products p on p.id = x.product_id
left join inv.lots l on l.id = x.lot_id left join core.user_profiles u on u.user_id = x.counted_by;

create or replace view api.regrind_entries with (security_invoker = true) as
select r.id, r.company_id, r.entry_date, r.kind, r.product_id, p.name as product_name, r.source_product_id, sp.name as source_product_name, r.place_id, pl.name as place_name,
       r.qty, r.machine, r.mould, r.shift, r.note, r.recorded_by, u.display_name as recorded_by_name, r.created_at
from prod.regrind_entries r join master.products p on p.id = r.product_id join core.places pl on pl.id = r.place_id
left join master.products sp on sp.id = r.source_product_id left join core.user_profiles u on u.user_id = r.recorded_by;

create or replace view api.scrap_sales with (security_invoker = true) as
select s.id, s.company_id, s.sales_document_id, d.doc_no as invoice_no, d.doc_date, d.party_id as buyer_id, pa.legal_name as buyer_name, s.place_id, pl.name as place_name,
       s.qty, d.taxable, d.total, round(d.taxable / nullif(s.qty, 0), 2) as rate_per_unit, s.slip_path, s.sold_by, s.created_at
from inv.scrap_sales s join sales.documents d on d.id = s.sales_document_id left join master.parties pa on pa.id = d.party_id join core.places pl on pl.id = s.place_id;

create or replace view api.lab_tests with (security_invoker = true) as
select t.id, t.company_id, t.lot_id, l.lot_no, l.product_id, p.name as product_name, t.kind, t.result, t.parameters, t.remarks, t.test_date, t.tested_by,
       u.display_name as tested_by_name, t.created_at
from prod.lab_tests t join inv.lots l on l.id = t.lot_id join master.products p on p.id = l.product_id left join core.user_profiles u on u.user_id = t.tested_by;

-- ─────────── Transfers ───────────
create or replace view api.transfers with (security_invoker = true) as
select t.id, t.company_id, t.doc_no, t.transfer_date, t.status, t.from_place_id, fp.name as from_place_name, t.to_place_id, tp.name as to_place_name,
       t.from_gstin_id, fg.gstin as from_gstin, t.to_gstin_id, tg.gstin as to_gstin, t.gst_doc_kind, t.sales_document_id, d.doc_no as gst_doc_no,
       t.needed_by, t.note, t.vehicle_no, t.carrier_name,
       t.requested_by, ru.display_name as requested_by_name, t.requested_at, t.approved_by, au.display_name as approved_by_name, t.approved_at,
       t.picked_by, pu.display_name as picked_by_name, t.picked_at, t.carried_by, cu.display_name as carried_by_name, t.dispatched_at,
       t.received_by, rcu.display_name as received_by_name, t.received_at, t.witness_by, t.closed_by, t.closed_at, t.cancel_reason,
       coalesce(x.dispatched, 0)::numeric(18,3) as qty_dispatched, coalesce(x.accepted, 0)::numeric(18,3) as qty_accepted,
       coalesce(x.quarantined, 0)::numeric(18,3) as qty_quarantined, coalesce(x.returned, 0)::numeric(18,3) as qty_returned,
       coalesce(x.lost, 0)::numeric(18,3) as qty_lost, coalesce(x.in_transit, 0)::numeric(18,3) as qty_in_transit,
       -- dispatched = accepted + quarantined + returned + approved loss + still in transit
       coalesce(x.dispatched, 0) = coalesce(x.accepted, 0) + coalesce(x.quarantined, 0) + coalesce(x.returned, 0) + coalesce(x.lost, 0) + coalesce(x.in_transit, 0) as balanced,
       t.status in ('received', 'reconciled') and coalesce(x.in_transit, 0) = 0 as can_close,
       case when t.status in ('in_transit', 'received') and t.dispatched_at is not null then extract(day from now() - t.dispatched_at)::int end as days_open
from inv.transfers t
join core.places fp on fp.id = t.from_place_id
join core.places tp on tp.id = t.to_place_id
join core.gstins fg on fg.id = t.from_gstin_id
join core.gstins tg on tg.id = t.to_gstin_id
left join sales.documents d on d.id = t.sales_document_id
left join (select transfer_id, sum(qty_dispatched) as dispatched, sum(qty_accepted) as accepted, sum(qty_quarantined) as quarantined, sum(qty_returned) as returned,
                  sum(qty_lost) as lost, sum(qty_in_transit) as in_transit from inv.transfer_items group by transfer_id) x on x.transfer_id = t.id
left join core.user_profiles ru on ru.user_id = t.requested_by left join core.user_profiles au on au.user_id = t.approved_by
left join core.user_profiles pu on pu.user_id = t.picked_by left join core.user_profiles cu on cu.user_id = t.carried_by
left join core.user_profiles rcu on rcu.user_id = t.received_by;

create or replace view api.transfer_lines with (security_invoker = true) as
select l.id, l.transfer_id, l.line_no, l.product_id, p.code as product_code, p.name as product_name, p.uom, l.lot_id, lt.lot_no, l.qty_requested, l.qty_approved, l.note,
       coalesce((select sum(i.qty_dispatched) from inv.transfer_items i where i.line_id = l.id), 0)::numeric(18,3) as qty_picked
from inv.transfer_lines l join master.products p on p.id = l.product_id left join inv.lots lt on lt.id = l.lot_id;

-- Items by lot. While goods are in transit the dispatched quantity is hidden from the receiving side (blind count):
-- only the picker, the carrier, or someone with transfer.approve sees it.
create or replace view api.transfer_items with (security_invoker = true) as
select i.id, i.transfer_id, i.line_id, i.product_id, p.code as product_code, p.name as product_name, p.uom, i.lot_id, l.lot_no, l.expiry_date,
       case when t.status = 'in_transit' and auth.uid() is distinct from t.picked_by and auth.uid() is distinct from t.carried_by and not app.can(t.company_id, 'transfer.approve')
            then null else i.qty_dispatched end as qty_dispatched,
       i.qty_accepted, i.qty_quarantined, i.qty_returned, i.qty_lost,
       case when t.status = 'in_transit' and auth.uid() is distinct from t.picked_by and auth.uid() is distinct from t.carried_by and not app.can(t.company_id, 'transfer.approve')
            then null else i.qty_in_transit end as qty_in_transit,
       i.counted_by, i.counted_at
from inv.transfer_items i join inv.transfers t on t.id = i.transfer_id join master.products p on p.id = i.product_id left join inv.lots l on l.id = i.lot_id;

create or replace view api.transfer_events with (security_invoker = true) as
select e.id, e.transfer_id, e.action, e.from_status, e.to_status, e.actor, u.display_name as actor_name, e.detail, e.at
from inv.transfer_events e left join core.user_profiles u on u.user_id = e.actor;

-- ─────────── Purchase ───────────
create or replace view api.purchase_requests with (security_invoker = true) as
select r.id, r.company_id, r.doc_no, r.request_date, r.department, r.for_job, r.needed_by, r.reason, r.attachment_path, r.est_total, r.status,
       r.requested_by, u.display_name as requested_by_name, r.submitted_at, r.decided_by, d.display_name as decided_by_name, r.decided_at, r.decision_note, r.created_at,
       (select count(*) from purch.request_lines x where x.request_id = r.id)::int as lines,
       (select o.id from purch.orders o where o.request_id = r.id and o.status <> 'cancelled' order by o.created_at desc limit 1) as order_id
from purch.requests r left join core.user_profiles u on u.user_id = r.requested_by left join core.user_profiles d on d.user_id = r.decided_by;

create or replace view api.purchase_request_lines with (security_invoker = true) as
select x.id, x.request_id, x.line_no, x.product_id, p.code as product_code, x.description, x.qty, x.uom, x.est_rate, x.suggested_party_id, sp.legal_name as suggested_party_name, x.note,
       coalesce((select sum(b.qty) from inv.stock_balances b where b.company_id = r.company_id and b.product_id = x.product_id and b.bucket = 'available'), 0)::numeric(18,3) as in_stock,
       coalesce((select sum(ol.qty - ol.qty_received) from purch.order_lines ol join purch.orders o on o.id = ol.order_id
                 where o.company_id = r.company_id and ol.product_id = x.product_id and o.status in ('issued', 'confirmed', 'part_received')), 0)::numeric(18,3) as on_order,
       (select h.rate from purch.price_history h where h.company_id = r.company_id and h.product_id = x.product_id order by h.rate_date desc, h.id desc limit 1) as last_rate
from purch.request_lines x join purch.requests r on r.id = x.request_id left join master.products p on p.id = x.product_id left join master.parties sp on sp.id = x.suggested_party_id;

create or replace view api.rfqs with (security_invoker = true) as
select q.id, q.company_id, q.doc_no, q.rfq_date, q.request_id, r.doc_no as request_no, q.due_date, q.status, q.note, q.created_at,
       (select count(*) from purch.rfq_suppliers s where s.rfq_id = q.id)::int as suppliers,
       (select count(*) from purch.quotations x where x.rfq_id = q.id)::int as quotations
from purch.rfqs q left join purch.requests r on r.id = q.request_id;

create or replace view api.rfq_lines with (security_invoker = true) as
select l.id, l.rfq_id, l.line_no, l.product_id, p.code as product_code, l.description, l.qty, l.uom, l.request_line_id
from purch.rfq_lines l left join master.products p on p.id = l.product_id;

create or replace view api.quotations with (security_invoker = true) as
select q.id, q.rfq_id, q.company_id, q.party_id, p.legal_name as party_name, p.msme_category, q.quote_ref, q.quote_date, q.valid_until, q.terms_days, q.delivery_days, q.status,
       q.attachment_path, q.note, q.created_at,
       coalesce((select sum(round(x.qty * x.rate - x.discount, 2)) from purch.quotation_lines x where x.quotation_id = q.id), 0)::numeric(18,2) as taxable_total
from purch.quotations q join master.parties p on p.id = q.party_id;

-- Side-by-side comparison: one row per RFQ line and quotation; cheapest = lowest rate after discount for that line.
create or replace view api.quotation_compare with (security_invoker = true) as
select rl.rfq_id, rl.id as rfq_line_id, rl.line_no, rl.product_id, rl.description, rl.qty as rfq_qty, rl.uom, q.id as quotation_id, q.party_id, p.legal_name as party_name,
       x.qty, x.rate, x.discount, round(x.qty * x.rate - x.discount, 2) as taxable, round((x.qty * x.rate - x.discount) / nullif(x.qty, 0), 2) as net_rate,
       rank() over (partition by rl.id order by (x.qty * x.rate - x.discount) / nullif(x.qty, 0)) = 1 as cheapest,
       (select h.rate from purch.price_history h where h.company_id = q.company_id and h.product_id = rl.product_id order by h.rate_date desc, h.id desc limit 1) as last_rate
from purch.quotation_lines x join purch.quotations q on q.id = x.quotation_id join purch.rfq_lines rl on rl.id = x.rfq_line_id join master.parties p on p.id = q.party_id;

create or replace view api.purchase_orders with (security_invoker = true) as
select o.id, o.company_id, o.gstin_id, g.gstin, o.doc_no, o.party_id, p.legal_name as party_name, p.msme_category, o.request_id, o.quotation_id, o.order_date, o.delivery_date,
       o.place_id, pl.name as place_name, o.place_of_supply, o.terms_days, o.msme, o.taxable, o.cgst, o.sgst, o.igst, o.round_off, o.total, o.status, o.price_flags,
       jsonb_array_length(o.price_flags) > 0 as has_price_increase, o.price_rise_accepted_by, o.notes, o.created_by, o.created_at, o.issued_by, iu.display_name as issued_by_name,
       o.issued_at, o.confirmed_at, o.cancelled_at, o.cancel_reason,
       coalesce((select sum(l.qty) from purch.order_lines l where l.order_id = o.id), 0)::numeric(18,3) as qty_ordered,
       coalesce((select sum(l.qty_received) from purch.order_lines l where l.order_id = o.id), 0)::numeric(18,3) as qty_received,
       (select m.status from msg.outbox m where m.doc_type = 'purch.orders' and m.doc_id = o.id order by m.created_at desc limit 1) as message_status
from purch.orders o join master.parties p on p.id = o.party_id join core.gstins g on g.id = o.gstin_id left join core.places pl on pl.id = o.place_id
left join core.user_profiles iu on iu.user_id = o.issued_by;

create or replace view api.purchase_order_lines with (security_invoker = true) as
select l.id, l.order_id, l.line_no, l.product_id, p.code as product_code, l.description, l.hsn_code, l.uom, l.qty, l.rate, l.discount, l.taxable, l.gst_rate, l.cgst, l.sgst, l.igst,
       l.total, l.qty_received, (l.qty - l.qty_received)::numeric(18,3) as qty_pending, l.request_line_id
from purch.order_lines l left join master.products p on p.id = l.product_id;

create or replace view api.goods_receipts with (security_invoker = true) as
select r.id, r.company_id, r.doc_no, r.receipt_date, r.party_id, p.legal_name as party_name, r.order_id, o.doc_no as order_no, r.place_id, pl.name as place_name,
       r.supplier_invoice_no, r.supplier_invoice_date, r.eway_bill_no, r.vehicle_no, r.direct_purchase, r.approved_by, r.status, r.notes,
       r.received_by, u.display_name as received_by_name, r.created_at,
       (select count(*) from purch.grn_lines x where x.grn_id = r.id)::int as lines,
       (select count(*) from purch.grn_lines x join inv.lots l on l.id = x.lot_id where x.grn_id = r.id and l.status = 'quarantine')::int as lines_in_quarantine,
       (select b.id from purch.bills b where b.grn_id = r.id and b.status <> 'cancelled' limit 1) as bill_id
from purch.goods_receipts r join master.parties p on p.id = r.party_id join core.places pl on pl.id = r.place_id left join purch.orders o on o.id = r.order_id
left join core.user_profiles u on u.user_id = r.received_by;

create or replace view api.grn_lines with (security_invoker = true) as
select x.id, x.grn_id, x.line_no, x.order_line_id, x.product_id, p.code as product_code, p.name as product_name, x.qty, x.uom, x.rate, x.lot_id, l.lot_no, x.supplier_lot_no,
       l.expiry_date, x.bucket, l.status as lot_status, x.qty_accepted, x.qty_rejected
from purch.grn_lines x join master.products p on p.id = x.product_id left join inv.lots l on l.id = x.lot_id;

create or replace view api.bill_captures with (security_invoker = true) as
select c.id, c.company_id, c.photo_path, c.source, c.status, c.extracted, c.party_id, p.legal_name as party_name, p.gstin as party_gstin, c.order_id, o.doc_no as order_no,
       c.grn_id, g.doc_no as grn_no, c.bill_id, b.doc_no as bill_doc_no, b.status as bill_status, c.match_result, c.uploaded_by, u.display_name as uploaded_by_name, c.uploaded_at,
       c.read_at, c.matched_at, c.reject_reason,
       c.extracted ->> 'invoice_no' as invoice_no, nullif(c.extracted ->> 'invoice_date', '')::date as invoice_date, nullif(c.extracted ->> 'total', '')::numeric(18,2) as invoice_total
from purch.bill_captures c left join master.parties p on p.id = c.party_id left join purch.orders o on o.id = c.order_id left join purch.goods_receipts g on g.id = c.grn_id
left join purch.bills b on b.id = c.bill_id left join core.user_profiles u on u.user_id = c.uploaded_by;

create or replace view api.price_history with (security_invoker = true) as
select h.id, h.company_id, h.product_id, p.code as product_code, p.name as product_name, h.party_id, pa.legal_name as party_name, h.rate, h.qty, h.uom, h.source, h.source_id, h.rate_date
from purch.price_history h join master.products p on p.id = h.product_id left join master.parties pa on pa.id = h.party_id;

-- Latest bill rate against the previous bill rate per company and item (before GST, per unit).
create or replace view api.price_changes with (security_invoker = true) as
with ranked as (
  select h.*, row_number() over (partition by h.company_id, h.product_id order by h.rate_date desc, h.id desc) as rn
  from purch.price_history h where h.source = 'bill'
)
select a.company_id, a.product_id, p.code as product_code, p.name as product_name, coalesce(a.uom, p.uom) as uom, pg.name as group_name, p.kind as product_kind,
       a.rate as latest_rate, a.rate_date as latest_date, a.party_id as latest_party_id, pa.legal_name as latest_party_name,
       b.rate as previous_rate, b.rate_date as previous_date, b.party_id as previous_party_id, pb.legal_name as previous_party_name,
       (a.rate - b.rate)::numeric(18,2) as change, round((a.rate - b.rate) * 100 / nullif(b.rate, 0), 2) as change_pct,
       coalesce(a.rate > b.rate, false) as is_increase, b.id is null as first_bill,
       app.setting_num(a.company_id, 'purchase.price_alert_pct') as alert_pct
from ranked a
left join ranked b on b.company_id = a.company_id and b.product_id = a.product_id and b.rn = 2
join master.products p on p.id = a.product_id
left join master.product_groups pg on pg.id = p.group_id
left join master.parties pa on pa.id = a.party_id
left join master.parties pb on pb.id = b.party_id
where a.rn = 1;

-- MSME dues (MSMED Act s.15): micro and small suppliers are paid within the agreed days, never more than 45 days from
-- acceptance (goods receipt date when linked, else the bill date); with no agreed days recorded the Act's 15 days apply
-- (safest reading; open question for the CA). Warning window: setting msme.warn_days (0 when unset).
create or replace view api.msme_dues with (security_invoker = true) as
select x.*, x.effective_due - current_date as days_left,
       case when x.effective_due < current_date then 'overdue' when x.effective_due - current_date <= x.warn_days then 'due_soon' else 'not_due' end as state
from (
  select b.id as bill_id, b.company_id, b.party_id, p.legal_name as party_name, p.msme_category, p.udyam_no, b.supplier_bill_no, b.supplier_bill_date, b.doc_no,
         coalesce(g.receipt_date, b.supplier_bill_date) as accepted_on, b.terms_days as agreed_days, b.due_date,
         (coalesce(g.receipt_date, b.supplier_bill_date) + case when b.terms_days > 0 then least(b.terms_days, 45) else 15 end)::date as legal_due_date,
         least(coalesce(b.due_date, 'infinity'::date), (coalesce(g.receipt_date, b.supplier_bill_date) + case when b.terms_days > 0 then least(b.terms_days, 45) else 15 end)::date) as effective_due,
         b.total, (b.total - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'purchase_bill' and a.against_id = b.id), 0))::numeric(18,2) as open_amount,
         coalesce(app.setting_num(b.company_id, 'msme.warn_days'), 0)::int as warn_days
  from purch.bills b join master.parties p on p.id = b.party_id left join purch.goods_receipts g on g.id = b.grn_id
  where b.status = 'posted' and p.msme_category in ('micro', 'small')
) x
where x.open_amount > 0;

-- ─────────── Warehouse tasks ───────────
-- To receive (orders and transfers), to test (quarantine lots), to put away (released stock still in a quarantine place),
-- to pick (reserved transfers), to hand over, counts due.
create or replace view api.warehouse_tasks with (security_invoker = true) as
select 'receive_order'::text as task_kind, o.company_id, o.place_id, pl.name as place_name, 'purch.orders'::text as ref_table, o.id as ref_id, o.doc_no as ref_no,
       p.legal_name as title, (select sum(l.qty - l.qty_received) from purch.order_lines l where l.order_id = o.id)::numeric(18,3) as qty, o.delivery_date as due_date,
       '/purchase/goods-receipt'::text as href
from purch.orders o join master.parties p on p.id = o.party_id left join core.places pl on pl.id = o.place_id
where o.status in ('issued', 'confirmed', 'part_received')
union all
select 'receive_transfer', t.company_id, t.to_place_id, tp.name, 'inv.transfers', t.id, t.doc_no, 'From ' || fp.name, null, t.needed_by, '/inventory/stock-transfers'
from inv.transfers t join core.places tp on tp.id = t.to_place_id join core.places fp on fp.id = t.from_place_id where t.status = 'in_transit'
union all
select 'test_lot', l.company_id, b.place_id, pl.name, 'inv.lots', l.id, l.lot_no, pr.name, b.qty, null, '/inventory/warehouse'
from inv.lots l join master.products pr on pr.id = l.product_id join inv.stock_balances b on b.lot_id = l.id and b.bucket = 'quarantine' and b.qty > 0
join core.places pl on pl.id = b.place_id where l.status = 'quarantine'
union all
select 'put_away', b.company_id, b.place_id, pl.name, 'inv.lots', b.lot_id, l.lot_no, pr.name, b.qty, null, '/inventory/stock-movements'
from inv.stock_balances b join core.places pl on pl.id = b.place_id and pl.kind = 'quarantine' join master.products pr on pr.id = b.product_id left join inv.lots l on l.id = b.lot_id
where b.bucket = 'available' and b.qty > 0
union all
select 'pick_transfer', t.company_id, t.from_place_id, fp.name, 'inv.transfers', t.id, t.doc_no, 'To ' || tp.name, null, t.needed_by, '/inventory/stock-transfers'
from inv.transfers t join core.places tp on tp.id = t.to_place_id join core.places fp on fp.id = t.from_place_id where t.status = 'reserved'
union all
select 'hand_over_transfer', t.company_id, t.from_place_id, fp.name, 'inv.transfers', t.id, t.doc_no, 'To ' || tp.name, null, t.needed_by, '/inventory/stock-transfers'
from inv.transfers t join core.places tp on tp.id = t.to_place_id join core.places fp on fp.id = t.from_place_id where t.status in ('picked', 'handed_over')
union all
select 'count_due', c.company_id, c.place_id, pl.name, 'inv.cycle_counts', c.id, c.doc_no, case when c.status = 'counting' then 'Count open' else 'Count waiting approval' end,
       null, c.count_date, '/inventory/stock-movements'
from inv.cycle_counts c join core.places pl on pl.id = c.place_id where c.status in ('counting', 'submitted');

-- ─────────── Buying, logistics and petty cash home (/me/buying-logistics) ───────────
create or replace function api.buying_logistics_home(p_company_id uuid default null) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date; v_month date := date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date; v jsonb; v_tasks jsonb := '[]'::jsonb; n int;
begin
  v := jsonb_build_object(
    'requests_waiting', (select count(*) from purch.requests where status = 'submitted' and (p_company_id is null or company_id = p_company_id)),
    'requests_approved', (select count(*) from purch.requests where status = 'approved' and (p_company_id is null or company_id = p_company_id)),
    'orders_draft', (select count(*) from purch.orders where status = 'draft' and (p_company_id is null or company_id = p_company_id)),
    'orders_open', (select count(*) from purch.orders where status in ('issued', 'confirmed', 'part_received') and (p_company_id is null or company_id = p_company_id)),
    'orders_late', (select count(*) from purch.orders where status in ('issued', 'confirmed', 'part_received') and delivery_date < v_today and (p_company_id is null or company_id = p_company_id)),
    'receipts_today', (select count(*) from purch.goods_receipts where receipt_date = v_today and (p_company_id is null or company_id = p_company_id)),
    'lots_in_quarantine', (select count(*) from inv.lots where status = 'quarantine' and (p_company_id is null or company_id = p_company_id)),
    'bill_photos_to_review', (select count(*) from purch.bill_captures where status in ('uploaded', 'read', 'mismatch') and (p_company_id is null or company_id = p_company_id)),
    'transfers_in_transit', (select count(*) from inv.transfers where status = 'in_transit' and (p_company_id is null or company_id = p_company_id)),
    'transfers_to_carry', (select count(*) from inv.transfers where status = 'handed_over' and (p_company_id is null or company_id = p_company_id)),
    'msme_overdue', (select count(*) from api.msme_dues where state = 'overdue' and (p_company_id is null or company_id = p_company_id)),
    'msme_due_soon', (select count(*) from api.msme_dues where state = 'due_soon' and (p_company_id is null or company_id = p_company_id)),
    'price_increases_this_month', (select count(*) from api.price_changes where is_increase and latest_date >= v_month and (p_company_id is null or company_id = p_company_id)),
    'below_reorder', (select count(*) from api.item_stock where below_reorder and (p_company_id is null or company_id = p_company_id)));
  n := (v ->> 'transfers_to_carry')::int;
  if n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'carry', 'severity', 'high', 'title', n || ' transfers waiting for you to take over', 'href', '/inventory/stock-transfers'); end if;
  n := (v ->> 'bill_photos_to_review')::int;
  if n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'bills', 'severity', 'medium', 'title', n || ' bill photos to check', 'href', '/me/bill-photo'); end if;
  n := (v ->> 'orders_late')::int;
  if n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'late', 'severity', 'medium', 'title', n || ' orders past their delivery date', 'href', '/purchase/goods-receipt'); end if;
  n := (v ->> 'msme_overdue')::int;
  if n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'msme', 'severity', 'high', 'title', n || ' MSME bills past the due date', 'href', '/accounts/cash-flow-and-reminders'); end if;
  n := (v ->> 'below_reorder')::int;
  if n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'reorder', 'severity', 'low', 'title', n || ' items below reorder level', 'href', '/purchase/purchase-requests'); end if;
  return v || jsonb_build_object('tasks', v_tasks);
end $$;

-- ─────────── Law register ───────────
-- Branch delivery challans have no customer: the sales documents list keeps them (left join on parties).
create or replace view api.sales_documents with (security_invoker = true) as
select d.id, d.company_id, c.short_name as company_name, d.gstin_id, g.gstin, g.state_code as our_state, d.doc_type, d.doc_no, d.doc_date, d.party_id, p.legal_name as party_name,
       p.gstin as party_gstin, d.place_of_supply, d.tax_class, d.lawful_reason, d.against_id, d.reason, d.terms_days, d.due_date, d.taxable, d.cgst, d.sgst, d.igst, d.cess,
       d.round_off, d.total, d.status, d.voucher_id, d.irn, d.eway_bill_no, d.notes, d.created_at, d.posted_at,
       coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'sales_document' and a.against_id = d.id), 0)::numeric(18,2) as settled,
       app.amount_in_words(d.total) as amount_in_words
from sales.documents d join core.companies c on c.id = d.company_id join core.gstins g on g.id = d.gstin_id left join master.parties p on p.id = d.party_id;
update core.law_rules set status = 'built',
  enforced_in = 'api.save_purchase_order / issue_purchase_order / record_quotation refuse MSME terms over 45 days (check on purch.orders); save_purchase_draft caps terms at 45; api.msme_dues (due = acceptance + agreed days capped at 45, or 15 days when none agreed; warning window setting msme.warn_days)',
  test_ref = 'supabase/tests/13_purchase.sql'
where code = 'MSME-1';

update core.law_rules set
  enforced_in = 'app.compute_tax (CGST+SGST in the state, IGST across states); stock transfers: same GSTIN → delivery challan from the challan series (app.transfer_challan), another GSTIN → a posted tax invoice to that GSTIN with IGST across states before dispatch (app.check_transfer_invoice). E-way bill at dispatch arrives in Phase 8.',
  test_ref = 'supabase/tests/07_documents.sql, supabase/tests/12_inventory.sql'
where code = 'GST-3';

insert into core.law_rules (code, area, rule, what_erp_does, enforced_in, test_ref, status, phase, sort) values
  ('STK-1', 'Stock', 'Stock cannot go below zero; a negative-stock allowance is named per item and place and logged', 'Balance check constraint, per item+place lock, allowance table and use log',
   'app.stock_post, inv.stock_balances, inv.negative_stock_allowances, inv.negative_stock_uses', 'supabase/tests/12_inventory.sql', 'built', 4, 80)
on conflict (code) do nothing;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';
