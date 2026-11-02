# Role and permission matrix

Initial version (Phase 0) from prompt §2.4 (roles), §6 (rights, views, grants, SoD), §15A (salesman), §18 (salary/KYC), §19 (investors), §UX-5 (view chip). **The module grid in §3 is a proposal for the owner to confirm** — rights are data (`core.role_rights`) and Admin can change them in Users & rights from Phase 1. People are never hard-coded; Admin creates them and assigns roles.

## 1. Roles, sign-in and view

Role codes are used in `core.roles.code` (Phase 1) and, in Phase 0 only, in the JWT `app_metadata.role` that drives the view chip.

| Role (§2.4) | Code | Sign-in | MFA | View chip | Notes |
|---|---|---|---|---|---|
| Owner / Admin | `admin` | Email + password | TOTP required | All transactions | Only role that can create a document without GST (with lawful reason) |
| Managing Director | `md` | Email + password | TOTP required | GST transactions | Time-limited credit exceptions (§15) |
| General Manager | `gm` | Email + password | TOTP required | GST transactions | |
| Finance Head | `finance_head` | Email + password | TOTP required | GST transactions | Transfer shortage write-off; Bug fixer book fixes |
| Accountant | `accountant` | Email + password | TOTP required | GST transactions | Cannot see bills without GST |
| Office admin | `office_admin` | Email + password | TOTP required | GST transactions | Labelled role with GST view only — not a copy of Admin |
| CA / Auditor | `ca` | Email + password | TOTP required | All transactions · read-only | For a set period (`valid_to`); every write hidden and refused |
| Production Manager (Biochem) | `production_manager` | WhatsApp no. + password | — | GST transactions | |
| Chemist (lab, QC) | `chemist` | WhatsApp no. + password | — | GST transactions | Lab panel |
| QC releaser | `qc_releaser` | WhatsApp no. + password | — | GST transactions | Second person; cannot release a batch they made/weighed |
| Supervisor | `supervisor` | WhatsApp no. + password | — | GST transactions | |
| Factory labour / packing staff | `factory_staff` | WhatsApp no. + password | — | GST transactions | Staff app only |
| Mould manager (Plastics) | `mould_manager` | WhatsApp no. + password | — | GST transactions | |
| Injection manager (Plastics) | `injection_manager` | WhatsApp no. + password | — | GST transactions | |
| Assembly (Plastics) | `assembly` | WhatsApp no. + password | — | GST transactions | |
| Quality (Plastics) | `quality` | WhatsApp no. + password | — | GST transactions | |
| Machine operator (Plastics) | `machine_operator` | WhatsApp no. + password | — | GST transactions | Daily machine check (Hindi) |
| Buying, logistics, petty cash | `buyer_logistics` | WhatsApp no. + password | — | GST transactions | |
| Factory manager / working partner (Plastics) | `factory_manager` | WhatsApp no. + password | — | GST transactions | Also investor portal as working partner |
| Sales manager | `sales_manager` | WhatsApp no. + password | — | GST transactions | Approves geofence exceptions, discounts over authority, over-limit orders |
| Salesman | `salesman` | WhatsApp no. + password | — | GST transactions | Own assigned customers only (RLS) |
| Shop staff (Kochi, Coimbatore) | `shop_staff` | WhatsApp no. + password | — | GST transactions | Own shop only |
| Driver | `driver` | WhatsApp no. + password | — | GST transactions | Own trips only |
| Designer | `designer` | WhatsApp no. + password | — | GST transactions | |
| Digital marketer | `digital_marketer` | WhatsApp no. + password | — | GST transactions | Online listings (publishing is Admin-only) |
| Admin assistant | `admin_assistant` | WhatsApp no. + password | — | GST transactions | |
| Partner / investor | `investor` | Investor portal sign-in | TOTP recommended (to confirm) | n/a (portal) | Analytics + requests only; no ERP links |

Unknown or missing role → **GST transactions** view with no module rights (safest reading).

Every signed-in user holds `help.report_problem` and `help.ask` (§HELP-4).

## 2. Rights format

`<module>.<action>` where action ∈ `view`, `create`, `post`, `approve`, `reverse`, `export`, `admin`. Examples: `sales.invoice.post`, `inv.transfer.close`, `hr.salary.view`, `hr.kyc.view`, `acct.period.close`, `admin.users.manage`, `sales.without_gst.create` (Admin only).

Scope: each user–role assignment is limited by company / branch / place (`core.user_scopes`). Approval limits in amounts per role and document type (`core.approval_limits`).

## 3. Module grid (proposal)

Legend: **R** read · **W** create/post · **A** approve · **—** none · *own* = only own records/customers/trips/place. All access is further trimmed by scope and view.

