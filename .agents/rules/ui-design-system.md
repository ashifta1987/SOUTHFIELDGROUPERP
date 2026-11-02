---
trigger: glob
globs: src/**/*.tsx, src/**/*.ts, src/**/*.css
description: Southfield UI rules. These apply to every React component, style and page.
---

# Southfield UI rules

The full rules are in Part 2 of `docs/prompts/SOUTHFIELD_ERP_PROMPT.md` (§UX-1 to §UX-14).

## Look

- **Match the reference.** Use `design-reference/screens/<Name>.jpg` and `design-reference/html/<Name>.html` for every screen. Figures there are masked as `X`. Find each screen's route and role in `docs/design/PAGE_INVENTORY.md`.
- **Tokens only.** Take colours, sizes and spacing from `docs/design/tokens.css` (`var(--sf-…)`). No raw hex values in components.
- **Colour rules:**
  - Amber `--sf-signal` is a fill or border only, never text on white.
  - Status shows as a tint with dark ink of the same hue, plus a word and an icon. Colour is never the only signal.
- **Fonts:**
  - IBM Plex Sans for text.
  - IBM Plex Mono for amounts, document numbers, GSTINs, batch codes and vehicle numbers.
  - Noto Sans Malayalam and Devanagari as fallbacks.
- **Type sizes:** page title 28/700, card title 16/600, body 14/1.45, table 13, table header 12/600 muted.
- **Shape:** cards with 8 px radius and a 1 px `--sf-line` border; inputs and buttons with 6 px radius; chips at 999 px. No heavy shadows, gradients or emoji.
- **Sidebar:** the groups and items keep the exact order given in §UX-4.1 of the prompt. Menu items appear only when the user's rights allow them.
- **Top bar, left to right:** company/GSTIN switcher, FY, scope, search (Ctrl K), Help, notifications, user with view chip.
- **Workflow strip:** under the top bar, driven by `src/app/flows.ts`.

## Behaviour

- **Server-side calculations only.** Totals, tax, stock, pay and costs come from Postgres RPCs or views. The browser only formats them.
- **No client-side filtering of bills without GST.** Row-level security decides which rows arrive. Counts, totals, paging and exports are computed on the server.
- **Amounts** use `Intl.NumberFormat('en-IN')`, are right-aligned in mono, and show negatives with a minus sign in red ink. Dates are DD-MM-YYYY and FY is "2026-27".
- **Every screen has these states:** loading (skeleton), empty (why it's empty plus the next action), error (message, next step and an `ErrorRef` with Ask Help), no access (who to ask), read-only, locked period, offline (phone), and "Coming in phase N" (disabled, never dead).
- **Warnings sit next to their field**, stating the rule and the next step. Irreversible actions go through `ConfirmDialog` with the exact effect spelled out. Posted records offer Reverse, never Delete.
- **Keyboard entry for vouchers:**
  - Enter adds a line, Ctrl+S saves, Esc closes, Ctrl+K searches.
  - F4 Contra, F5 Payment, F6 Receipt, F7 Journal, F8 Sales, F9 Purchase.
- **Phone screens:**
  - One primary action, 52–60 px tall.
  - Touch targets of at least 48 px.
  - Pictures alongside the words.
  - Drafts saved offline in IndexedDB.
- **i18n:** every visible string goes through i18next (`en`, `ml`, `hi`, `bho`). IDs and amounts stay in digits.
- **Accessibility:** WCAG 2.2 AA, a visible focus ring, labelled fields, `th` with scope, and axe-clean pages.

## Never

- Copy figures, names or IDs from the design files into code, seeds or tests.
- Ship "Sample layout" or "Sample day" labels, or lorem ipsum.
- Use a UI kit's default theme. Headless primitives such as Radix are fine.
- Add colours, fonts or patterns that aren't in the reference. Use the nearest existing pattern instead, and note it in `docs/IMPLEMENTATION_STATUS.md`.
