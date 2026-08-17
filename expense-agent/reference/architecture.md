# Architecture

## Why Apps Script and not a server

The job needs three things that are awkward to get anywhere else at once: read
access to a Gmail mailbox, write access to a Drive folder, and write access to
a Sheet — all as the mailbox owner, on a schedule, forever, with no hosting
bill and no OAuth flow for the user to maintain. Apps Script has all of that
built in and runs inside the user's own account. Nothing here needs a server,
a container, or a stored Google credential.

The cost is Apps Script's limits: 6 minutes per execution and a Gmail daily
quota that is much smaller on consumer accounts than on Workspace. Both shape
the design below.

## The pieces

```
             ┌──────────────────────────────┐
             │  Gmail (mailbox A)           │
             └──────────────┬───────────────┘
                            │ search, labelled once seen
             ┌──────────────▼───────────────┐
             │  expense-agent.gs   MODE: solo/hub  │
             │  ─ triage   (fast model)     │
             │  ─ extract  (smart model,    │
             │     PDF sent as a document)  │
             │  ─ FX to base currency       │
             └───┬───────────────────┬──────┘
                 │                   │
      ┌──────────▼──────┐   ┌────────▼────────────┐
      │ Drive           │   │ Google Sheet        │
      │ /2026/2026-03/  │   │  Expenses           │
      │  invoice PDFs   │   │  Income             │
      └─────────────────┘   │  Budget 2026/2027   │
                            │  Drill-down         │
                            └────────▲────────────┘
                                     │ onSelectionChange
                            ┌────────┴────────────┐
                            │ drilldown.gs        │
                            │ (bound to the sheet)│
                            └─────────────────────┘

  optional second mailbox:
      Gmail (mailbox B) → expense-agent.gs MODE: satellite ──POST──> hub web app
```

### Why up to three projects

1. **expense-agent.gs** — standalone, owns the sheet and the Drive folder, runs the
   triggers, makes every Claude call.
2. **expense-agent.gs in satellite mode** — only needed for a second mailbox. A Google
   account cannot read another account's Gmail, full stop. So the second
   account runs its own copy and POSTs finished rows to the first one's web
   app, authenticated by a shared secret. It owns no data.
3. **drilldown.gs** — bound to the spreadsheet, because `onSelectionChange` is
   a *simple trigger* and simple triggers only exist in bound scripts. It is
   pure UI: it never touches Gmail, Drive or Claude.

## The two-model pass

Triage runs on a cheap fast model over the email text alone, and answers one
question: expense, income, or skip. Most mail is skip, and skip is where almost
all the volume is, so this is where the cost control lives.

Extraction runs on a stronger model and — this is the part that matters — the
invoice PDF is sent **as a document**, not as text scraped from the email body.
Email bodies routinely say "your invoice is attached" and nothing else, and
non-Latin invoices (Hebrew, Japanese, Arabic) are frequently unreadable as
extracted text but perfectly readable as a rendered page. Sending the file is
the difference between a tracker that works on your real mail and one that
works on the easy half of it.

## Duplicate protection, in two layers

- **Authoritative:** the Gmail message id is written into every row. Before
  processing, the whole id column is read into a set. A message already in the
  sheet is never processed again, no matter how many times you re-scan.
- **Optimisation:** every thread that has been *looked at* gets a Gmail label,
  and labelled threads are excluded from all future searches. This is what makes
  the daily run nearly free.

The distinction matters. If you ever delete rows from the sheet, the label will
still say "seen" and those threads become invisible. Re-scanning is always safe
because of layer one — so the fix is to point at a new label, never to delete
data. See `troubleshooting.md`.

## Backfill

Doing a year of mail in one execution would blow the 6 minute limit. Instead a
5-minute trigger walks one month per tick and the cursor advances **only when a
month completes with zero errors** — so a transient failure retries instead of
silently skipping a month. When the cursor passes today, the trigger deletes
itself.

## Budget tabs

Every number is a live `SUMIFS` against the expense tab, filtered to `Business`.
So the budget is never stale and never needs rebuilding to be correct — a new
row appears in the totals immediately.

A rebuild is only required when the *category list* changes, which is what
`syncBudgets()` checks by fingerprinting the list. Rebuilds preserve the
Allocation column by reading it back by row label first.

Row identity for the drill-down is carried in a hidden machine tag in column T:

```
cat|Advertising                          a single category row
cat|Advertising;Marketing;Contractors    a section or roll-up row
rev                                      the revenue row
```

Which means the drill-down script holds no category list of its own. Add,
rename or re-section a category and it keeps working with zero changes.

## Money in, done properly

Payment processors deposit **net**, but the revenue figure is **gross** and the
difference is a real fee you paid. If you record the deposit, your revenue is
understated and your processing costs are invisible.

So one payout email produces two rows: an income row at gross, and a
`Payment Processing` expense row for the commission. If the fee is not stated
anywhere in the email, the row is flagged `NEEDS REVIEW` rather than assumed —
because silently understating revenue is the worst possible failure mode for
a bookkeeping tool.

## What it deliberately does not do

- No accounting-software sync. The sheet is the product.
- No OCR fallback for scanned images with no text layer beyond what the model
  itself can read.
- No multi-entity or multi-currency ledgers. One business, one base currency.
- No writes back to Gmail beyond a label.
