-- 20261103012300_import_row_types.sql
-- Tally import, Stage 1: the staged master kinds the first files did not carry. 'payhead', 'employee_group' and 'attendance_type' are kept as
-- staged reference rows only (not posted in Stage 1).
alter table ops.import_rows drop constraint import_rows_object_type_check;
alter table ops.import_rows add constraint import_rows_object_type_check check (object_type = any (array[
  'group', 'ledger', 'stock_group', 'stock_item', 'unit', 'godown', 'cost_centre', 'employee', 'voucher', 'opening_bill',
  'voucher_type', 'cost_category', 'currency', 'stock_category', 'payhead', 'employee_group', 'attendance_type']));
