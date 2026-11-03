-- 20261103008200_integrations_views.sql
-- Phase 8 read views (security invoker: the RLS of the tables underneath applies) and the marketplace TCS reconciliation.
-- TCS u/s 52 CGST: the operator's reported net taxable value and TCS against our books (posted GST invoices less credit
-- notes of the channel's orders). The TCS rate is a CA setting (`marketplace.tcs_rate_pct`, total of CGST+SGST or IGST,
-- with an effective date); while it is unset the expected TCS is empty and the row says `rate_not_set` — never invented.
-- Bills without GST never enter these figures. Additive.

create or replace view api.integration_requests with (security_invoker = true) as
select r.id, r.company_id, c.short_name as company_name, r.provider, r.kind, r.ref_table, r.ref_id, r.status, r.attempts, r.max_attempts,
       r.next_attempt_at, r.last_error, r.payload_hash, r.bug_id, b.code as bug_code, r.created_by, p.display_name as created_by_name,
       r.created_at, r.updated_at, r.done_at
from ops.integration_requests r
left join core.companies c on c.id = r.company_id
left join ops.bug_items b on b.id = r.bug_id
left join core.user_profiles p on p.user_id = r.created_by;

create or replace view api.integration_attempts with (security_invoker = true) as
select a.id, a.request_id, a.attempt_no, a.ok, a.error, a.retryable, a.next_attempt_at, a.at from ops.integration_attempts a;

create or replace view api.webhook_events with (security_invoker = true) as
select e.id, e.provider, e.external_id, e.topic, e.signature_ok, e.status, e.error, e.received_at, e.processed_at from ops.webhook_events e;

create or replace view api.einvoice_irns with (security_invoker = true) as
select i.id, i.company_id, i.document_id, d.doc_no, d.doc_type, d.doc_date, i.irn, i.ack_no, i.ack_date, i.status, i.is_mock, i.provider,
       i.cancel_reason, i.cancelled_at, i.created_at
from sales.einvoice_irns i join sales.documents d on d.id = i.document_id;

-- Per dispatch: e-way bill and e-invoice readiness (what start_trip and the leave guard will check).
create or replace view api.dispatch_compliance with (security_invoker = true) as
select x.id as dispatch_id, x.company_id, x.doc_no, x.status, x.document_id, x.eway_bill_no,
       e.id as eway_bill_id, e.status as eway_status, e.generated_at as eway_generated_at, e.valid_until as eway_valid_until, e.vehicle_no as eway_vehicle_no,
       e.is_mock as eway_is_mock,
       rq.id as eway_request_id, rq.status as eway_request_status, rq.last_error as eway_request_error, rq.next_attempt_at as eway_next_attempt_at,
       (x.document_id is not null and app.einvoice_pending(x.document_id)) as irn_missing
from sales.dispatches x
left join lateral (select * from sales.eway_bills b where b.dispatch_id = x.id order by (b.status = 'active') desc, b.created_at desc limit 1) e on true
left join lateral (select * from ops.integration_requests q where q.ref_table = 'sales.dispatches' and q.ref_id = x.id and q.kind = 'eway_generate'
                   order by q.created_at desc limit 1) rq on true;

create or replace view api.eway_bills with (security_invoker = true) as
select e.id, e.company_id, e.dispatch_id, x.doc_no as dispatch_no, e.document_id, d.doc_no as invoice_no, e.eway_bill_no, e.generated_at, e.valid_until,
       e.vehicle_no, e.transporter_gstin, e.distance_km, e.transport_mode, e.status, e.is_mock, e.provider, e.cancelled_at, e.created_at
from sales.eway_bills e left join sales.dispatches x on x.id = e.dispatch_id left join sales.documents d on d.id = e.document_id;

create or replace view api.bank_feeds with (security_invoker = true) as
select f.id, f.company_id, f.account_id, ba.bank_name, ba.account_last4, f.provider, f.status, f.last_sync_at, f.last_result, f.last_error, f.created_at
from acct.bank_feeds f join acct.bank_accounts ba on ba.account_id = f.account_id;

create or replace view api.channel_sync_log with (security_invoker = true) as
select s.id, s.company_id, s.channel_id, ch.code as channel_code, s.direction, s.kind, s.external_id, s.status, s.error, s.online_order_id,
       s.processed_at, s.created_at
from sales.channel_sync_log s join sales.online_channels ch on ch.id = s.channel_id;

create or replace view api.marketplace_settlements with (security_invoker = true) as
select s.id, s.company_id, s.channel_id, ch.code as channel_code, s.settlement_ref, s.period_from, s.period_to, s.payout_date, s.gross_sales, s.returns_value,
       s.net_taxable, s.tcs_cgst, s.tcs_sgst, s.tcs_igst, s.tcs_cgst + s.tcs_sgst + s.tcs_igst as tcs_total, s.tds_amount, s.commission, s.other_fees,
       s.net_payout, s.bank_line_id, s.reverses_id, s.source, s.note, s.created_at
