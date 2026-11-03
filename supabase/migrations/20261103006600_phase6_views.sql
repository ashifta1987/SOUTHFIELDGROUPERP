-- 20261103006600_phase6_views.sql
-- Phase 6 read views for the screens (security_invoker: RLS and the view rule decide which rows arrive; without-GST documents are
-- invisible to non-Admin users, so every sum below is a GST-only sum for them). Additive.

create or replace view api.sales_orders with (security_invoker = true) as
select o.id, o.company_id, c.short_name as company_name, o.gstin_id, o.doc_no, o.order_date, o.delivery_date, o.party_id, p.legal_name as party_name, o.place_of_supply,
       o.channel, o.payment, o.salesman_user_id, su.display_name as salesman_name, o.place_id, pl.name as place_name, o.price_list_id, o.buyer_po_no, o.buyer_po_date, o.notes,
       o.taxable, o.cgst, o.sgst, o.igst, o.round_off, o.total, o.status, o.credit_check, o.credit_exception_id, o.private_label_id, o.export_order_id, o.online_order_id,
       o.created_by, cu.display_name as created_by_name, o.confirmed_by, o.confirmed_at, o.cancelled_at, o.cancel_reason, o.device_created_at, o.created_at,
       coalesce((select sum(round((l.qty - l.qty_invoiced) * l.total / l.qty, 2)) from sales.order_lines l where l.order_id = o.id), 0)::numeric(18,2) as open_value,
       (select count(*) from sales.dispatches d where d.order_id = o.id and d.status <> 'cancelled')::int as dispatches
from sales.orders o join core.companies c on c.id = o.company_id left join master.parties p on p.id = o.party_id left join core.places pl on pl.id = o.place_id
left join core.user_profiles su on su.user_id = o.salesman_user_id left join core.user_profiles cu on cu.user_id = o.created_by;

create or replace view api.sales_order_lines with (security_invoker = true) as
select l.id, l.order_id, l.line_no, l.product_id, pr.code as product_code, l.description, l.hsn_code, l.uom, l.qty, l.rate, l.discount, l.taxable, l.gst_rate, l.cgst, l.sgst, l.igst, l.total,
       l.qty_dispatched, l.qty_delivered, l.qty_invoiced, (l.qty - l.qty_dispatched)::numeric(18,3) as qty_to_dispatch
from sales.order_lines l left join master.products pr on pr.id = l.product_id;

create or replace view api.credit_customers with (security_invoker = true) as
select pc.company_id, pc.party_id, p.legal_name as party_name, p.gstin, p.kyc_status, p.customer_type, pc.credit_status, pc.credit_limit, pc.credit_term_id, t.label as terms,
       pc.credit_review_on, pc.salesman_user_id, u.display_name as salesman_name, pc.tier, pc.beat,
       r.receivables, oo.open_orders, ex.exception,
       (coalesce(pc.credit_limit, 0) * (pc.credit_status = 'active')::int + ex.exception - r.receivables - oo.open_orders)::numeric(18,2) as available,
       (select a.status || ':' || a.stage from sales.credit_applications a where a.company_id = pc.company_id and a.party_id = pc.party_id order by a.created_at desc limit 1) as last_application
from master.party_companies pc join master.parties p on p.id = pc.party_id
left join master.credit_terms t on t.id = pc.credit_term_id left join core.user_profiles u on u.user_id = pc.salesman_user_id
cross join lateral (select coalesce(sum(x.open), 0)::numeric(18,2) as receivables from (
    select d.total - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'sales_document' and a.against_id = d.id), 0) as open
    from sales.documents d where d.company_id = pc.company_id and d.party_id = pc.party_id and d.status = 'posted' and d.doc_type in ('sales_invoice', 'bill_of_supply')
    union all
    select o.amount - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'open_bill' and a.against_id = o.id), 0)
    from acct.open_bills o where o.company_id = pc.company_id and o.party_id = pc.party_id and o.dc = 'D' and app.can_see_bill_class(o.tax_class)) x where x.open > 0) r
