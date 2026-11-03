-- 20261103009200_rls_helpers_set_based.sql — Phase 9 performance, second step. Additive.
-- 20261103009100 made the read policies evaluate their rule once per statement. For Admin that brought every list
-- under 0.5 s at 50k rows; for an accountant each statement still paid ~1.4 s because app.companies_with() asked
-- app.can() once per company (each call re-reads the user's roles). These versions compute the same sets in one pass
-- over the user's roles (app.my_roles() read once per call), following app.can() / app.can_read_company() case by case:
--   'all' role for the company (or group-wide)            → every right
--   'all-readonly' role for the company (or group-wide)   → only *.view and *.export (and nothing else for that company)
--   a role holding the right for the company/group         → the right
--   otherwise an active special grant for the right        → the right
-- 25_security.sql asserts companies_with(R) = { c : app.can(c, R) } and readable_companies() = { c : app.can_read_company(c) }
-- for several users and rights, so the two can never drift apart unnoticed.

create or replace function app.companies_with(p_right text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  with r as materialized (select * from app.my_roles()),
  g as materialized (
    select g.company_id from core.special_grants g
    where g.user_id = auth.uid() and g.right_key = p_right and g.revoked_at is null
      and now() >= g.starts_at and now() < g.ends_at and (g.max_uses is null or g.uses < g.max_uses))
  select coalesce(array_agg(c.id), '{}'::uuid[]) from core.companies c
  where case
    when exists (select 1 from r where r.view_kind = 'all' and (r.company_id is null or r.company_id = c.id)) then true
    when exists (select 1 from r where r.view_kind = 'all-readonly' and (r.company_id is null or r.company_id = c.id)) then split_part(p_right, '.', 2) in ('view', 'export')
    when exists (select 1 from r join core.role_rights rr on rr.role_key = r.role_key and rr.right_key = p_right
                 where r.company_id is null or r.company_id = c.id) then true
    else exists (select 1 from g where g.company_id is null or g.company_id = c.id)
  end
$$;

create or replace function app.companies_with_any(p_rights text[]) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x), '{}'::uuid[]) from unnest(p_rights) r, unnest(app.companies_with(r)) x
$$;

create or replace function app.readable_companies() returns uuid[]
language sql stable security definer set search_path = '' as $$
  with r as materialized (select * from app.my_roles())
  select coalesce(array_agg(c.id), '{}'::uuid[]) from core.companies c
  where exists (select 1 from r where r.role_key <> 'investor' and (r.company_id is null or r.company_id = c.id))
$$;

-- Stock movements: the cost columns asked app.can(company, 'cost.view') twice per row; the same rule, once per statement.
create or replace view api.stock_movements with (security_invoker = true) as
select m.id, m.company_id, m.move_date, m.created_at, m.doc_no, m.move_type, m.product_id, p.code as product_code, p.name as product_name, p.uom,
       m.lot_id, l.lot_no, m.place_id, pl.name as place_name, m.bucket, m.qty,
       case when m.company_id = any ((select app.companies_with('cost.view'))::uuid[]) then m.unit_cost else null::numeric end as unit_cost,
       case when m.company_id = any ((select app.companies_with('cost.view'))::uuid[]) then m.value else null::numeric end as value,
       m.source_table, m.source_id, m.note, (m.negative_allowance_id is not null) as negative_allowed, m.created_by, u.display_name as created_by_name
from inv.stock_ledger m
join master.products p on p.id = m.product_id
join core.places pl on pl.id = m.place_id
left join inv.lots l on l.id = m.lot_id
left join core.user_profiles u on u.user_id = m.created_by;
grant select on api.stock_movements to authenticated;

revoke all on function app.companies_with(text), app.companies_with_any(text[]), app.readable_companies() from public, anon;
grant execute on function app.companies_with(text), app.companies_with_any(text[]), app.readable_companies() to authenticated;

notify pgrst, 'reload schema';
