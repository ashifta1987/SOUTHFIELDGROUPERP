---
slug: integrations
screen: BookFixes
title: Integrations (e-invoice, e-way bill, feeds, stores)
---

Every call to an outside service — the GSP for e-invoice IRNs and e-way bills, bank statement feeds, online stores and WhatsApp help — waits in a queue and is retried with growing waits. When it still fails after the last try it shows as **Gave up** in Bug fixer → Integrations and as a Bug fixer item in the area "Integrations".

**Retry** sends it again now. If the same error comes back, check the provider's status page and the document (GSTINs, HSN codes, addresses), then retry. "Run with mock provider" appears only on the development system.

**Inbound webhooks** list what arrived from outside: the signature result (Rejected means the message was not signed by the provider and was ignored) and what was done with it. The same event never counts twice.

Errors: `integrations.provider_not_set` — no provider is chosen yet (owner). `integrations.mock_not_allowed` — the test provider works only on development. Who to ask: Admin.