cross join lateral (select coalesce(sum(round((l.qty - l.qty_invoiced) * l.total / l.qty, 2)), 0)::numeric(18,2) as open_orders
    from sales.orders o join sales.order_lines l on l.order_id = o.id
    where o.company_id = pc.company_id and o.party_id = pc.party_id and o.payment = 'credit' and o.status in ('confirmed', 'part_dispatched', 'dispatched')) oo
cross join lateral (select coalesce(sum(e.amount), 0)::numeric(18,2) as exception from sales.credit_exceptions e
    where e.company_id = pc.company_id and e.party_id = pc.party_id and e.revoked_at is null and now() < e.valid_until) ex
where pc.is_customer;

create or replace view api.credit_applications with (security_invoker = true) as
select a.id, a.company_id, a.doc_no, a.party_id, p.legal_name as party_name, a.requested_limit, a.requested_term_id, t.label as requested_terms, a.expected_monthly, a.security, a.note,
       a.stage, a.status, a.decided_limit, a.decided_term_id, a.review_on, a.reject_reason, a.requested_by, u.display_name as requested_by_name, a.created_at
from sales.credit_applications a left join master.parties p on p.id = a.party_id left join master.credit_terms t on t.id = a.requested_term_id left join core.user_profiles u on u.user_id = a.requested_by;

create or replace view api.credit_approvals with (security_invoker = true) as
select c.id, c.application_id, c.stage, c.decision, c.limit_amount, c.term_id, c.note, c.decided_by, u.display_name as decided_by_name, c.decided_at
from sales.credit_approvals c left join core.user_profiles u on u.user_id = c.decided_by;

create or replace view api.credit_exceptions with (security_invoker = true) as
select e.id, e.company_id, e.party_id, p.legal_name as party_name, e.order_id, e.amount, e.valid_until, e.reason, e.requested_by, e.granted_by, g.display_name as granted_by_name,
       e.granted_at, e.revoked_at, (e.revoked_at is null and now() < e.valid_until) as active
from sales.credit_exceptions e left join master.parties p on p.id = e.party_id left join core.user_profiles g on g.user_id = e.granted_by;

create or replace view api.promises_to_pay with (security_invoker = true) as
select id, company_id, party_id, amount, promised_on, note, status, recorded_by, created_at from sales.promises_to_pay;

-- Logistics
create or replace view api.vehicles with (security_invoker = true) as
select v.id, v.company_id, v.reg_no, v.kind, v.ownership, v.transporter, v.payload_kg, v.usual_driver_user_id, u.display_name as usual_driver_name, v.place_id, v.status, v.created_at,
       (select min(d.valid_to) from (select distinct on (kind) kind, valid_to from ops.vehicle_documents x where x.vehicle_id = v.id order by kind, set_at desc) d where d.valid_to is not null) as next_expiry,
       exists (select 1 from (select distinct on (kind) kind, valid_to from ops.vehicle_documents x where x.vehicle_id = v.id order by kind, set_at desc) d where d.valid_to < current_date) as has_expired_papers
from ops.vehicles v left join core.user_profiles u on u.user_id = v.usual_driver_user_id;

create or replace view api.vehicle_documents with (security_invoker = true) as
select distinct on (d.vehicle_id, d.kind) d.id, d.vehicle_id, d.kind, d.doc_no, d.valid_to, d.path, d.set_by, d.set_at, (d.valid_to - current_date) as days_left
from ops.vehicle_documents d order by d.vehicle_id, d.kind, d.set_at desc;

create or replace view api.vehicle_events with (security_invoker = true) as
select id, company_id, vehicle_id, kind, event_date, odometer_km, litres, amount, trip_id, paid_by, note, recorded_by, created_at from ops.vehicle_events;

create or replace view api.dispatches with (security_invoker = true) as
select d.id, d.company_id, d.doc_no, d.order_id, o.doc_no as order_no, d.party_id, p.legal_name as party_name, d.place_id, pl.name as place_name, d.scheduled_at, d.status,
       d.trip_id, t.doc_no as trip_no, t.vehicle_id, v.reg_no as vehicle_reg_no, d.document_id, sd.doc_no as invoice_no, d.eway_bill_no, d.value, d.dispatched_at, d.delivered_at,
       d.created_at, (d.document_id is not null) as invoice_ready, (d.eway_bill_no is not null) as eway_ready,
       exists (select 1 from sales.pods x where x.dispatch_id = d.id) as pod_recorded
