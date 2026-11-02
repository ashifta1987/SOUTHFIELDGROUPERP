# Test results

## Phase 0 — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint | `pnpm lint` | Pass (0 problems) |
| Types | `pnpm typecheck` | Pass (TypeScript 6, `strict`, `noUncheckedIndexedAccess`) |
| Unit tests | `pnpm test` | **30 passed** in 5 files: Indian number formatting, IST dates and FY, views from the server-set role (and ignoring a role in user-editable metadata), the 126-screen catalogue, 17 flows, sidebar order, i18n key parity, placeholder parity, `needs-native-review` flags, component behaviour (Amount, chips with word and icon, coming-in-phase buttons, Field error linking, Tabs keyboard, DataTable empty state and `th scope`, ConfirmDialog focus on Cancel) |
| Build | `pnpm build` | Pass. Warning: the main chunk is about 800 kB (233 kB gzip). Code-splitting is planned before go-live (Phase 9 performance) |
| End to end + axe | `npx playwright test` (DEV Supabase, synthetic accounts) | **11 passed**, 3 skipped (screenshot specs, run only with `REVIEW_SHOTS=1`). Covers the sign-in screens with zero serious or critical axe issues, a wrong-password message, the language switch (sets `html lang`), the redirect to sign-in, Admin Home with the "All transactions" chip, the workflow strip and empty states, sidebar → Customers with the Phase 2 controls disabled, Ctrl+K and the Help panel, a planned screen, the drawer at 834 px, and staff landing on `/staff/home` |
| pgTAP | `supabase test db` | Not applicable: Phase 0 creates no tables. Starts in Phase 1 |
| Secrets scan | grep for the secret key and DB password outside `.env*` | None found. `design-reference/`, `.env*` and the pack zip are not staged |
| Hex colours outside tokens | grep `#xxxxxx` in `src/**/*.ts(x)` | None |

### Known gaps (not failures)

- No Playwright test yet asserts **database state**, because Phase 0 writes nothing to the database. These tests start in Phase 1 with the first RPCs.
- Phone + password sign-in can't be tested end to end until the Supabase phone provider is switched on (open question Q-07).
- The low-end Android font check for Malayalam and Devanagari (§UX-9) is not yet automated.
