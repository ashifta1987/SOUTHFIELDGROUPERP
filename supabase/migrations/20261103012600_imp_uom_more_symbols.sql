-- 20261103012600_imp_uom_more_symbols.sql
-- Two more unambiguous unit spellings seen in the owner's day book: "Pkts" (packs) and "Mtrs" (metres). "MT" stays unmapped
-- (metre or metric tonne): Admin chooses it in the Mapping screen.
do $$
declare
  v_def text; v_new text;
  v_a constant text := $q$when 'pkt' then 'PAC'$q$;
  v_b constant text := $q$when 'mtr' then 'MTR'$q$;
begin
  v_def := pg_get_functiondef('app.imp_uom(text)'::regprocedure);
  if length(v_def) - length(replace(v_def, v_a, '')) <> length(v_a) or length(v_def) - length(replace(v_def, v_b, '')) <> length(v_b) then
    raise exception 'imp_uom patch: anchors not found exactly once';
  end if;
  v_new := replace(v_def, v_a, v_a || $q$ when 'pkts' then 'PAC'$q$);
  v_new := replace(v_new, v_b, v_b || $q$ when 'mtrs' then 'MTR'$q$);
  execute v_new;
end $$;