from sales.dispatches d left join sales.orders o on o.id = d.order_id left join master.parties p on p.id = d.party_id left join core.places pl on pl.id = d.place_id
left join sales.trips t on t.id = d.trip_id left join ops.vehicles v on v.id = t.vehicle_id left join sales.documents sd on sd.id = d.document_id;

create or replace view api.dispatch_lines with (security_invoker = true) as
select dl.id, dl.dispatch_id, dl.order_line_id, dl.product_id, pr.code as product_code, pr.name as product_name, pr.uom, dl.qty, dl.qty_delivered, dl.qty_returned, dl.short_reason, dl.lots
from sales.dispatch_lines dl left join master.products pr on pr.id = dl.product_id;

create or replace view api.trips with (security_invoker = true) as
select t.id, t.company_id, t.doc_no, t.trip_date, t.vehicle_id, v.reg_no as vehicle_reg_no, t.driver_user_id, u.display_name as driver_name, t.transporter, t.lr_no, t.status,
       t.odometer_start, t.odometer_end, t.started_at, t.closed_at, t.created_at,
       (select count(*) from sales.trip_stops s where s.trip_id = t.id)::int as stops,
       (select count(*) from sales.trip_stops s where s.trip_id = t.id and s.status in ('delivered', 'part_delivered', 'failed'))::int as stops_done
from sales.trips t left join ops.vehicles v on v.id = t.vehicle_id left join core.user_profiles u on u.user_id = t.driver_user_id;

create or replace view api.trip_stops with (security_invoker = true) as
select s.id, s.trip_id, s.seq, s.dispatch_id, d.doc_no as dispatch_no, d.party_id, p.legal_name as party_name, s.status, s.arrived_at, s.done_at, s.fail_reason
from sales.trip_stops s left join sales.dispatches d on d.id = s.dispatch_id left join master.parties p on p.id = d.party_id;

create or replace view api.pods with (security_invoker = true) as
select id, company_id, stop_id, dispatch_id, received_by_name, case when receiver_phone_last4 is null then null else '••' || receiver_phone_last4 end as receiver_phone_masked,
       signature_path, photo_paths, lat, lng, remarks, device_at, recorded_by, created_at
from sales.pods;

-- Route sales
create or replace view api.beats with (security_invoker = true) as
select b.id, b.company_id, b.code, b.name, b.salesman_user_id, u.display_name as salesman_name, b.weekday, b.active,
       (select count(*) from field.beat_customers bc where bc.beat_id = b.id)::int as customers
from field.beats b left join core.user_profiles u on u.user_id = b.salesman_user_id;

create or replace view api.beat_customers with (security_invoker = true) as
select bc.beat_id, bc.party_id, p.legal_name as party_name, bc.seq from field.beat_customers bc left join master.parties p on p.id = bc.party_id;

create or replace view api.visits with (security_invoker = true) as
select v.id, v.company_id, v.salesman_user_id, u.display_name as salesman_name, v.party_id, p.legal_name as party_name, v.beat_id, v.planned, v.unplanned_reason,
       v.check_in_at, v.distance_m, v.geofence_ok, v.out_of_fence_reason, v.approval, v.approved_by, v.approved_at, v.check_out_at, v.check_out_distance_m, v.outcome,
       v.no_order_reason, v.shelf, v.competitor_notes, v.photo_paths, v.next_visit_on, v.created_at
from field.visits v left join master.parties p on p.id = v.party_id left join core.user_profiles u on u.user_id = v.salesman_user_id;

create or replace view api.gps_points with (security_invoker = true) as
select g.id, g.company_id, g.user_id, u.display_name as user_name, g.session_id, g.at, g.lat, g.lng, g.accuracy_m, g.source
from field.gps_points g left join core.user_profiles u on u.user_id = g.user_id;

