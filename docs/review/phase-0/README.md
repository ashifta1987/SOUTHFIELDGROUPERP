# Phase 0 review — screenshots

Taken with Playwright (`REVIEW_SHOTS=1 npx playwright test e2e/review-screens.spec.ts`) against the **empty DEV database** with two synthetic review accounts. No real data.

The reference images are in `design-reference/screens/` on the owner's computer only (that folder is never committed). Open each pair side by side:

| Screen | Build (this folder) | Reference (local only) | Viewport |
|---|---|---|---|
| Sign in | `Login.png` | `design-reference/screens/Login.jpg` | 1440 |
| Staff sign in | `StaffSignIn.png` | `design-reference/screens/StaffSignIn.jpg` | 390 |
| Home | `Main.png` | `design-reference/screens/Main.jpg` | 1440 |
| Customers | `Customers.png` | `design-reference/screens/Customers.jpg` | 1440 |
| Staff home | `StaffHome.png` | `design-reference/screens/StaffHome.jpg` | 390 |
| Home on a tablet, drawer open | `Main-834-drawer.png` | — | 834 |

Differences that could not be resolved are listed under **Design deviations** in `docs/IMPLEMENTATION_STATUS.md`. Most come from one rule: every figure and name on screen must come from the database, and the database is empty until Phases 1–3.
