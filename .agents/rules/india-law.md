---
trigger: model_decision
description: Apply when working on GST, invoices, challans, e-invoice, e-way bill, cash book, TDS, payroll, labels, MRP, licences, statements, WhatsApp, GPS or any personal data.
---

# Indian law the ERP enforces

The CA confirms every rate and threshold before go-live. Keep thresholds and rates in settings tables with effective dates, never as constants in code. Record each rule in `docs/LAW_RULES.md` with three things: where it is enforced, its test, and its status.

| Rule | What the ERP does |
|---|---|
| A tax invoice is needed for every taxable supply. Numbers are unique per FY, at most 16 characters. | Gap-free series per company, GSTIN, document type and FY, for example `SB/26-27/0001`. |
| A bill without GST is allowed only for exempt or nil-rated goods (bill of supply), a non-GST supply, an export under LUT, or a delivery challan for goods not sold. | Admin only. A lawful reason is required. The RPC refuses taxable HSNs. The bill still goes into the books, the returns workings and the CA's view. |
| GST rate by HSN. From 22-Sep-2025, toilet soap bars (3401 11) are 5%; liquid soap, hand wash, body wash, detergents and cleaners are 18%. | Rates come from an HSN table with effective dates. Changing a rate on a document needs approval. |
| Place of supply | Same state: CGST + SGST. Another state: IGST. Kochi is on the same GSTIN, so goods move on a delivery challan. Coimbatore has its own TN GSTIN, so goods move on a tax invoice with IGST. |
| Every supply goes into the returns (GSTR-1, GSTR-3B), including nil-rated, exempt and non-GST supplies. | Return workings are built from all transactions. |
| E-invoice (IRN) for B2B once aggregate turnover passes ₹5 crore in any year | Switched on per GSTIN in settings. The IRN is fetched before the invoice is final, and the QR is printed. |
| E-way bill above the threshold value | Created at dispatch, before the vehicle leaves. Thresholds are set per state. |
| Cash receipts (Income-tax Act 2025, s.186) | A receipt of ₹2 lakh or more from one person in a day is **refused**. |
| Cash payments over ₹10,000 to one person in a day can't be claimed as an expense. | A warning is shown and payment by bank is offered. Paying in cash anyway needs a reason that Admin sees. |
| TDS on salary, rent, contractors and professionals | Worked out at payment, with the quarterly workings. The CA sets the sections and rates. |
| Audit trail that can't be disabled. Books kept in India and backed up daily in India (Companies (Accounts) Rules, Rule 3). | Append-only history. Supabase runs in Mumbai. Backups go to India-only locations. |
| Schedule III statements and Schedule II depreciation | Reports and the asset register |
| Loans to directors (s.185). Money lent by a director needs a written declaration. | Checked on partner requests before Admin approves. |
| Labour codes (from 21-Nov-2025): a wage slip for every worker; overtime at twice the normal rate; PF from 20 employees, ESI from 10 | Payslips, a fixed overtime rate, and PF/ESI switched on by headcount and pay. |
| Legal Metrology: maker, net quantity and MRP (including all taxes) on every pack; never sell above MRP | The bill refuses a price above MRP. Label data is held on the product. |
| Cosmetics Rules 2020: soaps, hand wash and body wash are made under a licence, and the licence number goes on the label | The licence is on the product and the label. An expired licence blocks production entry. |
| MSME: payment within the agreed terms, at most 45 days | Due-date alerts and an MSME payables report. Customer terms longer than 45 days are refused where the rule applies. |
| Free items, gifts and combo packs (CBIC circular 92/11/2019, s.17(5)(h), s.8) | Treatment is set per pack with the CA. The free item's stock is issued and recorded. |
| DPDP Act 2023 and DPDP Rules 2025 | Purpose and notice for each kind of data, consent where needed (WhatsApp, GPS), masking, retention by record type, and rights requests. |
| WhatsApp Business Platform rules | Opt-in, approved templates, the 24-hour window, STOP opt-outs. No general-purpose AI chatbot on WhatsApp; the help assistant stays ERP-specific and offers a person. |

This is a design checklist, not legal advice.
