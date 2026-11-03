---
slug: eway-bill
screen: Dispatch
rule_code: dispatch.eway_required
title: E-way bill on the dispatch board
---

Goods leave only with an e-way bill (unless the dispatch is under the threshold the CA set). On the dispatch card press **Get e-way bill**, give the vehicle number and distance, and send. The number, validity and vehicle appear on the card when the provider answers. You can still type a number made on the portal ("Add e-way bill").

The e-way bill is made from the posted invoice, so the invoice must be final first (with its IRN when e-invoicing is on). A cancelled or expired e-way bill cannot carry goods (`dispatch.eway_invalid`).

Errors: `dispatch.eway_required` — add the e-way bill before starting the trip. `eway.needs_invoice` — make the invoice first. `einvoice.irn_required` — the invoice needs its IRN. Who to ask: dispatch desk, then accounts.