create or replace view api.field_collections with (security_invoker = true) as
select c.id, c.company_id, c.salesman_user_id, u.display_name as salesman_name, c.party_id, p.legal_name as party_name, c.voucher_id, v.doc_no as receipt_no, c.amount, c.mode,
       c.reference, c.cheque_photo_path, c.handover_id, c.visit_id, c.collected_at
from field.collections c left join master.parties p on p.id = c.party_id left join core.user_profiles u on u.user_id = c.salesman_user_id left join acct.vouchers v on v.id = c.voucher_id;

create or replace view api.cash_handovers with (security_invoker = true) as
select h.id, h.company_id, h.salesman_user_id, su.display_name as salesman_name, h.cashier_user_id, cu.display_name as cashier_name, h.handover_date, h.expected_cash,
       h.salesman_count, h.salesman_total, h.cashier_count, h.cashier_total, h.cheques, h.difference, h.status, h.to_account_id, h.contra_voucher_id, h.bug_item_id,
       h.resolved_by, h.resolution_note, h.created_at, h.confirmed_at
from field.cash_handovers h left join core.user_profiles su on su.user_id = h.salesman_user_id left join core.user_profiles cu on cu.user_id = h.cashier_user_id;

create or replace view api.day_closes with (security_invoker = true) as
select d.id, d.company_id, d.user_id, u.display_name as user_name, d.close_date, d.visits_planned, d.visits_done, d.orders_total, d.collections_total, d.handover_id, d.van_counts, d.closed_at
from field.day_closes d left join core.user_profiles u on u.user_id = d.user_id;

create or replace view api.queries with (security_invoker = true) as
select q.id, q.company_id, q.party_id, p.legal_name as party_name, q.kind, q.document_id, sd.doc_no as document_no, q.lot_id, q.description, q.photo_paths, q.status,
       q.raised_by, u.display_name as raised_by_name, q.assigned_to, q.next_step, q.reply, q.complaint_id, q.created_at, q.updated_at,
       (current_date - q.created_at::date) as age_days
from field.queries q left join master.parties p on p.id = q.party_id left join core.user_profiles u on u.user_id = q.raised_by left join sales.documents sd on sd.id = q.document_id;

-- Customer care
create or replace view api.coverage_tiers with (security_invoker = true) as
select company_id, tier, call_every_days, visit_every_days, grace_days, set_by, set_at from sales.coverage_tiers;

create or replace view api.coverage_status with (security_invoker = true) as
select pc.company_id, pc.party_id, p.legal_name as party_name, pc.tier, pc.salesman_user_id, t.call_every_days, t.visit_every_days, t.grace_days,
       lc.last_call, lv.last_visit,
       (t.call_every_days is not null and (lc.last_call is null or lc.last_call::date + t.call_every_days <= current_date)) as call_due,
       (t.visit_every_days is not null and (lv.last_visit is null or lv.last_visit::date + t.visit_every_days <= current_date)) as visit_due,
       (t.call_every_days is not null and (lc.last_call is null or lc.last_call::date + t.call_every_days + t.grace_days < current_date)) as call_missed,
       (t.visit_every_days is not null and (lv.last_visit is null or lv.last_visit::date + t.visit_every_days + t.grace_days < current_date)) as visit_missed
from master.party_companies pc join master.parties p on p.id = pc.party_id join sales.coverage_tiers t on t.company_id = pc.company_id and t.tier = pc.tier
cross join lateral (select max(a.at) as last_call from sales.contact_attempts a where a.party_id = pc.party_id and a.company_id = pc.company_id and a.kind = 'call' and a.outcome = 'reached') lc
cross join lateral (select max(v.check_in_at) as last_visit from field.visits v where v.party_id = pc.party_id and v.company_id = pc.company_id and v.check_out_at is not null) lv
where pc.is_customer and pc.active;

create or replace view api.contact_attempts with (security_invoker = true) as
select a.id, a.company_id, a.party_id, a.kind, a.outcome, a.note, a.next_action, a.visit_id, a.by_user, u.display_name as by_name, a.at
from sales.contact_attempts a left join core.user_profiles u on u.user_id = a.by_user;

