-- 20261103006400_gst_schedule3.sql
-- Phase 6 GST page and Schedule III statements. GSTR-1 style summaries (B2B, B2C small/large, exports, credit/debit notes,
-- HSN summary, nil/exempt/non-GST, documents issued) and the GSTR-3B summary (outward, zero-rated, nil/exempt, non-GST,
-- inward reverse charge, ITC available/ineligible) are built only from posted documents. Admin and the CA see every supply
-- (bills without GST in their own sections, §WA/§6); other users get GST documents only, and the without-GST sections are absent.
-- Schedule III balance sheet and P&L come from the GL through an account-group → line mapping that Admin sets and the CA confirms.
-- Read-only functions; definer with an explicit rights check. Additive.

create or replace function app.gst_reader(p_company uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (app.can(p_company, 'gst.view') or app.can(p_company, 'reports.view')) then perform app.raise_rule('rights.missing', 'needs the GST page right', '42501'); end if;
  return app.current_view() in ('all', 'all-readonly');
end $$;

-- Posted and cancelled GST documents of a period as the reader may see them.
create or replace function app.gst_docs(p_company uuid, p_gstin uuid, p_from date, p_to date, p_all boolean)
returns table (id uuid, doc_type text, doc_no text, doc_date date, party_gstin text, party_name text, pos text, our_state text, tax_class text, lawful_reason text, status text,
               taxable numeric, cgst numeric, sgst numeric, igst numeric, total numeric)
language sql stable security definer set search_path = '' as $$
  select d.id, d.doc_type, d.doc_no, d.doc_date, p.gstin::text, p.legal_name, d.place_of_supply::text, g.state_code::text, d.tax_class, d.lawful_reason, d.status,
         d.taxable, d.cgst, d.sgst, d.igst, d.total
  from sales.documents d join core.gstins g on g.id = d.gstin_id left join master.parties p on p.id = d.party_id
  where d.company_id = p_company and (p_gstin is null or d.gstin_id = p_gstin) and d.doc_date between p_from and p_to and d.status in ('posted', 'cancelled')
    and d.doc_no is not null and (p_all or d.tax_class = 'taxable')
$$;

-- p_gstin_id null = every GSTIN of the company.
create or replace function api.gstr1_summary(p_company_id uuid, p_gstin_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_all boolean := app.gst_reader(p_company_id); v_b2cl numeric := (app.setting(p_company_id, 'gst.b2cl_invoice_value', p_to))::text::numeric; r jsonb := '{}'::jsonb;
begin
  r := r || jsonb_build_object('b2b', (select coalesce(jsonb_agg(x order by x ->> 'party_gstin'), '[]'::jsonb) from (
      select jsonb_build_object('party_gstin', party_gstin, 'party_name', max(party_name), 'invoices', count(*), 'taxable', sum(taxable), 'cgst', sum(cgst), 'sgst', sum(sgst),
                                'igst', sum(igst), 'total', sum(total)) as x
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) where status = 'posted' and doc_type = 'sales_invoice' and tax_class = 'taxable' and party_gstin is not null and pos <> '96' group by party_gstin) s));
  r := r || jsonb_build_object('b2cl', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', doc_no, 'doc_date', doc_date, 'pos', pos, 'taxable', taxable, 'igst', igst, 'total', total) order by doc_no), '[]'::jsonb)
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) where v_b2cl is not null and status = 'posted' and doc_type = 'sales_invoice' and tax_class = 'taxable' and party_gstin is null and pos <> our_state and pos <> '96' and total > v_b2cl));
  r := r || jsonb_build_object('b2cs', (select coalesce(jsonb_agg(x order by x ->> 'pos', (x ->> 'rate')::numeric), '[]'::jsonb) from (
      select jsonb_build_object('pos', d.pos, 'rate', l.gst_rate, 'taxable', sum(l.taxable), 'cgst', sum(l.cgst), 'sgst', sum(l.sgst), 'igst', sum(l.igst)) as x
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) d join sales.document_lines l on l.document_id = d.id
      where d.status = 'posted' and d.doc_type = 'sales_invoice' and d.tax_class = 'taxable' and d.party_gstin is null and d.pos <> '96'
        and not (v_b2cl is not null and d.pos <> d.our_state and d.total > v_b2cl)
      group by d.pos, l.gst_rate) s));
  r := r || jsonb_build_object('exp', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', d.doc_no, 'doc_date', d.doc_date, 'with_payment', d.tax_class = 'taxable', 'taxable', d.taxable,
        'igst', d.igst, 'total', d.total, 'shipping_bill_no', e.shipping_bill_no, 'shipping_bill_date', e.shipping_bill_date, 'port_code', e.port_code) order by d.doc_no), '[]'::jsonb)
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) d left join sales.export_invoices e on e.document_id = d.id
      where d.status = 'posted' and d.doc_type = 'sales_invoice' and (d.pos = '96' or d.lawful_reason = 'export_lut')));
  r := r || jsonb_build_object('cdnr', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', doc_no, 'doc_date', doc_date, 'party_gstin', party_gstin, 'taxable', taxable, 'cgst', cgst,
        'sgst', sgst, 'igst', igst, 'total', total) order by doc_no), '[]'::jsonb)
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) where status = 'posted' and doc_type = 'credit_note' and tax_class = 'taxable' and party_gstin is not null));
  r := r || jsonb_build_object('cdnur', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', doc_no, 'doc_date', doc_date, 'pos', pos, 'taxable', taxable, 'cgst', cgst,
        'sgst', sgst, 'igst', igst, 'total', total) order by doc_no), '[]'::jsonb)
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) where status = 'posted' and doc_type = 'credit_note' and tax_class = 'taxable' and party_gstin is null));
  -- HSN summary: invoices and bills of supply add, credit notes subtract.
  r := r || jsonb_build_object('hsn', (select coalesce(jsonb_agg(x order by x ->> 'hsn_code', (x ->> 'rate')::numeric), '[]'::jsonb) from (
      select jsonb_build_object('hsn_code', l.hsn_code, 'uom', l.uom, 'rate', l.gst_rate,
               'qty', sum(case when d.doc_type = 'credit_note' then -l.qty else l.qty end), 'taxable', sum(case when d.doc_type = 'credit_note' then -l.taxable else l.taxable end),
               'cgst', sum(case when d.doc_type = 'credit_note' then -l.cgst else l.cgst end), 'sgst', sum(case when d.doc_type = 'credit_note' then -l.sgst else l.sgst end),
               'igst', sum(case when d.doc_type = 'credit_note' then -l.igst else l.igst end), 'total', sum(case when d.doc_type = 'credit_note' then -l.total else l.total end)) as x
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) d join sales.document_lines l on l.document_id = d.id
      where d.status = 'posted' and d.doc_type in ('sales_invoice', 'bill_of_supply', 'credit_note')
      group by l.hsn_code, l.uom, l.gst_rate) s));
  -- Table 8 (nil-rated, exempt, non-GST) — every supply is in the returns workings; shown only to Admin and the CA.
  if v_all then
    r := r || jsonb_build_object('nil_exempt_non_gst', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select jsonb_build_object('lawful_reason', lawful_reason, 'inter_state', pos <> our_state, 'registered', party_gstin is not null, 'documents', count(*), 'value', sum(total)) as x
        from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) where status = 'posted' and doc_type in ('sales_invoice', 'bill_of_supply') and tax_class = 'without_gst' and lawful_reason in ('exempt_or_nil', 'non_gst')
        group by lawful_reason, pos <> our_state, party_gstin is not null) s));
  end if;
  -- Table 13: documents issued per type and series.
  r := r || jsonb_build_object('docs', (select coalesce(jsonb_agg(x order by x ->> 'doc_type', x ->> 'series'), '[]'::jsonb) from (
      select jsonb_build_object('doc_type', doc_type, 'series', regexp_replace(doc_no, '[0-9]+$', ''), 'from_no', min(doc_no), 'to_no', max(doc_no), 'issued', count(*),
                                'cancelled', count(*) filter (where status = 'cancelled')) as x
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) group by doc_type, regexp_replace(doc_no, '[0-9]+$', '')) s));
  r := r || jsonb_build_object('totals', (select jsonb_build_object(
      'taxable', coalesce(sum(case when doc_type = 'credit_note' then -taxable else taxable end), 0),
      'cgst', coalesce(sum(case when doc_type = 'credit_note' then -cgst else cgst end), 0), 'sgst', coalesce(sum(case when doc_type = 'credit_note' then -sgst else sgst end), 0),
      'igst', coalesce(sum(case when doc_type = 'credit_note' then -igst else igst end), 0), 'total', coalesce(sum(case when doc_type = 'credit_note' then -total else total end), 0))
      from app.gst_docs(p_company_id, p_gstin_id, p_from, p_to, v_all) where status = 'posted' and doc_type in ('sales_invoice', 'bill_of_supply', 'credit_note')));
  return r || jsonb_build_object('company_id', p_company_id, 'gstin_id', p_gstin_id, 'from', p_from, 'to', p_to, 'all_supplies', v_all, 'b2cl_threshold_set', v_b2cl is not null);
