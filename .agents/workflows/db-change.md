---
description: Make a safe Supabase database change for Southfield ERP — migration, RLS, RPC, tests, types.
---

# /db-change

1. Write down what is changing and why in `docs/DATABASE_SCHEMA.md`. Say whether the change is additive or destructive.
2. If it is destructive (drop, a rename that moves data, a type change, a backfill on a large table), write a migration plan with a rollback and **stop for the owner's approval**.
3. Create `supabase/migrations/<timestamp>_<purpose>.sql`. It must:
   - add a header comment saying what it does
   - enable RLS and add policies on every new table
   - add indexes for every column a policy or foreign key filters on
   - add the history trigger
   - block update and delete on ledger tables
4. For RPCs: `security definer`, `set search_path = ''`, rights and state checks, row locks, an idempotency key, a single transaction, and writes to history and the outbox.
5. Run `supabase db reset`, then `supabase test db`. Add pgTAP tests covering:
   - RLS for each role and view
   - the RPC's success and refusal cases
   - idempotency
   - concurrency, where stock or numbering is involved
6. Regenerate the types with `supabase gen types typescript --local > src/shared/database.types.ts`, then run the typecheck.
7. Open a PR. CI applies the change to dev only. Prod is applied later from the approved GitHub environment, never from this session.