create or replace view api.complaints with (security_invoker = true) as
select c.id, c.company_id, c.doc_no, c.party_id, p.legal_name as party_name, c.document_id, sd.doc_no as document_no, c.product_id, pr.name as product_name, c.lot_id, l.lot_no,
       c.kind, c.description, c.severity, c.status, c.logged_by, lu.display_name as logged_by_name, c.assigned_to, c.qc_hold_id, h.status as hold_status, c.resolution,
       c.closed_by, c.closed_at, c.created_at
from sales.complaints c left join master.parties p on p.id = c.party_id left join sales.documents sd on sd.id = c.document_id left join master.products pr on pr.id = c.product_id
left join inv.lots l on l.id = c.lot_id left join inv.qc_holds h on h.id = c.qc_hold_id left join core.user_profiles lu on lu.user_id = c.logged_by;

create or replace view api.complaint_events with (security_invoker = true) as
select e.id, e.complaint_id, e.from_status, e.to_status, e.note, e.by_user, u.display_name as by_name, e.at
from sales.complaint_events e left join core.user_profiles u on u.user_id = e.by_user;

create or replace view api.qc_holds with (security_invoker = true) as
select h.id, h.company_id, h.lot_id, l.lot_no, l.product_id, pr.name as product_name, h.complaint_id, h.reason, h.status, h.qty_held, h.previous_lot_status, h.held_by, h.held_at,
       h.decided_by, h.decided_at, h.decision_note
from inv.qc_holds h left join inv.lots l on l.id = h.lot_id left join master.products pr on pr.id = l.product_id;

create or replace view api.private_label_orders with (security_invoker = true) as
select r.id, r.company_id, r.party_id, p.legal_name as party_name, r.brand_name, r.spec, r.artwork_path, r.status, r.created_by, r.sales_approved_by, r.quality_approved_by,
       r.md_approved_by, r.rejected_by, r.reject_reason, r.created_at
from sales.private_label_orders r left join master.parties p on p.id = r.party_id;

create or replace view api.agents with (security_invoker = true) as
select a.id, a.company_id, a.party_id, p.legal_name as party_name, a.model, a.commission_pct, a.status,
       (select count(*) from sales.agent_customers c where c.agent_id = a.id)::int as customers,
       coalesce((select sum(m.commission) from sales.agent_commissions m where m.agent_id = a.id), 0)::numeric(18,2) as commission_accrued
from sales.agents a left join master.parties p on p.id = a.party_id;

create or replace view api.agent_commissions with (security_invoker = true) as
select m.id, m.company_id, m.agent_id, m.voucher_id, v.doc_no as receipt_no, m.document_id, d.doc_no as invoice_no, m.collected, m.commission, m.period_from, m.period_to, m.created_at
from sales.agent_commissions m left join acct.vouchers v on v.id = m.voucher_id left join sales.documents d on d.id = m.document_id;

-- Own shops
create or replace view api.shops with (security_invoker = true) as
select s.id, s.company_id, s.branch_id, b.name as branch_name, b.gstin_id, g.gstin, s.place_id, pl.name as place_name, s.walk_in_party_id, s.cash_account_id, s.bank_account_id,
       s.price_list_id, s.active
from sales.shops s join core.branches b on b.id = s.branch_id left join core.gstins g on g.id = b.gstin_id left join core.places pl on pl.id = s.place_id;

create or replace view api.shop_days with (security_invoker = true) as
select d.id, d.company_id, d.shop_id, d.day, d.expected_cash, d.counted, d.counted_cash, d.upi_total, d.card_total, d.bills, d.difference, d.status, d.bug_item_id,
       d.closed_by, u.display_name as closed_by_name, d.closed_at
from sales.shop_days d left join core.user_profiles u on u.user_id = d.closed_by;

-- Exports and online
create or replace view api.export_orders with (security_invoker = true) as
select e.id, e.company_id, e.doc_no, e.party_id, p.legal_name as party_name, e.order_date, e.currency, e.fx_rate, e.incoterm, e.port_of_loading, e.destination, e.lut_ref,
       e.lut_valid_to, e.lines, e.status, e.created_at, (select count(*) from sales.containers c where c.export_order_id = e.id)::int as containers
from sales.export_orders e left join master.parties p on p.id = e.party_id;

