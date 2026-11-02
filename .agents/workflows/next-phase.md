---
description: Plan, build, test and report the next build phase of Southfield ERP, then stop for review.
---

# /next-phase

1. Read `docs/IMPLEMENTATION_STATUS.md` to find the next phase, then read that phase in Part 1 §28 of `docs/prompts/SOUTHFIELD_ERP_PROMPT.md`. Also read its acceptance checks in `docs/spec/SOUTHFIELD_ERP_SPEC.md` (Part I) and its rows in §WA-9 and §HELP-9 of the same prompt.
2. List the screens in this phase from `docs/design/PAGE_INVENTORY.md`, and the workflows they belong to from `docs/design/WORKFLOWS.md`.
3. Write the data contracts first, in `docs/DATABASE_SCHEMA.md`:
   - tables and columns
   - state machines (allowed transitions)
   - RPC signatures with their checks
   - RLS rules per role and view
   - events that write to `msg.outbox`
4. Show the plan as a task list. Include the slice order and any open questions for the owner or the CA. Wait for approval if a question blocks the work.
5. Build in small slices. Each slice gets its own migration, RPCs, pgTAP tests, UI screens (using `/build-screen`), help pages in `docs/help/`, and a Playwright test of the workflow step.
6. Run `/verify` after each slice and fix everything it reports before moving on.
7. When the phase is complete:
   - Update `IMPLEMENTATION_STATUS.md`, `MODULE_INVENTORY.md`, `ROLE_PERMISSION_MATRIX.md`, `LAW_RULES.md` and `TEST_RESULTS.md`.
   - Save before-and-after screenshots with no real data in `docs/review/phase-N/`.
8. Report:
   - what works end to end
   - tests and their results
   - database changes
   - gaps
   - open questions
9. **Stop.** Do not start the next phase until the owner says so.
