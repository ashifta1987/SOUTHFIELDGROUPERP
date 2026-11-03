-- 20261103005300_production_views.sql
-- Phase 5 read side for the screens (security_invoker: table RLS decides rows; costs only with cost.view).
-- Law register: COS-1 (licence block) built; PROD-1 (self-release), PROD-2 (packaging reconciliation), GST-FREE (Q-23). Additive.

-- ─────────── Licences, families, formulas ───────────
create or replace view api.licences with (security_invoker = true) as
select l.id, l.company_id, c.short_name as company_name, l.branch_id, br.name as branch_name, l.kind, l.licence_no, l.issued_by, l.valid_from, l.valid_to, l.status,
       l.document_path, l.note, l.created_at, l.updated_at,
       (l.status = 'active' and l.valid_from <= current_date and (l.valid_to is null or l.valid_to >= current_date)) as is_valid,
       case when l.valid_to is null then null else l.valid_to - current_date end as days_to_expiry
from core.licences l join core.companies c on c.id = l.company_id left join core.branches br on br.id = l.branch_id;

create or replace view api.process_families with (security_invoker = true) as
select f.id, f.company_id, f.code, f.name, f.licence_kind, f.steps, f.status, f.created_at,
       (select count(*) from prod.formulas x where x.family_id = f.id)::int as formulas,
       (select count(*) from prod.formulas x join prod.formula_versions v on v.formula_id = x.id where x.family_id = f.id and v.status = 'approved')::int as approved_formulas,
       case when f.licence_kind is null then null
            else exists (select 1 from core.licences l where l.company_id = f.company_id and l.kind = f.licence_kind and l.status = 'active'
                         and l.valid_from <= current_date and (l.valid_to is null or l.valid_to >= current_date)) end as licence_ok
from prod.process_families f;

create or replace view api.formula_versions with (security_invoker = true) as
select v.id, v.company_id, v.formula_id, f.code as formula_code, f.name as formula_name, f.product_id, p.code as product_code, p.name as product_name,
       f.family_id, fam.code as family_code, fam.name as family_name, v.version, v.status, v.batch_size, v.fill_qty_g, v.qc_spec, v.effective_from, v.effective_to, v.notes,
       v.created_by, cu.display_name as created_by_name, v.created_at, v.submitted_by, v.submitted_at, v.approved_by, au.display_name as approved_by_name, v.approved_at,
       (v.status in ('approved', 'superseded') and v.effective_from <= current_date and (v.effective_to is null or v.effective_to >= current_date)) as in_force,
       (select count(*) from prod.formula_lines l where l.version_id = v.id and l.line_kind = 'bulk')::int as bulk_lines,
       (select count(*) from prod.formula_lines l where l.version_id = v.id and l.line_kind = 'packaging')::int as packaging_lines
from prod.formula_versions v
join prod.formulas f on f.id = v.formula_id
join master.products p on p.id = f.product_id
join prod.process_families fam on fam.id = f.family_id
left join core.user_profiles cu on cu.user_id = v.created_by
left join core.user_profiles au on au.user_id = v.approved_by;

create or replace view api.formula_lines with (security_invoker = true) as
select l.id, l.company_id, l.version_id, l.line_no, l.line_kind, l.product_id, p.code as product_code, p.name as product_name, p.uom, l.qty, l.note
from prod.formula_lines l join master.products p on p.id = l.product_id;

-- ─────────── Batches ───────────
create or replace view api.batches with (security_invoker = true) as
select b.id, b.company_id, b.batch_no, b.product_id, p.code as product_code, p.name as product_name, b.formula_version_id, f.code as formula_code, v.version as formula_version,
       b.family_id, fam.name as family_name, b.licence_id, lic.licence_no, lic.valid_to as licence_valid_to, b.line_place_id, lp.name as line_place_name,
       b.stores_place_id, sp.name as stores_place_name, b.fg_place_id, fp.name as fg_place_name, b.batch_date, b.shift, b.planned_qty, b.status,
       b.bulk_qty, b.bulk_scrap_kg, b.bulk_left_kg, b.fill_qty_g, b.good_packs, b.rejected_packs, b.fg_lot_id, b.mfg_date, b.expiry_date,
       b.labour_hours, b.machine_hours, b.recon_status, b.basis_locked, b.note, b.reject_reason,
       b.planned_by, pu.display_name as planned_by_name, b.started_by, b.started_at, b.packed_by, b.packed_at,
       b.released_by, ru.display_name as released_by_name, b.released_at, b.closed_by, b.closed_at, b.created_at,
       (auth.uid() = any (app.batch_makers(b.id))) as i_made_it,
       (select count(*) from prod.weighings w where w.batch_id = b.id and w.status = 'weighed')::int as weighings_to_check,
       (select t.result from prod.lab_tests t where t.batch_id = b.id and t.kind = 'bulk' order by t.created_at desc, t.id desc limit 1) as last_bulk_result,
       (select t.result from prod.lab_tests t where t.batch_id = b.id and t.kind = 'finished' order by t.created_at desc, t.id desc limit 1) as last_finished_result
