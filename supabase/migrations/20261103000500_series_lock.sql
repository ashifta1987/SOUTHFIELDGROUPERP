-- 20261103000500_series_lock.sql
-- Numbering: show how many numbers were issued (so the screen can say "Locked"), and refuse a GST series whose
-- numbers would be longer than the document's limit at save time, not only when a number is taken. Additive.
create or replace view api.doc_series with (security_invoker = true) as
select s.id, s.company_id, c.short_name as company_name, s.gstin_id, g.gstin, s.doc_type, t.label as doc_type_label, s.fy_id, f.label as fy_label,
       s.prefix, s.pad, s.next_no, s.status,
       s.prefix || '/' || substr(f.label, 3, 2) || '-' || substr(f.label, 6, 2) || '/' || lpad(s.next_no::text, s.pad, '0') as next_number,
       length(s.prefix || '/' || substr(f.label, 3, 2) || '-' || substr(f.label, 6, 2) || '/' || lpad(s.next_no::text, s.pad, '0')) <= t.max_number_length as fits_limit,
       (select count(*) from core.doc_numbers_issued i where i.series_id = s.id)::int as issued_count
from core.doc_series s
join core.companies c on c.id = s.company_id
join core.doc_types t on t.key = s.doc_type
join core.financial_years f on f.id = s.fy_id
left join core.gstins g on g.id = s.gstin_id;
grant select on api.doc_series to authenticated;

-- doc_numbers_issued has no client policy; count it through a definer helper used by the view's owner path.
-- (The view is security_invoker, so expose the count via a stable definer function instead.)
create or replace function app.series_issued_count(p_series uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from core.doc_numbers_issued where series_id = p_series
$$;
grant execute on function app.series_issued_count(uuid) to authenticated;

create or replace view api.doc_series with (security_invoker = true) as
select s.id, s.company_id, c.short_name as company_name, s.gstin_id, g.gstin, s.doc_type, t.label as doc_type_label, s.fy_id, f.label as fy_label,
       s.prefix, s.pad, s.next_no, s.status,
       s.prefix || '/' || substr(f.label, 3, 2) || '-' || substr(f.label, 6, 2) || '/' || lpad(s.next_no::text, s.pad, '0') as next_number,
       length(s.prefix || '/' || substr(f.label, 3, 2) || '-' || substr(f.label, 6, 2) || '/' || lpad(s.next_no::text, s.pad, '0')) <= t.max_number_length as fits_limit,
       app.series_issued_count(s.id) as issued_count
from core.doc_series s
join core.companies c on c.id = s.company_id
join core.doc_types t on t.key = s.doc_type
join core.financial_years f on f.id = s.fy_id
left join core.gstins g on g.id = s.gstin_id;

create or replace function app.check_series_length() returns trigger
language plpgsql set search_path = '' as $$
declare v_label text; v_max int; v_gst boolean; v_len int;
begin
  select label into v_label from core.financial_years where id = new.fy_id;
  select max_number_length, gst_document into v_max, v_gst from core.doc_types where key = new.doc_type;
  v_len := length(new.prefix || '/' || substr(v_label, 3, 2) || '-' || substr(v_label, 6, 2) || '/' || lpad(new.next_no::text, new.pad, '0'));
  if v_gst and v_len > v_max then
    raise exception 'number_too_long: numbers in this series would be % characters; the limit is %', v_len, v_max using errcode = '22023', hint = 'numbering.too_long';
  end if;
  return new;
end $$;
create trigger doc_series_length before insert or update on core.doc_series for each row execute function app.check_series_length();
