-- 20261109063526_index_unindexed_foreign_keys.sql
-- Applied directly on the remote database (Supabase dashboard / advisor) on 09-11-2026; pulled into the repo so the migration history matches.

do $$
declare r record; idx text;
begin
  for r in
    select con.conname, c.oid relid, n.nspname sch, c.relname tbl,
           string_agg(quote_ident(a.attname), ', ' order by k.ord) cols,
           string_agg(a.attname, '_' order by k.ord) colnames
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral unnest(con.conkey) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
    where con.contype = 'f'
      and n.nspname not in ('pg_catalog','information_schema','auth','storage','realtime','supabase_functions','extensions','graphql','graphql_public','vault','pgsodium','net','cron','supabase_migrations','pgbouncer','_realtime','_analytics')
      and not exists (select 1 from pg_index i where i.indrelid = con.conrelid
                      and (i.indkey::int2[])[0:array_length(con.conkey,1)-1] @> con.conkey)
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
    group by con.conname, c.oid, n.nspname, c.relname
  loop
    idx := left(r.tbl || '_' || r.colnames, 52) || '_fk_' || left(md5(r.conname || r.relid::text), 6);
    execute format('create index if not exists %I on %I.%I (%s)', idx, r.sch, r.tbl, r.cols);
  end loop;
end $$;