from prod.batches b
join master.products p on p.id = b.product_id
join prod.formula_versions v on v.id = b.formula_version_id
join prod.formulas f on f.id = v.formula_id
join prod.process_families fam on fam.id = b.family_id
left join core.licences lic on lic.id = b.licence_id
join core.places lp on lp.id = b.line_place_id
join core.places sp on sp.id = b.stores_place_id
join core.places fp on fp.id = b.fg_place_id
left join core.user_profiles pu on pu.user_id = b.planned_by
left join core.user_profiles ru on ru.user_id = b.released_by;

create or replace view api.batch_events with (security_invoker = true) as
select e.id, e.company_id, e.batch_id, e.from_status, e.to_status, e.note, e.by_user, u.display_name as by_name, e.at
from prod.batch_events e left join core.user_profiles u on u.user_id = e.by_user;

create or replace view api.batch_weighings with (security_invoker = true) as
select w.id, w.company_id, w.batch_id, w.product_id, p.code as product_code, p.name as product_name, w.lot_id, l.lot_no, w.planned_qty, w.weighed_qty,
       (w.weighed_qty - coalesce(w.planned_qty, 0))::numeric(18,3) as variance, w.scale_asset_id, a.code as scale_code, w.status,
       w.weighed_by, wu.display_name as weighed_by_name, w.weighed_at, w.verified_by, vu.display_name as verified_by_name, w.verified_at, w.note,
       (w.status = 'weighed' and w.weighed_by <> auth.uid()) as i_can_check
from prod.weighings w
join master.products p on p.id = w.product_id
left join inv.lots l on l.id = w.lot_id
left join core.assets a on a.id = w.scale_asset_id
left join core.user_profiles wu on wu.user_id = w.weighed_by
left join core.user_profiles vu on vu.user_id = w.verified_by;

create or replace view api.batch_packaging with (security_invoker = true) as
select r.id, r.company_id, r.batch_id, r.product_id, p.code as product_code, p.name as product_name, p.uom, r.issued, r.in_good, r.in_rejected, r.scrapped, r.returned,
       r.at_line, r.difference, (r.difference = 0) as balanced, r.updated_at
from prod.packaging_recon r join master.products p on p.id = r.product_id;

create or replace view api.material_consumption with (security_invoker = true) as
select m.id, m.company_id, m.source_table, m.source_id, m.batch_id, b.batch_no, m.kind, m.product_id, p.code as product_code, p.name as product_name, p.uom,
       m.lot_id, l.lot_no, m.place_id, pl.name as place_name, m.qty, m.consumed_on, m.created_by, m.created_at,
       case when app.can(m.company_id, 'cost.view') then m.unit_cost end as unit_cost,
       case when app.can(m.company_id, 'cost.view') then m.value end as value
from prod.material_consumption m
join master.products p on p.id = m.product_id
join core.places pl on pl.id = m.place_id
left join prod.batches b on b.id = m.batch_id
left join inv.lots l on l.id = m.lot_id;

-- ─────────── Labs ───────────
create or replace view api.lab_samples with (security_invoker = true) as
select s.id, s.company_id, s.sample_no, s.kind, s.batch_id, b.batch_no, coalesce(b.product_id, l.product_id) as product_id, p.code as product_code, p.name as product_name,
       s.lot_id, l.lot_no, s.trial_id, t.code as trial_code, s.assigned_to, au.display_name as assigned_to_name, s.status, s.retain_until, s.note,
       s.taken_by, tu.display_name as taken_by_name, s.taken_at,
       (select x.result from prod.lab_tests x where x.sample_id = s.id order by x.created_at desc, x.id desc limit 1) as last_result,
       coalesce(jsonb_array_length(v.qc_spec), 0) as spec_parameters
