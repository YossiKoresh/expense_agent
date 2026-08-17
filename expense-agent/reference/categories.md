# Categories

## The rule

`CATS` in `expense-agent.gs` is a **closed list**. The classifier must pick a name from
it and may never invent one. If nothing fits, it picks the closest and writes
what it *would* have called it into the Note as
`suggested category: <name>`, for you to accept or ignore.

This is deliberate. An open-ended classifier gives you "Software", "SaaS",
"Software subscription" and "Tools" for the same four invoices, and a budget
built on that is worthless. Consistency beats precision here.

## The default chart of accounts

Grouped by the P&L section they roll up to.

**COGS** — what it costs to deliver the thing you sell
`Cost of Goods` · `Manufacturing & Production` · `Shipping & Fulfilment` ·
`Payment Processing`

**R&D** — building the product
`Software & SaaS` · `Hosting & Infrastructure` · `AI & Dev Tools` ·
`Contractors - Product`

**S&M** — getting customers
`Advertising` · `Marketing Services` · `Contractors - Marketing`

**G&A** — running the company
`Professional Services` · `Banking & Fees` · `Insurance` · `Taxes & Licences` ·
`Telecom & Internet` · `Office & Supplies` · `Rent & Facilities` · `Utilities` ·
`Equipment & Hardware` · `Travel` · `Meals & Entertainment` · `Training` ·
`Payroll & Benefits` · `Other`

These map onto how most people actually want to read a P&L, and they are
generic enough that a consultancy, a shop and a SaaS company can all use them
unchanged.

## Adding a category

Two ways, and they behave differently.

**Properly** — add the name to `CATS` *and* give it a section in `SECTION`,
then run `reclassify()`. From that point the classifier can choose it, and the
budget files it in the right section.

**Quickly** — just type the new name into the Category column of any row. The
budget picks it up on the next rebuild and shows it under **UNASSIGNED**. It is
counted, it is visible, it is just not in a section yet. The classifier still
cannot choose it until you add it to `CATS`.

The UNASSIGNED block exists so that a category you invent by hand is never
silently dropped from the totals. If you see something sitting there, that is
the system asking you where it belongs.

## Changing categories after you have data

Run **`reclassify()`**. It reads the rows already in the sheet — vendor,
description, amount, who it was billed to — and rewrites only the Category and
Business/Personal columns. It does not open Gmail, does not re-download a
single PDF, does not spend Gmail quota, and does not touch amounts, dates,
file links or your notes.

**Do not wipe the sheet and re-scan.** Extraction is the expensive and fragile
part and it was already correct; only the labelling changed. Re-scanning also
burns the Gmail daily quota, which on a consumer account will lock you out for
the rest of the day.

## Business vs Personal

Every row is tagged one or the other, and the budget counts only `Business`.
This exists because for most small operators the same inbox receives the
company's AWS bill and their own electricity bill, and separating them at
classification time is far less work than separating them at year end.

Tell the classifier what "personal" looks like for you in
`BUSINESS_DESCRIPTION` — it is the fastest way to fix systematic mistakes.

## Tuning the classifier

Three levers, in order of effect:

1. **`BUSINESS_DESCRIPTION`** — by a wide margin the most effective. Name your
   trading names, your payment processor, your main suppliers, and what a
   personal expense looks like for you.
2. **The rules list in `triage()`** — add a line for any mistake you see twice.
3. **`KEYWORDS`** — controls what is even looked at. If something never appears
   at all, this is why. Add your bank's or accountant's wording.
