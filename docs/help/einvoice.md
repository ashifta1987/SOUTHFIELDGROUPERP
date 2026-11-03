---
slug: einvoice
screen: Invoice
rule_code: einvoice.irn_required
title: E-invoice (IRN and QR)
---

When the CA confirms that e-invoicing applies to a GSTIN, Admin switches it on with a start date. From then on a B2B tax invoice or credit note with GST is **final only with its IRN**: it cannot be printed or sent on WhatsApp, and the goods cannot leave on a trip, until the IRN arrives.

Steps: post the invoice → in the E-invoice panel press **Get IRN** → the IRN, acknowledgement and QR appear and are printed on the invoice. If the panel says "Gave up", Admin retries from Bug fixer → Integrations.

Cancelling: an IRN can be cancelled only within 24 hours of acknowledgement (choose why and add a remark). After that, issue a credit note. A document with an active IRN is not cancelled until its IRN is cancelled (`einvoice.cancel_irn_first`).

Errors: `einvoice.irn_required` — get the IRN first. `einvoice.switch_off` — e-invoicing is off for this GSTIN. `einvoice.not_eligible` — sales to unregistered customers and bills without GST get no IRN. `einvoice.cancel_window` — older than 24 hours; issue a credit note. Who to ask: accounts, then Admin.