from prod.lab_samples s
left join prod.batches b on b.id = s.batch_id
left join prod.formula_versions v on v.id = b.formula_version_id
left join inv.lots l on l.id = s.lot_id
left join master.products p on p.id = coalesce(b.product_id, l.product_id)
left join prod.rnd_trials t on t.id = s.trial_id
left join core.user_profiles au on au.user_id = s.assigned_to
left join core.user_profiles tu on tu.user_id = s.taken_by;

create or replace view api.lab_tests with (security_invoker = true) as
-- Phase 4 columns first (same order), Phase 5 columns appended; tests without a lot (bulk, R&D) are now included.
select t.id, t.company_id, t.lot_id, l.lot_no, coalesce(l.product_id, b.product_id) as product_id, p.name as product_name, t.kind, t.result, t.parameters, t.remarks,
       t.test_date, t.tested_by, u.display_name as tested_by_name, t.created_at,
       t.out_of_spec, t.batch_id, b.batch_no, t.sample_id, s.sample_no, t.instrument_id, a.code as instrument_code
from prod.lab_tests t
left join inv.lots l on l.id = t.lot_id
left join prod.batches b on b.id = t.batch_id
left join master.products p on p.id = coalesce(l.product_id, b.product_id)
left join prod.lab_samples s on s.id = t.sample_id
left join core.assets a on a.id = t.instrument_id
left join core.user_profiles u on u.user_id = t.tested_by;

create or replace view api.rnd_trials with (security_invoker = true) as
select t.id, t.company_id, t.code, t.title, t.family_id, f.name as family_name, t.formula_version_id, t.assigned_to, u.display_name as assigned_to_name, t.status,
       t.started_on, t.notes, t.created_at,
       (select min(s.due_on) from prod.stability_checks s where s.trial_id = t.id and s.result is null) as next_check_due
from prod.rnd_trials t left join prod.process_families f on f.id = t.family_id left join core.user_profiles u on u.user_id = t.assigned_to;

create or replace view api.stability_checks with (security_invoker = true) as
select s.id, s.company_id, s.trial_id, t.code as trial_code, s.day_no, s.condition, s.due_on, s.result, s.observations, s.recorded_by, u.display_name as recorded_by_name, s.recorded_at
from prod.stability_checks s join prod.rnd_trials t on t.id = s.trial_id left join core.user_profiles u on u.user_id = s.recorded_by;

-- The Lab panel's "My work today": samples to test, trial checks and instruments due, for the signed-in user (and unassigned work).
create or replace view api.my_lab_work with (security_invoker = true) as
select 'sample'::text as kind, s.id, s.company_id, s.sample_no as ref, coalesce(b.batch_no, t.code) as detail, s.kind as sub_kind, s.taken_at::date as due_on,
       (s.assigned_to = auth.uid()) as mine,
       (s.batch_id is not null and auth.uid() = any (app.batch_makers(s.batch_id))) as i_made_it
from prod.lab_samples s left join prod.batches b on b.id = s.batch_id left join prod.rnd_trials t on t.id = s.trial_id
where s.status = 'pending' and (s.assigned_to is null or s.assigned_to = auth.uid())
union all
select 'stability', c.id, c.company_id, t.code, 'Day ' || c.day_no || coalesce(' · ' || c.condition, ''), 'stability', c.due_on, (t.assigned_to = auth.uid()), false
from prod.stability_checks c join prod.rnd_trials t on t.id = c.trial_id
where c.result is null and c.due_on <= current_date + 1 and (t.assigned_to is null or t.assigned_to = auth.uid())
union all
select 'calibration', a.id, a.company_id, a.code, a.name, a.kind, a.calibration_due, false, false
from core.assets a where a.needs_calibration and a.status = 'active' and a.kind in ('lab_instrument', 'scale') and (a.calibration_due is null or a.calibration_due <= current_date + 7)
union all
select 'release', b.id, b.company_id, b.batch_no, p.name, 'finished', b.packed_at::date, false, (auth.uid() = any (app.batch_makers(b.id)))
from prod.batches b join master.products p on p.id = b.product_id
where b.status = 'packed_hold' and app.can(b.company_id, 'qc.release');