| Role | Home | Sales | Purchase | Prod Biochem | Prod Plastics | Inventory | Logistics | Exports | HR (no salary/KYC) | Salary & KYC | Accounts | GST | Admin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `admin` | R | RWA | RWA | RWA | RWA | RWA | RWA | RWA | RWA | RWA | RWA | RWA | RWA |
| `md` | R | RA | RA | R | R | R | R | RA | RA | R | RA | R | — |
| `gm` | R | RA | RA | RA | RA | RA | RA | R | RA | — | R | R | — |
| `finance_head` | R | RA | RA | R | R | R | R | R | R | RA | RWA | RW | — |
| `accountant` | — | RW | RW | — | — | R | — | R | R | R (payroll only, if granted) | RW | RW | — |
| `office_admin` | — | R | R | — | — | R | R | — | R | — | R | R | — |
| `ca` | R | R | R | R | R | R | R | R | R | R | R | R | R (logs) |
| `production_manager` | — | — | RW (requests) | RWA | — | RW | — | — | R (own team) | — | — | — | — |
| `chemist` | — | — | — | RW (labs) | — | R | — | — | — | — | — | — | — |
| `qc_releaser` | — | — | — | RA (release) | — | R | — | — | — | — | — | — | — |
| `supervisor` | — | — | — | RW | RW | R | — | — | RW (attendance) | — | — | — | — |
| `factory_staff` | — | — | — | — | — | — | — | — | own | own payslip | — | — | — |
| `mould_manager` | — | — | RW (requests) | — | RW (moulds) | R | — | — | — | — | — | — | — |
| `injection_manager` | — | — | — | — | RW (injection) | R | — | — | RW (attendance) | — | — | — | — |
| `assembly` | — | — | — | — | RW (assembly) | R | — | R | — | — | — | — | — |
| `quality` | — | — | — | — | RW (quality) | R | — | — | — | — | — | — | — |
| `machine_operator` | — | — | — | — | W (checks) | — | — | — | own | own payslip | — | — | — |
| `buyer_logistics` | — | — | RW | — | — | RW | RW | — | — | — | W (petty cash) | — | — |
| `factory_manager` | R | — | RA | — | RWA | R | R | R | RA | — | — | — | — |
| `sales_manager` | R | RWA | — | — | — | R | R | — | R (team) | — | — | — | — |
| `salesman` | — | own (RW) | — | — | — | R (van) | — | — | own | own payslip | — | — | — |
| `shop_staff` | — | own shop (RW) | — | — | — | own place (RW) | — | — | own | own payslip | — | — | — |
| `driver` | — | — | — | — | — | — | own trips (RW) | — | own | own payslip | — | — | — |
| `designer` | — | R (products) | — | — | — | R | — | — | own | own payslip | — | — | — |
| `digital_marketer` | — | RW (listings draft) | — | — | — | R | — | — | own | own payslip | — | — | — |
| `admin_assistant` | — | R | R | — | — | R | R | — | R | — | — | — | — |
| `investor` | — | — | — | — | — | — | — | — | — | — | — | — | — (portal only) |

Every role also has the **staff app** for their own attendance, requests, payslips and details.

## 4. Admin-only rights (§8, §6)

Add companies, branches, GSTINs · add tasks, tabs, forms and fields · add products, groups and prices · publish online listings · create documents without GST (lawful reason required) · grant special permissions · merge parties · approve import batches · restore backups · manage users and rights.

## 5. Never grantable (enforced in SQL)

Turning off or editing the audit trail · deleting posted records · editing a closed period · changing filed returns · viewing passwords or secrets · giving out rights.

## 6. Segregation of duties (enforced in RPCs)

| Rule | Code | Check |
|---|---|---|
| Batch maker / weigher cannot QC-release it | SoD-1 | `api.qc_release_batch` |
| Picker cannot close the stock transfer | SoD-2 | `api.close_transfer` |
| Salesperson cannot approve own credit limit | SoD-3 | `api.approve_credit_stage` |
| Preparer cannot approve own payment | SoD-4 | `api.approve_payment` |
| Nobody approves their own request | SoD-5 | all `approve_*` / `decide_*` RPCs |
| Transfer shortage written off only by finance | SoD-6 | `api.write_off_transfer_shortage` |
| Complaint cannot be closed by the salesperson alone | SoD-7 | `api.close_complaint` |
| Bank account change needs two people + call-back | SoD-8 | `api.approve_bank_change` |

## 7. Open points for the owner

- Confirm the module grid above (especially MD/GM/finance access to salary, accountant access to payroll, Office admin scope).
- Approval limit amounts per role and document type (never invented; Admin enters them).
- Whether investors use TOTP MFA.
- The CA's read-only window dates.
