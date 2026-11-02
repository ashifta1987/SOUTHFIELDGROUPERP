---
trigger: glob
globs: supabase/**, src/shared/**, src/**/api/**, tests/db/**
description: Southfield database, security and posting rules for Supabase migrations, RLS, RPCs and Edge Functions.
---

# Southfield database rules

These rules come from Part 1 of `docs/prompts/SOUTHFIELD_ERP_PROMPT.md`: §3, §5–§7 and §23–§27, plus §WA-2.

## Projects and regions

- Supabase dev and prod projects both run in `ap-south-1` (Mumbai).
- Edge Functions run in `ap-south-1` through regional invocation.
- Previews and dev never touch the prod project.

## Migrations

- Plain SQL in `supabase/migrations/`, one purpose per file, with a header comment saying what it does.
- Regenerate types after each migration: `supabase gen types typescript`.
- Destructive changes (drop, a rename that moves data, a type change) need a written plan in the PR and the owner's approval. Prod runs only through the GitHub environment that needs approval.

## Schemas

- Tables live in private schemas: `core`, `master`, `inv`, `prod`, `sales`, `purch`, `acct`, `hr`, `field`, `ops`, `msg`, `help`, `audit`.
- The Data API exposes only `api`, which holds `security_invoker` views and RPCs.

## Tenancy and row-level security

- Every business row has `company_id`. Rows also carry `gstin_id` and `place_id` wherever tax or stock depends on them.
- RLS is enabled on **every** table. Policies call `app.can(company_id, 'module.action')`, a helper that is `stable`, `security definer` and has `set search_path = ''`.
- Policies use `(select auth.uid())`, and every column a policy filters on is indexed.
- **Views:**
  - Admin and Owner: all transactions.
  - CA and Auditor: all transactions, read-only, for a time window.
  - Everyone else: documents in the GST classes only.
- **Special permissions:** a grant is a row with a user, a right, from/to times and parameters. The policies and RPCs check it, and every action under it records the grant ID. The never-grantable list is enforced in SQL.

## Posting RPCs

Every posting RPC is `security definer` with `set search_path = ''`, and works like this:

1. Validates rights, document state (from a transition table), period open, stock, credit limit, licence blocks, segregation of duties and GST class with its lawful reason.
2. Locks the rows it changes with `select … for update`.
3. Writes the documents, the ledgers and the history in **one transaction**.
4. Takes `client_request_id uuid`, unique per document type, so a repeat call returns the existing document.
5. Takes gap-free numbering per company, GSTIN, document type and FY at posting time. GST invoice numbers are at most 16 characters.
6. Inserts `msg.outbox` rows, for WhatsApp, in the same transaction.

## Ledgers and the audit trail

- Ledgers (`inv.stock_ledger`, `acct.gl_entries`, `prod.material_consumption`, `core.asset_events`) and `audit.row_history` are append-only.
- They have no insert, update or delete grants for `authenticated`.
- Triggers reject update and delete on them.
- Corrections are reversal documents.

## Types and storage

- Money is `numeric(18,2)`, quantities are `numeric(18,3)`, and rates are `numeric(9,4)`. No float or real columns.
- Storage buckets are private (`kyc`, `bills`, `documents`, `licences`, `lab`, `imports`), with policies by company and right. Files are reached only through signed URLs that expire quickly.

## Secrets and data

- The service-role or secret key lives only in Edge Function secrets and CI secrets.
- Bank statement passwords are never stored.
- Aadhaar is stored masked, last 4 digits only.

## Tests (pgTAP, `supabase test db`)

- **RLS per role:**
  - An accountant can't see bills without GST.
  - The CA can't write.
  - A Plastics user can't see Biochem data.
  - The help assistant's views stay within the user's rights.
- **Each RPC:**
  - Its entries balance.
  - It is idempotent.
  - It refuses a closed period, negative stock and a forbidden transition.
- **Concurrency:** two parallel issues of the last unit of stock.
- **Fixtures:** synthetic only, such as "Test Customer 01". Never real data.