-- ─────────── Assets ───────────
create or replace view api.assets with (security_invoker = true) as
select a.id, a.company_id, c.short_name as company_name, a.code, a.name, a.kind, a.place_id, pl.name as place_name, a.make, a.model, a.serial_no, a.attrs,
       a.purchase_date, a.put_to_use_date, a.useful_life_years, a.residual_pct, a.needs_calibration, a.calibration_interval_days, a.calibration_due,
       (a.needs_calibration and (a.calibration_due is null or a.calibration_due < current_date)) as calibration_overdue,
       case when a.calibration_due is null then null else a.calibration_due - current_date end as days_to_calibration,
       a.amc_vendor, a.amc_until, a.status, a.created_at,
       case when app.can(a.company_id, 'cost.view') then a.cost end as cost,
       (select m.code from prod.moulds m where m.machine_asset_id = a.id and m.location = 'machine' limit 1) as mould_on_machine,
       (select max(k.check_date) from prod.machine_checks k where k.asset_id = a.id) as last_check_date
from core.assets a join core.companies c on c.id = a.company_id left join core.places pl on pl.id = a.place_id;

create or replace view api.asset_events with (security_invoker = true) as
select e.id, e.company_id, e.asset_id, a.code as asset_code, e.kind, e.event_date, e.detail, e.amount, e.recorded_by, u.display_name as recorded_by_name, e.created_at
from core.asset_events e join core.assets a on a.id = e.asset_id left join core.user_profiles u on u.user_id = e.recorded_by;

create or replace view api.calibrations with (security_invoker = true) as
select k.id, k.company_id, k.asset_id, a.code as asset_code, a.name as asset_name, k.calibrated_on, k.next_due, k.result, k.agency, k.certificate_path, k.remarks,
       k.recorded_by, u.display_name as recorded_by_name, k.created_at
from prod.calibrations k join core.assets a on a.id = k.asset_id left join core.user_profiles u on u.user_id = k.recorded_by;

create or replace view api.asset_documents with (security_invoker = true) as
select d.id, d.company_id, d.asset_id, d.kind, d.path, d.valid_to, d.uploaded_by, d.created_at from core.asset_documents d;

-- ─────────── Work assignment ───────────
create or replace view api.shift_assignments with (security_invoker = true) as
select s.id, s.company_id, s.place_id, pl.name as place_name, s.work_date, s.shift, s.user_id, u.display_name as user_name, s.duty, s.batch_id, b.batch_no,
       s.asset_id, a.code as asset_code, s.hours, s.assigned_by, s.assigned_at
from prod.shift_assignments s
left join core.places pl on pl.id = s.place_id
left join core.user_profiles u on u.user_id = s.user_id
left join prod.batches b on b.id = s.batch_id
left join core.assets a on a.id = s.asset_id;

create or replace view api.factory_workload with (security_invoker = true) as
select s.company_id, s.work_date, s.shift, s.user_id, u.display_name as user_name, count(*)::int as duties, array_agg(distinct s.duty order by s.duty) as duty_list,
       coalesce(sum(s.hours), 0)::numeric(9,2) as hours, count(distinct s.batch_id)::int as batches
from prod.shift_assignments s left join core.user_profiles u on u.user_id = s.user_id
group by s.company_id, s.work_date, s.shift, s.user_id, u.display_name;

-- ─────────── Packs ───────────
create or replace view api.packs with (security_invoker = true) as
select k.id, k.company_id, k.product_id, p.code as product_code, p.name as product_name, k.kind, k.name, k.gst_treatment, k.gst_treatment_note,
       (k.gst_treatment is not null) as gst_treatment_set, k.gst_treatment_set_at, k.status, k.created_at,
       (select count(*) from prod.pack_items i where i.pack_id = k.id)::int as items,
       (select count(*) from prod.pack_items i where i.pack_id = k.id and i.is_free)::int as free_items
from prod.packs k join master.products p on p.id = k.product_id;

create or replace view api.pack_items with (security_invoker = true) as
select i.id, i.company_id, i.pack_id, i.product_id, p.code as product_code, p.name as product_name, p.uom, i.qty, i.is_free, i.note
from prod.pack_items i join master.products p on p.id = i.product_id;

create or replace view api.pack_assemblies with (security_invoker = true) as
select a.id, a.company_id, a.doc_no, a.pack_id, k.name as pack_name, a.qty, a.from_place_id, a.to_place_id, a.assembly_date, a.assembled_by, a.created_at,
       case when app.can(a.company_id, 'cost.view') then a.unit_cost end as unit_cost
