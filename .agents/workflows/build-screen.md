---
description: Build one Southfield ERP screen from its approved reference and connect it to live data.
---

# /build-screen <ScreenName>

1. Find the screen's row in `docs/design/PAGE_INVENTORY.md` (route, device, role, workflows). Open `design-reference/screens/<ScreenName>.jpg` and `design-reference/html/<ScreenName>.html`.
2. List the parts of the screen and map each one to a shared component in `src/ui`. Add a missing component to `src/ui`, never as a one-off.
3. Build the page from the reference's structure, spacing and wording. Figures are masked as `X`, and every value comes from Supabase. **Never hard-code numbers, names or IDs from the reference.**
4. Wire it to data:
   - TanStack Query reads from `api` views.
   - Writes go through RPCs.
   - No calculations happen in the component.
   - Show the server's result after a posting.
5. Add every state: loading, empty, error (with `ErrorRef` and Ask Help), no access, read-only, locked period, offline (phone), and coming in phase N.
6. Apply rights and the view. Hide what the user isn't allowed to use, show who to ask, and rely on RLS for the data itself.
7. Put every visible string in i18n (`en`, `ml`, `hi`, `bho`). Write `docs/help/<ScreenName>.md`: purpose, steps, common errors with rule codes, and who to ask.
8. Write the tests:
   - a Playwright test of the main task that asserts the database rows
   - an axe check
   - a visual snapshot at the reference width
9. Compare your screenshot with the reference side by side and fix any differences. Note anything you can't fix in `IMPLEMENTATION_STATUS.md`.
10. Fill in the screen's row in `docs/MODULE_INVENTORY.md`: route, component, views, RPCs, state and tests.