end $$;

create or replace function api.gstr3b_summary(p_company_id uuid, p_gstin_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_all boolean := app.gst_reader(p_company_id); r jsonb;
begin
  with d as (
    select x.*, case when x.doc_type = 'credit_note' then -1 else 1 end as sg from sales.documents x
    where x.company_id = p_company_id and (p_gstin_id is null or x.gstin_id = p_gstin_id) and x.doc_date between p_from and p_to and x.status = 'posted'
      and x.doc_type in ('sales_invoice', 'bill_of_supply', 'credit_note')),
  b as (select * from purch.bills y where y.company_id = p_company_id and (p_gstin_id is null or y.gstin_id = p_gstin_id) and y.bill_date between p_from and p_to and y.status = 'posted')
  select jsonb_build_object(
    'outward_taxable', (select jsonb_build_object('taxable', coalesce(sum(sg * taxable), 0), 'igst', coalesce(sum(sg * igst), 0), 'cgst', coalesce(sum(sg * cgst), 0), 'sgst', coalesce(sum(sg * sgst), 0))
                        from d where tax_class = 'taxable' and place_of_supply <> '96'),
    'outward_zero_rated', (select jsonb_build_object('taxable', coalesce(sum(sg * taxable), 0), 'igst', coalesce(sum(sg * igst), 0))
                           from d where (place_of_supply = '96' or lawful_reason = 'export_lut') and (v_all or tax_class = 'taxable')),
    'outward_nil_exempt', case when v_all then (select jsonb_build_object('value', coalesce(sum(sg * total), 0)) from d where tax_class = 'without_gst' and lawful_reason = 'exempt_or_nil') end,
    'outward_non_gst', case when v_all then (select jsonb_build_object('value', coalesce(sum(sg * total), 0)) from d where tax_class = 'without_gst' and lawful_reason = 'non_gst') end,
    'inward_reverse_charge', (select jsonb_build_object('taxable', coalesce(sum(taxable), 0), 'igst', coalesce(sum(igst), 0), 'cgst', coalesce(sum(cgst), 0), 'sgst', coalesce(sum(sgst), 0))
                              from b where reverse_charge),
    'itc_available', (select jsonb_build_object('igst', coalesce(sum(igst), 0), 'cgst', coalesce(sum(cgst), 0), 'sgst', coalesce(sum(sgst), 0), 'bills', count(*)) from b where itc_eligible),
    'itc_ineligible', (select jsonb_build_object('igst', coalesce(sum(igst), 0), 'cgst', coalesce(sum(cgst), 0), 'sgst', coalesce(sum(sgst), 0), 'bills', count(*)) from b where not itc_eligible))
  into r;
  r := r || jsonb_build_object('output_tax', jsonb_build_object(
             'igst', (r #>> '{outward_taxable,igst}')::numeric + (r #>> '{outward_zero_rated,igst}')::numeric + (r #>> '{inward_reverse_charge,igst}')::numeric,
             'cgst', (r #>> '{outward_taxable,cgst}')::numeric + (r #>> '{inward_reverse_charge,cgst}')::numeric,
             'sgst', (r #>> '{outward_taxable,sgst}')::numeric + (r #>> '{inward_reverse_charge,sgst}')::numeric));
  r := r || jsonb_build_object('net_before_setoff', jsonb_build_object(
             'igst', (r #>> '{output_tax,igst}')::numeric - (r #>> '{itc_available,igst}')::numeric,
             'cgst', (r #>> '{output_tax,cgst}')::numeric - (r #>> '{itc_available,cgst}')::numeric,
             'sgst', (r #>> '{output_tax,sgst}')::numeric - (r #>> '{itc_available,sgst}')::numeric));
  return r || jsonb_build_object('company_id', p_company_id, 'gstin_id', p_gstin_id, 'from', p_from, 'to', p_to, 'all_supplies', v_all,
                                 'note', 'cross-utilisation and set-off order are applied by the CA');
end $$;

-- ITC register from posted purchase bills (GSTR-2B matching waits for the GSP, Phase 8: status await_2b).
create or replace function api.itc_register(p_company_id uuid, p_from date, p_to date) returns table (bill_id uuid, gstin_id uuid, supplier text, supplier_gstin text, supplier_bill_no text,
  supplier_bill_date date, bill_date date, taxable numeric, cgst numeric, sgst numeric, igst numeric, itc numeric, itc_eligible boolean, reverse_charge boolean, match_status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.gst_reader(p_company_id);
  return query
  select b.id, b.gstin_id, p.legal_name, p.gstin::text, b.supplier_bill_no, b.supplier_bill_date, b.bill_date, b.taxable, b.cgst, b.sgst, b.igst,
         case when b.itc_eligible then b.cgst + b.sgst + b.igst else 0 end, b.itc_eligible, b.reverse_charge, 'await_2b'::text
  from purch.bills b join master.parties p on p.id = b.party_id
  where b.company_id = p_company_id and b.status = 'posted' and b.bill_date between p_from and p_to
  order by b.bill_date, b.supplier_bill_no;
end $$;

-- ─────────── Schedule III ───────────
create or replace function api.set_schedule3_map(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_schedule3_map'); if v_prev is not null then return v_prev; end if;
  select company_id into v_company from acct.account_groups where id = (p ->> 'account_group_id')::uuid;
  if v_company is null then perform app.raise_rule('schedule3.group', 'account group not found', 'P0002'); end if;
  perform app.require(v_company, 'settings.manage');
  if not exists (select 1 from acct.schedule3_lines where code = p ->> 'line_code') then perform app.raise_rule('schedule3.line', 'unknown Schedule III line', '22023'); end if;
  insert into acct.schedule3_map (account_group_id, company_id, line_code, set_by) values ((p ->> 'account_group_id')::uuid, v_company, p ->> 'line_code', auth.uid())
  on conflict (account_group_id) do update set line_code = excluded.line_code, set_by = excluded.set_by, set_at = now(), ca_confirmed = false, confirmed_by = null, confirmed_at = null;
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_schedule3_map', v_res);
end $$;

-- Records that the CA confirmed the current mapping (the CA's own login is read-only, so Admin records it with the CA's note; Q-P6-4).
create or replace function api.confirm_schedule3_map(p_client_request_id uuid, p_company_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; n int; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'confirm_schedule3_map'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'settings.manage');
  if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'note who confirmed it and how', '22023'); end if;
  update acct.schedule3_map set ca_confirmed = true, ca_note = p_note, confirmed_by = auth.uid(), confirmed_at = now() where company_id = p_company_id;
  get diagnostics n = row_count;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'schedule3_map', 'company_id', p_company_id, 'note', p_note));
  v_res := jsonb_build_object('confirmed', n);
  return app.request_done(p_client_request_id, 'confirm_schedule3_map', v_res);
end $$;

-- Per account: opening, movement before the period, in the period, and to date, with its Schedule III line (nearest mapped ancestor group).
create or replace function app.s3_balances(p_company uuid, p_from date, p_to date, p_all boolean)
returns table (account_id uuid, group_id uuid, nature text, line_code text, opening numeric, before_from numeric, in_period numeric, to_date numeric)
language sql stable security definer set search_path = '' as $$
  with recursive chain as (
    select g.id as group_id, g.id as anc, 0 as depth from acct.account_groups g where g.company_id = p_company
    union all
    select c.group_id, g.parent_id, c.depth + 1 from chain c join acct.account_groups g on g.id = c.anc where g.parent_id is not null and c.depth < 20),
  mapped as (
    select distinct on (c.group_id) c.group_id, m.line_code from chain c join acct.schedule3_map m on m.account_group_id = c.anc order by c.group_id, c.depth),
  b as (
    select a.id, a.group_id, g.nature, mp.line_code,
           case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end as opening,
           coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.account_id = a.id and e.entry_date < p_from and (p_all or e.tax_class not in ('without_gst', 'unclassified'))), 0) as before_from,
           coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.account_id = a.id and e.entry_date between p_from and p_to and (p_all or e.tax_class not in ('without_gst', 'unclassified'))), 0) as in_period
    from acct.accounts a join acct.account_groups g on g.id = a.group_id left join mapped mp on mp.group_id = a.group_id
    where a.company_id = p_company)
  select id, group_id, nature, line_code, opening, before_from, in_period, opening + before_from + in_period from b
$$;

-- Balance sheet (closing balances at p_to) and statement of profit and loss (p_from–p_to). Profit of earlier periods and of
-- this period goes to reserves and surplus. Unmapped groups are listed and shown on their natural side, so the sheet still balances.
-- Admin/CA: every GL entry; others: GL entries of GST transactions only.
create or replace function api.schedule3_statements(p_company_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_all boolean; v_profit numeric; v_prior numeric; v_bs jsonb; v_pl jsonb; v_unmapped jsonb; v_assets numeric; v_el numeric; v_confirmed boolean;
begin
  if not (app.can(p_company_id, 'reports.view') or app.can(p_company_id, 'accounts.view')) then perform app.raise_rule('rights.missing', 'needs the reports right', '42501'); end if;
  v_all := app.current_view() in ('all', 'all-readonly');
  select -coalesce(sum(in_period), 0) into v_profit from app.s3_balances(p_company_id, p_from, p_to, v_all) where nature in ('income', 'expense');
  select -coalesce(sum(opening + before_from), 0) into v_prior from app.s3_balances(p_company_id, p_from, p_to, v_all) where nature in ('income', 'expense');
  -- Balance sheet lines (assets: debit balance; equity and liabilities: credit balance).
  select coalesce(jsonb_agg(jsonb_build_object('side', s.side, 'section', s.section, 'code', s.code, 'label', s.label, 'amount', s.amount) order by s.sort), '[]'::jsonb),
         coalesce(sum(s.amount) filter (where s.side = 'assets'), 0), coalesce(sum(s.amount) filter (where s.side = 'equity_liabilities'), 0)
    into v_bs, v_assets, v_el
  from (
    select l.side, l.section, l.code, l.label, l.sort,
           case when l.side = 'assets' then coalesce(sum(b.to_date), 0) else -coalesce(sum(b.to_date), 0) end
           + case when l.code = 'reserves_surplus' then v_profit + v_prior else 0 end as amount
    from acct.schedule3_lines l left join app.s3_balances(p_company_id, p_from, p_to, v_all) b on b.line_code = l.code and b.nature in ('asset', 'liability', 'equity')
    where l.statement = 'bs' group by l.side, l.section, l.code, l.label, l.sort
    union all
    select 'assets', 'Not yet mapped', 'unmapped_assets', 'Assets in groups not yet mapped', 900, coalesce(sum(to_date), 0) from app.s3_balances(p_company_id, p_from, p_to, v_all) where line_code is null and nature = 'asset'
    union all
    select 'equity_liabilities', 'Not yet mapped', 'unmapped_liabilities', 'Liabilities and equity in groups not yet mapped', 901, -coalesce(sum(to_date), 0)
    from app.s3_balances(p_company_id, p_from, p_to, v_all) where line_code is null and nature in ('liability', 'equity')
    union all
    -- balances of P&L-nature accounts mapped to balance-sheet lines (or the reverse) are kept on their natural side
    select 'equity_liabilities', 'Not yet mapped', 'misclassified', 'Groups mapped to the other statement', 902,
           -coalesce(sum(b.to_date), 0) from app.s3_balances(p_company_id, p_from, p_to, v_all) b join acct.schedule3_lines l on l.code = b.line_code where l.statement = 'pl' and b.nature in ('asset', 'liability', 'equity')) s;
  -- Statement of profit and loss (income: credit positive; expenses: debit positive).
  select coalesce(jsonb_agg(jsonb_build_object('section', s.section, 'code', s.code, 'label', s.label, 'amount', s.amount) order by s.sort), '[]'::jsonb) into v_pl
  from (
    select l.section, l.code, l.label, l.sort, case when l.section = 'Income' then -coalesce(sum(b.in_period), 0) else coalesce(sum(b.in_period), 0) end as amount
    from acct.schedule3_lines l left join app.s3_balances(p_company_id, p_from, p_to, v_all) b on b.line_code = l.code and b.nature in ('income', 'expense')
    where l.statement = 'pl' group by l.section, l.code, l.label, l.sort
    union all
    select 'Income', 'unmapped_income', 'Income in groups not yet mapped', 900, -coalesce(sum(in_period), 0) from app.s3_balances(p_company_id, p_from, p_to, v_all) where line_code is null and nature = 'income'
    union all
    select 'Expenses', 'unmapped_expense', 'Expenses in groups not yet mapped', 901, coalesce(sum(in_period), 0) from app.s3_balances(p_company_id, p_from, p_to, v_all) where line_code is null and nature = 'expense'
    union all
    select 'Expenses', 'misclassified_pl', 'P&L groups mapped to balance-sheet lines', 902, coalesce(sum(b.in_period), 0)
    from app.s3_balances(p_company_id, p_from, p_to, v_all) b join acct.schedule3_lines l on l.code = b.line_code where l.statement = 'bs' and b.nature in ('income', 'expense')) s;
  select coalesce(jsonb_agg(jsonb_build_object('group_id', g.id, 'group', g.name, 'nature', g.nature, 'balance', x.bal) order by g.name), '[]'::jsonb) into v_unmapped
  from (select group_id, sum(to_date) as bal from app.s3_balances(p_company_id, p_from, p_to, v_all) where line_code is null group by group_id) x join acct.account_groups g on g.id = x.group_id;
  select coalesce(bool_and(ca_confirmed), false) into v_confirmed from acct.schedule3_map where company_id = p_company_id;
  return jsonb_build_object('company_id', p_company_id, 'from', p_from, 'to', p_to, 'all_transactions', v_all, 'balance_sheet', v_bs, 'profit_and_loss', v_pl,
    'profit_for_period', v_profit, 'profit_brought_forward', v_prior, 'unmapped_groups', v_unmapped, 'mapping_confirmed_by_ca', v_confirmed,
    'totals', jsonb_build_object('assets', v_assets, 'equity_liabilities', v_el, 'difference', v_assets - v_el), 'status', 'draft · before audit');
end $$;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';