from prod.pack_assemblies a join prod.packs k on k.id = a.pack_id;

-- ─────────── Costing (cost.view) ───────────
create or replace view api.cost_rates with (security_invoker = true) as
select r.id, r.company_id, r.kind, r.rate, r.effective_from, r.note, r.set_by, r.set_at from prod.cost_rates r;

-- Live for open batches (app.batch_cost), fixed at close (prod.batch_costs). Compared with MRP.
create or replace view api.batch_costs with (security_invoker = true) as
select b.id as batch_id, b.company_id, b.batch_no, b.status, b.product_id, p.code as product_code, p.name as product_name, b.family_id, fam.name as family_name,
       (bc.id is not null) as final,
       coalesce(bc.materials, (x.c ->> 'materials')::numeric)::numeric(18,2) as materials,
       coalesce(bc.packaging, (x.c ->> 'packaging')::numeric)::numeric(18,2) as packaging,
       coalesce(bc.labour, (x.c ->> 'labour')::numeric)::numeric(18,2) as labour,
       coalesce(bc.machine, (x.c ->> 'machine')::numeric)::numeric(18,2) as machine,
       coalesce(bc.overhead, (x.c ->> 'overhead')::numeric)::numeric(18,2) as overhead,
       coalesce(bc.total, (x.c ->> 'total')::numeric)::numeric(18,2) as total,
       b.good_packs, coalesce(bc.cost_per_pack, nullif(x.c ->> 'cost_per_pack', '')::numeric)::numeric(18,4) as cost_per_pack,
       coalesce(bc.rates_missing, array(select jsonb_array_elements_text(x.c -> 'rates_missing'))) as rates_missing,
       (select m.mrp from master.product_mrp_history m where m.product_id = b.product_id and m.effective_from <= current_date order by m.effective_from desc limit 1) as mrp
from prod.batches b
join master.products p on p.id = b.product_id
join prod.process_families fam on fam.id = b.family_id
left join prod.batch_costs bc on bc.batch_id = b.id
cross join lateral (select app.batch_cost(b.id) as c) x
where app.can(b.company_id, 'cost.view') and b.status not in ('cancelled', 'planned');

-- ─────────── Plastics ───────────
create or replace view api.mould_projects with (security_invoker = true) as
select m.id, m.company_id, m.code, m.name, m.product_id, p.code as product_code, p.name as product_name, m.ownership, m.buyer_party_id, bp.legal_name as buyer_name,
       m.stage, m.target_date, m.notes, m.created_by, m.created_at, m.approved_by, m.approved_at,
       case when app.can(m.company_id, 'cost.view') then m.estimated_cost end as estimated_cost
from prod.mould_projects m left join master.products p on p.id = m.product_id left join master.parties bp on bp.id = m.buyer_party_id;

create or replace view api.moulds with (security_invoker = true) as
select m.id, m.company_id, m.code, m.name, m.project_id, m.product_id, p.code as product_code, p.name as product_name, m.material_product_id, g.code as material_code,
       m.cavities, m.cycle_time_sec, m.part_weight_g, m.runner_weight_g, m.ownership, m.buyer_party_id, bp.legal_name as buyer_name, m.location, m.place_id, pl.name as place_name,
       m.machine_asset_id, a.code as machine_code, m.shot_count, m.shots_at_last_service, (m.shot_count - m.shots_at_last_service) as shots_since_service,
       m.service_interval_shots, (m.service_interval_shots is not null and m.shot_count - m.shots_at_last_service >= m.service_interval_shots) as service_due,
       m.life_shots, case when m.life_shots is not null then round(m.shot_count::numeric / m.life_shots * 100, 2) end as life_used_pct, m.status, m.created_at
from prod.moulds m
left join master.products p on p.id = m.product_id
left join master.products g on g.id = m.material_product_id
left join master.parties bp on bp.id = m.buyer_party_id
left join core.places pl on pl.id = m.place_id
left join core.assets a on a.id = m.machine_asset_id;

create or replace view api.mould_events with (security_invoker = true) as
select e.id, e.company_id, e.mould_id, m.code as mould_code, e.project_id, e.kind, e.event_date, e.detail, e.shots, e.source_id, e.recorded_by, u.display_name as recorded_by_name,
       e.created_at, case when app.can(e.company_id, 'cost.view') then e.amount end as amount
