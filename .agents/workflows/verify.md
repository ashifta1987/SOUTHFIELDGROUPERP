---
description: Run every Southfield ERP check before a pull request and report the results honestly.
---

# /verify

Run these and report each result. Never mark a check as passing without running it.

1. `pnpm lint` and `pnpm typecheck`
2. `pnpm test` (Vitest)
3. `supabase db reset && supabase test db` (pgTAP: RLS, RPCs, idempotency, concurrency)
4. `pnpm build`
5. `pnpm e2e` (Playwright workflows, which assert database state, plus the axe checks)
6. Search the diff for these and fix any you find:
   - hard-coded hex colours outside `tokens.css`
   - `float` or `real` money columns
   - `service_role` or secret keys anywhere outside Edge Functions
   - figures or names copied from `design-reference/`
   - "Sample layout" text
   - user-facing strings that aren't in i18n
   - `console.log` calls that print personal data
7. Check that `design-reference/` and `.env*` are not staged.
8. Write the results to `docs/TEST_RESULTS.md`, with the date, commit and any failures. Fix the failures, or list them as blockers.
