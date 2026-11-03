-- 20261103009300_row_history_policy_gate.sql — Phase 9 performance, third step. Additive (one policy rewritten, same rule).
-- For a user without logs.view, row_history_read = "(select app.can(null, 'logs.view'))" is false, but Postgres applies
-- RLS quals as a per-row filter (they are never turned into a one-time gate), so api.transaction_log scanned the whole
-- audit history to return nothing (~0.8–1.3 s at 300k audit rows for an accountant). The rewrite keeps that exact
-- condition and adds a range on the NOT NULL column "at" that is always true when the right is held and empty when it
-- is not; the range is an index condition on row_history_at_idx, so a refused read stops at once (≈ 2 ms).
-- Visibility is unchanged: the original conjunct is still there, and "at <= 'infinity'" is true for every row.
-- Proved by 25_security.sql (accountant sees no audit rows; Admin sees them) and the logs pgTAP / e2e tests.

alter policy row_history_read on audit.row_history
  using ((select app.can(null, 'logs.view'))
         and at <= (case when (select app.can(null, 'logs.view')) then 'infinity'::timestamptz else '-infinity'::timestamptz end));

notify pgrst, 'reload schema';