from prod.mould_events e left join prod.moulds m on m.id = e.mould_id left join core.user_profiles u on u.user_id = e.recorded_by;

-- Mould cost per shot and per piece = (mould cost + services and repairs) ÷ life shots (÷ cavities).
create or replace view api.mould_costs with (security_invoker = true) as
select m.id as mould_id, m.company_id, m.code, m.name, m.cavities, m.shot_count, m.life_shots, m.cost,
       coalesce((select sum(e.amount) from prod.mould_events e where e.mould_id = m.id and e.kind in ('service', 'repair')), 0)::numeric(18,2) as upkeep,
       case when m.life_shots is not null and m.cost is not null then round((m.cost + coalesce((select sum(e.amount) from prod.mould_events e where e.mould_id = m.id and e.kind in ('service', 'repair')), 0)) / m.life_shots, 4) end as cost_per_shot,
       case when m.life_shots is not null and m.cost is not null then round((m.cost + coalesce((select sum(e.amount) from prod.mould_events e where e.mould_id = m.id and e.kind in ('service', 'repair')), 0)) / m.life_shots / m.cavities, 4) end as cost_per_piece
from prod.moulds m where app.can(m.company_id, 'cost.view');

create or replace view api.injection_shifts with (security_invoker = true) as
select s.id, s.company_id, s.doc_no, s.place_id, pl.name as place_name, s.output_place_id, s.shift_date, s.shift, s.machine_asset_id, a.code as machine_code,
       s.mould_id, m.code as mould_code, s.product_id, p.code as product_code, p.name as product_name, s.operator_user_id, coalesce(u.display_name, s.operator_name) as operator_name,
       s.cavities_running, s.cycle_time_sec, s.planned_minutes, s.downtime_minutes, s.run_minutes, s.shot_start, s.shot_end, s.shots, s.good_qty, s.reject_qty,
       (s.good_qty + s.reject_qty)::numeric(18,3) as total_qty, s.theoretical_qty, s.availability, s.performance, s.quality, s.oee, s.lot_id, l.status as lot_status, s.note,
       s.recorded_by, s.created_at
from prod.injection_shifts s
join core.places pl on pl.id = s.place_id
join core.assets a on a.id = s.machine_asset_id
join prod.moulds m on m.id = s.mould_id
join master.products p on p.id = s.product_id
left join core.user_profiles u on u.user_id = s.operator_user_id
left join inv.lots l on l.id = s.lot_id;

create or replace view api.shift_rejects with (security_invoker = true) as
select r.id, r.company_id, r.shift_id, r.reason, r.qty from prod.shift_rejects r;

create or replace view api.shift_downtime with (security_invoker = true) as
select d.id, d.company_id, d.shift_id, d.kind, d.reason, d.minutes from prod.downtime d;

create or replace view api.quality_inspections with (security_invoker = true) as
select q.id, q.company_id, q.lot_id, l.lot_no, l.product_id, p.code as product_code, p.name as product_name, q.shift_id, q.assembly_order_id, q.kind, q.sample_qty,
       q.accepted_qty, q.rejected_qty, q.result, q.defects, q.remarks, q.inspection_date, q.inspected_by, u.display_name as inspected_by_name, q.created_at
from prod.quality_inspections q join inv.lots l on l.id = q.lot_id join master.products p on p.id = l.product_id left join core.user_profiles u on u.user_id = q.inspected_by;

create or replace view api.assembly_boms with (security_invoker = true) as
select b.id, b.company_id, b.product_id, p.code as product_code, p.name as product_name, b.version, b.status, b.notes, b.created_by, cu.display_name as created_by_name,
       b.created_at, b.approved_by, au.display_name as approved_by_name, b.approved_at,
       (select count(*) from prod.assembly_bom_lines l where l.bom_id = b.id)::int as lines
from prod.assembly_boms b join master.products p on p.id = b.product_id
left join core.user_profiles cu on cu.user_id = b.created_by left join core.user_profiles au on au.user_id = b.approved_by;

create or replace view api.assembly_bom_lines with (security_invoker = true) as
select l.id, l.company_id, l.bom_id, l.product_id, p.code as product_code, p.name as product_name, p.uom, l.qty_per, l.note,
       case when app.can(l.company_id, 'cost.view') then app.avg_cost(l.company_id, l.product_id) end as avg_cost
from prod.assembly_bom_lines l join master.products p on p.id = l.product_id;