create or replace view api.containers with (security_invoker = true) as
select id, export_order_id, container_no, seal_no, packing_list, loaded, check_status, check_result, checked_by, checked_at, created_at from sales.containers;

create or replace view api.export_invoices with (security_invoker = true) as
select x.document_id, d.doc_no, d.doc_date, d.total as total_inr, x.export_order_id, x.currency, x.fx_rate, x.value_fc, x.lut, x.shipping_bill_no, x.shipping_bill_date, x.port_code
from sales.export_invoices x join sales.documents d on d.id = x.document_id;

create or replace view api.online_channels with (security_invoker = true) as
select c.id, c.company_id, c.code, c.gstin_id, c.party_id, c.place_id, c.tcs_applicable, c.status,
       (select count(*) from sales.listings l where l.channel_id = c.id and l.status = 'listed')::int as listed,
       (select count(*) from sales.online_orders o where o.channel_id = c.id)::int as orders
from sales.online_channels c;

create or replace view api.listings with (security_invoker = true) as
select l.id, l.channel_id, c.code as channel, c.company_id, l.product_id, pr.code as product_code, pr.name as product_name, l.title, l.price, l.status, l.blockers, l.published_by, l.published_at
from sales.listings l join sales.online_channels c on c.id = l.channel_id left join master.products pr on pr.id = l.product_id;

create or replace view api.online_orders with (security_invoker = true) as
select o.id, o.company_id, o.channel_id, c.code as channel, o.external_order_id, o.order_date, o.ship_state, o.order_id, so.doc_no as order_no, so.status as order_status, o.status, o.created_at
from sales.online_orders o join sales.online_channels c on c.id = o.channel_id left join sales.orders so on so.id = o.order_id;

-- Schedule III mapping
create or replace view api.schedule3_lines with (security_invoker = true) as
select code, statement, side, section, label, note_ref, sort from acct.schedule3_lines;

create or replace view api.schedule3_map with (security_invoker = true) as
select g.company_id, g.id as account_group_id, g.name as group_name, g.nature, m.line_code, l.label as line_label, m.set_by, m.set_at, coalesce(m.ca_confirmed, false) as ca_confirmed,
       m.ca_note, m.confirmed_at
from acct.account_groups g left join acct.schedule3_map m on m.account_group_id = g.id left join acct.schedule3_lines l on l.code = m.line_code
where app.can(g.company_id, 'reports.view') or app.can(g.company_id, 'accounts.view');

-- WhatsApp inbox, tasks and costs
create or replace view api.msg_tasks with (security_invoker = true) as
select t.id, t.company_id, t.kind, t.party_id, p.legal_name as party_name, t.inbound_id, case when i.from_number is null then null else '••' || right(i.from_number, 4) end as from_masked,
       i.kind as message_kind, i.body as message_text, i.received_at, i.window_expires_at, t.priority, t.status, t.due_at, t.assigned_user_id, t.note, t.resolved_by, t.resolved_at, t.created_at
from msg.tasks t left join msg.inbound i on i.id = t.inbound_id left join master.parties p on p.id = t.party_id;

create or replace view api.msg_cost_caps with (security_invoker = true) as
select c.company_id, c.monthly_cap, c.alert_pct, c.set_at,
       app.msg_month_spend(c.company_id, date_trunc('month', now() at time zone 'Asia/Kolkata')::date) as spent_this_month
from msg.cost_caps c;

create or replace view api.msg_message_rates with (security_invoker = true) as
select id, category, est_cost, effective_from, set_at from msg.message_rates;

create or replace view api.msg_cost_by_month with (security_invoker = true) as
select o.company_id, date_trunc('month', o.created_at at time zone 'Asia/Kolkata')::date as month, o.category, o.event, count(*)::int as messages,
       count(*) filter (where o.status in ('sent', 'delivered', 'read'))::int as delivered_or_sent,
       count(*) filter (where o.status = 'skipped')::int as skipped,
       coalesce(sum(o.est_cost) filter (where o.status not in ('skipped', 'cancelled', 'failed')), 0)::numeric(18,2) as est_cost
from msg.outbox o group by 1, 2, 3, 4;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
notify pgrst, 'reload schema';
