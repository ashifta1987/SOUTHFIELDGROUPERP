---
slug: import-data
screen: DataImport
title: Loading Tally data
---

Export masters and the day book from TallyPrime as XML (Alt+E → XML). On Import data choose the company and upload the file, check the rows, then import. Records are matched by Tally's ID, then GSTIN/PAN, then name. Unsure matches create nothing and go to the Bug fixer. Loading the same file twice creates nothing new. Tally backup files (TBK) wait for the Tally bridge on the import computer.

**Reports from Tally.** Choose Day Book, Trial Balance, Stock Summary or Balance Sheet, then follow the "How to export from TallyPrime" box on the screen (Display → the report → Alt+E → Excel; for the Trial Balance press Alt+F5 first so every ledger shows).
- *Day Book* is kept as reference history only. It has one line per voucher, so it can't be posted. Only Admin loads it. The same file twice adds nothing; two identical lines in one file are both kept.
- *Trial Balance* becomes the opening balances only when Admin applies it, only when debit equals credit, and only when each ledger's Tally group is mapped. The CA should sign the numbers first. Nothing is posted.
- *Stock Summary* posts opening stock once, into the store you choose. Items that aren't in the product list must be mapped to an existing product or created on the Products screen first.
- *Balance Sheet* is only compared with the ERP; it never posts.
Use **Compare** in "Reports from Tally" to see the differences during the parallel run.