create or replace view api.assembly_orders with (security_invoker = true) as
select o.id, o.company_id, o.doc_no, o.bom_id, b.version as bom_version, o.product_id, p.code as product_code, p.name as product_name, o.qty, o.from_place_id, o.to_place_id,
       o.lot_id, l.status as lot_status, o.labour_hours, o.order_date, o.note, o.assembled_by, u.display_name as assembled_by_name, o.created_at,
       case when app.can(o.company_id, 'cost.view') then o.unit_cost end as unit_cost
from prod.assembly_orders o join prod.assembly_boms b on b.id = o.bom_id join master.products p on p.id = o.product_id
left join inv.lots l on l.id = o.lot_id left join core.user_profiles u on u.user_id = o.assembled_by;

-- Standard cost of an assembled item from its approved BOM at weighted average cost (labour by rate when set).
create or replace view api.assembly_costs with (security_invoker = true) as
select b.id as bom_id, b.company_id, b.product_id, p.code as product_code, p.name as product_name, b.version,
       coalesce(sum(round(l.qty_per * coalesce(app.avg_cost(b.company_id, l.product_id), 0), 2)), 0)::numeric(18,2) as components_cost,
       count(*) filter (where app.avg_cost(b.company_id, l.product_id) is null)::int as components_without_cost,
       (select m.mrp from master.product_mrp_history m where m.product_id = b.product_id and m.effective_from <= current_date order by m.effective_from desc limit 1) as mrp
from prod.assembly_boms b join master.products p on p.id = b.product_id join prod.assembly_bom_lines l on l.bom_id = b.id
where b.status = 'approved' and app.can(b.company_id, 'cost.view')
group by b.id, b.company_id, b.product_id, p.code, p.name, b.version;

create or replace view api.pad_print_jobs with (security_invoker = true) as
select j.id, j.company_id, j.doc_no, j.job_date, j.product_id, p.code as product_code, p.name as product_name, j.machine_asset_id, a.code as machine_code,
       j.operator_user_id, u.display_name as operator_name, j.qty_printed, j.qty_rejected, j.prints_per_piece, j.ink_product_id, j.ink_qty, j.labour_minutes, j.note, j.created_at,
       case when app.can(j.company_id, 'cost.view') then j.ink_value end as ink_value,
       case when app.can(j.company_id, 'cost.view') and j.qty_printed * j.prints_per_piece > 0
            then round((j.ink_value + coalesce(j.labour_minutes / 60 * app.cost_rate(j.company_id, 'labour_hour', j.job_date), 0)) / (j.qty_printed * j.prints_per_piece), 4) end as cost_per_print
from prod.pad_print_jobs j join master.products p on p.id = j.product_id left join core.assets a on a.id = j.machine_asset_id left join core.user_profiles u on u.user_id = j.operator_user_id;

create or replace view api.material_specs with (security_invoker = true) as
select s.id, s.company_id, s.product_id, p.code as product_code, p.name as product_name, s.granule_product_id, g.code as granule_code, s.grade, s.colour,
       s.masterbatch_product_id, mb.code as masterbatch_code, s.masterbatch_pct, s.part_weight_g, s.runner_weight_g, s.cavities, s.packing_cost_per_piece, s.set_at
from prod.material_specs s join master.products p on p.id = s.product_id left join master.products g on g.id = s.granule_product_id left join master.products mb on mb.id = s.masterbatch_product_id;