from sales.marketplace_settlements s join sales.online_channels ch on ch.id = s.channel_id;

create or replace view api.tcs_reconciliation with (security_invoker = true) as
with st as (
  select s.company_id, s.channel_id, date_trunc('month', s.period_to)::date as month, sum(s.net_taxable) as operator_net_taxable,
         sum(s.tcs_cgst) as tcs_cgst, sum(s.tcs_sgst) as tcs_sgst, sum(s.tcs_igst) as tcs_igst, count(*)::int as settlements
  from sales.marketplace_settlements s group by 1, 2, 3),
docs as (
  select d.company_id, ch.channel_id, date_trunc('month', d.doc_date)::date as month,
         case when d.doc_type = 'credit_note' then -d.taxable else d.taxable end as taxable,
         case when d.doc_type = 'credit_note' then -1 else 1 end * (d.cgst + d.sgst + d.igst) as gst
  from sales.documents d
  join lateral (select oo.channel_id from sales.order_documents od join sales.orders o on o.id = od.order_id join sales.online_orders oo on oo.id = o.online_order_id
                where od.document_id = coalesce(d.against_id, d.id) limit 1) ch on true
  where d.status = 'posted' and d.tax_class = 'taxable' and d.doc_type in ('sales_invoice', 'credit_note')),
bk as (select company_id, channel_id, month, sum(taxable) as books_net_taxable, sum(gst) as books_gst from docs group by 1, 2, 3),
j as (
  select company_id, channel_id, month, st.operator_net_taxable, st.tcs_cgst, st.tcs_sgst, st.tcs_igst, st.settlements, bk.books_net_taxable, bk.books_gst,
         nullif(app.setting(company_id, 'marketplace.tcs_rate_pct', (month + interval '1 month - 1 day')::date) #>> '{}', '')::numeric as rate_pct
  from st full join bk using (company_id, channel_id, month))
select j.company_id, j.channel_id, ch.code as channel_code, j.month, coalesce(j.settlements, 0) as settlements,
       coalesce(j.operator_net_taxable, 0) as operator_net_taxable, coalesce(j.books_net_taxable, 0) as books_net_taxable,
       coalesce(j.operator_net_taxable, 0) - coalesce(j.books_net_taxable, 0) as taxable_difference,
       coalesce(j.tcs_cgst, 0) as tcs_cgst, coalesce(j.tcs_sgst, 0) as tcs_sgst, coalesce(j.tcs_igst, 0) as tcs_igst,
       coalesce(j.tcs_cgst, 0) + coalesce(j.tcs_sgst, 0) + coalesce(j.tcs_igst, 0) as operator_tcs,
       j.rate_pct, round(coalesce(j.books_net_taxable, 0) * j.rate_pct / 100, 2) as expected_tcs,
       coalesce(j.tcs_cgst, 0) + coalesce(j.tcs_sgst, 0) + coalesce(j.tcs_igst, 0) - round(coalesce(j.books_net_taxable, 0) * j.rate_pct / 100, 2) as tcs_difference,
       case when j.rate_pct is null then 'rate_not_set'
            when j.settlements is null then 'no_settlement'
            when j.books_net_taxable is null then 'not_in_books'
            when coalesce(j.tcs_cgst, 0) + coalesce(j.tcs_sgst, 0) + coalesce(j.tcs_igst, 0) = round(j.books_net_taxable * j.rate_pct / 100, 2)
                 and j.operator_net_taxable = j.books_net_taxable then 'matched'
            else 'mismatch' end as status
from j join sales.online_channels ch on ch.id = j.channel_id
where app.can(j.company_id, 'accounts.view');

create or replace view api.gps_devices with (security_invoker = true) as
select g.id, g.company_id, g.provider, g.device_ref, g.user_id, p.display_name as user_name, g.vehicle_id, v.reg_no as vehicle_reg_no, g.active, g.created_at
from ops.gps_devices g left join core.user_profiles p on p.user_id = g.user_id left join ops.vehicles v on v.id = g.vehicle_id;

-- Number masked except the last four digits (DPDP).
create or replace view api.help_whatsapp_staff with (security_invoker = true) as
select w.id, w.person_id, pe.name as person_name, w.user_id, '+91 ••••• •' || right(w.number, 4) as number_masked, w.language, w.consent_at,
       w.verified_at, w.verified_by, vp.display_name as verified_by_name, w.revoked_at
from help.whatsapp_staff w join master.people pe on pe.id = w.person_id left join core.user_profiles vp on vp.user_id = w.verified_by;

-- GSTINs with the e-invoice switch and its start date (the Branches screen keeps its own view).
create or replace view api.einvoice_switches with (security_invoker = true) as
select g.id as gstin_id, g.company_id, c.short_name as company_name, g.gstin, g.state_code, g.einvoice_enabled, g.einvoice_from, g.status
from core.gstins g join core.companies c on c.id = g.company_id;

grant select on all tables in schema api to authenticated;