-- Component cost per piece = granule (part + runner share) at weighted average, with masterbatch at its %, + packing, − scrap credit
-- (runner share at the scrap item's weighted average; zero until scrap carries a value), + mould cost per piece.
create or replace view api.component_costs with (security_invoker = true) as
select s.company_id, s.product_id, p.code as product_code, p.name as product_name, s.part_weight_g, s.runner_weight_g, s.cavities,
       round((s.part_weight_g + coalesce(s.runner_weight_g, 0) / coalesce(s.cavities, 1)) / 1000 * (1 - coalesce(s.masterbatch_pct, 0) / 100) * coalesce(app.avg_cost(s.company_id, s.granule_product_id), 0), 4) as granule_cost,
       round((s.part_weight_g + coalesce(s.runner_weight_g, 0) / coalesce(s.cavities, 1)) / 1000 * coalesce(s.masterbatch_pct, 0) / 100 * coalesce(app.avg_cost(s.company_id, s.masterbatch_product_id), 0), 4) as masterbatch_cost,
       coalesce(s.packing_cost_per_piece, 0)::numeric(18,4) as packing_cost,
       (select mc.cost_per_piece from api.mould_costs mc join prod.moulds m on m.id = mc.mould_id where m.product_id = s.product_id and m.company_id = s.company_id and m.status = 'active' limit 1) as mould_cost,
       (app.avg_cost(s.company_id, s.granule_product_id) is null) as granule_cost_missing
from prod.material_specs s join master.products p on p.id = s.product_id
where app.can(s.company_id, 'cost.view') and s.part_weight_g is not null;

create or replace view api.machine_checks with (security_invoker = true) as
select k.id, k.company_id, k.asset_id, a.code as asset_code, a.name as asset_name, k.check_date, k.shift, k.checklist, k.all_ok, k.remarks, k.checked_by, u.display_name as checked_by_name, k.created_at
from prod.machine_checks k join core.assets a on a.id = k.asset_id left join core.user_profiles u on u.user_id = k.checked_by;

-- The batch state machine (for the production flow screen).
create or replace view api.batch_states with (security_invoker = true) as
select * from (values
  (1, 'planned', 'Planned', 'plan_batch', array['reserved', 'cancelled']),
  (2, 'reserved', 'Materials reserved', 'reserve_batch_materials', array['weighed', 'cancelled']),
  (3, 'weighed', 'Weighed and issued (second-person check)', 'record_weighing / verify_weighing', array['in_process']),
  (4, 'in_process', 'In process', 'start_batch', array['sample_sent']),
  (5, 'sample_sent', 'Sample to lab', 'send_sample (bulk)', array['bulk_passed', 'bulk_failed']),
  (6, 'bulk_passed', 'Bulk passed', 'record_lab_result', array['packing']),
  (6, 'bulk_failed', 'Bulk failed', 'record_lab_result', array['rejected']),
  (7, 'packing', 'Filling and packing', 'issue_batch_packaging', array['packed_hold']),
  (8, 'packed_hold', 'Packed on hold (quarantine)', 'record_packing', array['released', 'rejected']),
  (9, 'released', 'QC released', 'qc_release_batch', array['closed']),
  (9, 'rejected', 'QC rejected', 'qc_reject_batch', array['closed']),
  (10, 'closed', 'Closed', 'close_batch', array[]::text[]),
  (0, 'cancelled', 'Cancelled', 'cancel_batch', array[]::text[])
) as t(step, status, label, rpc, next_states);

-- ─────────── Law register ───────────
update core.law_rules set status = 'built',
  enforced_in = 'app.check_licence in api.plan_batch and every production entry (reserve, weigh, check, start, bulk sample, packaging, packing) via app.lock_batch; licences in core.licences (Admin entry only)',
  test_ref = 'supabase/tests/14_production_biochem.sql'
where code = 'COS-1';

insert into core.law_rules (code, area, rule, what_erp_does, enforced_in, test_ref, status, phase, sort) values
  ('PROD-1', 'Segregation of duties', 'A batch maker cannot QC-release their own batch',
   'Everyone who planned, weighed, checked, started, issued packaging, packed or was assigned a making duty is refused at release and at assignment',
   'app.batch_makers in api.qc_release_batch, api.qc_reject_batch, api.assign_shift_duties; api.record_quality_inspection (sod.inspector_maker)', 'supabase/tests/14_production_biochem.sql', 'built', 5, 90),
  ('PROD-2', 'Production control', 'Packaging issued = good + rejected + scrapped + returned + at the line; bulk within the loss tolerance',
   'A difference raises a Bug fixer item and blocks close; tolerance setting production.bulk_loss_pct (unset = exact)', 'app.batch_recon, api.reconcile_packaging, api.close_batch',
   'supabase/tests/14_production_biochem.sql', 'built', 5, 91),
  ('GST-FREE', 'GST', 'Free items, gifts and combo packs (CBIC circular 92/11/2019, s.17(5)(h), s.8)',
   'Treatment is set per pack by Admin with the CA''s note; a pack without it cannot go on a sales document', 'prod.packs.gst_treatment, api.set_pack_gst_treatment, trigger pack_billing_guard on sales.document_lines',
   'supabase/tests/14_production_biochem.sql', 'needs_ca', 5, 92)
on conflict (code) do nothing;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';
