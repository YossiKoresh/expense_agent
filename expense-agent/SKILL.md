---
name: expense-agent
description: Set up an automated expense and invoice tracker that reads a Gmail mailbox with Claude, files invoice PDFs in Drive, writes a Google Sheet ledger, and builds click-through budget tabs. Use when the user wants to track expenses or receipts from email, automate bookkeeping, build an expense tracker, stop doing receipts by hand, or asks to install / configure Expense Agent.
---

# Expense Agent — installer

You are setting this up **for** the user. They should end up with a working
tracker having only pasted two files and clicked through a few Apps Script
menus. Do not hand them a pile of instructions and walk away.

Everything runs inside the user's own Google account as Apps Script. Nothing
runs on your machine, and no credential ever passes through you.

---

## Before anything: what you must never do

- **Never ask for, type, or handle the user's Anthropic API key.** They paste it
  into Apps Script Script Properties themselves. You will not see it and must
  not offer to.
- Never ask for a Google password or drive a Google login.
- Deploying a web app and installing triggers are the user's clicks, not yours.

---

## Step 1 — ask, in one round

Ask all of these together (use a multiple-choice question tool if you have one,
otherwise one numbered list). Do not ask them one at a time.

1. **What does this business do?** One line, plain language.
   *This is the single highest-leverage answer — the classifier reads it before
   every decision. "Acme Ltd, a UK company selling handmade furniture online"
   beats "my business" by a mile.*
2. **Accounting currency?** (USD / EUR / GBP / other ISO code)
3. **Time zone?** (e.g. `America/New_York`, `Europe/London`, `Asia/Tokyo`)
4. **How far back should the first scan go?** Offer: this year so far / the
   last 12 months / a specific date / don't bother, start from today.
   *The backfill runs flat out — a year is usually minutes, not days — so the
   only reason to say no is if the mailbox predates the business.*
5. **How often should it check for new expenses afterwards?** Offer: once a day
   (the default, and right for almost everyone) / twice a day / every 6 hours /
   hourly.
   *Say plainly that hourly is only sensible on a Workspace account. Consumer
   Gmail has a much smaller daily Apps Script quota, and a fast cadence on top
   of a big backfill is the one thing that reliably breaks this.*
6. **Track money coming in too, or expenses only?**
   *Income mode reads payout/settlement emails from processors like Stripe,
   PayPal, Square, Shopify, or a bank, and splits their commission out as a
   Payment Processing expense — which is the only way the budget's revenue line
   is not quietly understated.*
7. **One mailbox or two?** Two is common: a personal address and a company one.
8. **File invoice PDFs to Drive?** (yes → they will give a folder; no → the
   ledger keeps only the Gmail link)

Then tell them to do this and paste back the two URLs:

> Create a **blank Google Sheet** and, if you want PDF filing, a **Drive
> folder**. Both must live in the account whose mailbox we are scanning
> (for two mailboxes: the account you want to own the data). Paste me both URLs.

Pull the ids out of the URLs yourself:
- Sheet: `docs.google.com/spreadsheets/d/`**`<id>`**`/edit`
- Folder: `drive.google.com/drive/folders/`**`<id>`**

---

## Step 2 — generate their file

Read `scripts/expense-agent.gs`. Fill in the `CONFIG` block with their answers, and
nothing else. Leave `MODEL_FAST` / `MODEL_SMART` empty — `setup()` resolves
those against their key.

For **one mailbox**: `MODE: 'solo'`, and `SHARED_SECRET` / `HUB_URL` stay `''`.

For **two mailboxes**: generate two files.
- `expense-agent-hub.gs` — `MODE: 'hub'`, a `SHARED_SECRET` you generate (32+ random
  characters), full `SHEET_ID` and `DRIVE_FOLDER_ID`.
- `expense-agent-satellite.gs` — `MODE: 'satellite'`, the **same** `SHARED_SECRET`,
  `HUB_URL` left `''` for now (filled in at step 4), and `SHEET_ID` /
  `DRIVE_FOLDER_ID` left as-is (unused in satellite mode).

Also read `scripts/drilldown.gs` and set `EXPENSE_TAB` and `INCOME_TAB` to
match. Everything else in it stays — it reads the spreadsheet's own timezone,
so there is nothing to configure there.

Write the finished files out and **send them to the user as files**, not as
code blocks in chat — they have to paste ~44 KB into an editor and a chat code
block makes that painful.

If they said "expenses only", also set `TRACK_INCOME: false`. If they said no
Drive filing, set `DRIVE_FOLDER_ID: ''`. Map their cadence answer to
`SCANS_PER_DAY` (1 / 2 / 4 / 24) and their history answer to `BACKFILL_FROM`
(a `YYYY-MM-DD` date, or `''` for none).

---

## Step 3 — walk them through the main project

Give these as numbered steps and wait for them to confirm before moving on.
Estimated time: 3 minutes.

1. Go to **script.google.com** → **New project**. Rename it something obvious,
   e.g. `Expense Agent — <mailbox>`.
2. Select everything in the editor and paste in `expense-agent.gs`. **Ctrl/Cmd+S**.
3. Left sidebar → **Project Settings** (gear) → **Script properties** →
   **Add script property**:
   - Property: `ANTHROPIC_API_KEY`
   - Value: their key from console.anthropic.com → **Save script properties**
   *(They do this. You never see the value.)*
4. Back to **Editor**. The Run dropdown should say `RUN`. Press **Run**.
   Google will ask for authorization: **Advanced → Go to (project name) →
   Allow**. This is Google warning about their own unpublished script; it is
   expected.
5. The execution log should end with something like
   `models: claude-haiku-4-5 + claude-sonnet-4-5 | budgets rebuilt | scanning once a day at 6:00 | ran 4 passes, cursor at 2026-05-01, chained`.

If they hit an error, go to **Troubleshooting** in `reference/troubleshooting.md`.

From here the backfill runs flat out: each execution processes as many months
as fit in its 6-minute limit, then chains the next one a minute later. A year
is usually done in minutes.

If their Gmail daily quota runs out first, the log will say so and it will
schedule itself to resume just after the quota resets at midnight Pacific.
That is expected on a busy consumer mailbox, not a failure — tell them it will
finish itself and they do not need to do anything.

---

## Step 4 — second mailbox (skip if they said one)

The hub project must be reachable by the satellite, because one Google account
cannot read another account's Gmail.

**In the hub project (step 3's project):**
1. **Deploy → New deployment → gear → Web app**.
2. Execute as: **Me**. Who has access: **Anyone**. **Deploy**.
3. Copy the `/exec` URL.

> Tell them plainly: "Anyone" means anyone who has the URL *and* the shared
> secret in the file. Without the secret every request is rejected. If they are
> not comfortable with that, they can skip the second mailbox and forward
> receipts to the first one instead.

**In the second Google account:**
4. script.google.com → New project → paste `expense-agent-satellite.gs`.
5. Set `HUB_URL` to the `/exec` URL you just copied. Save.
6. Script Properties → `ANTHROPIC_API_KEY` → the same key. Save.
7. **Run** → authorize → done.

---

## Step 5 — drill-down

1. Open the **Google Sheet** → **Extensions → Apps Script**. This opens a
   project already bound to the sheet.
2. Select all, paste `drilldown.gs`, save. Rename the project
   `Expense Agent — drill-down`.
3. Reload the sheet.

Now clicking any number on a Budget tab refills the **Drill-down** tab with the
exact rows behind it. Tell them the honest UX: Google does not let a selection
trigger move their view, so it is *click the number, then open the Drill-down
tab* — two clicks, not one.

---

## Step 6 — verify, then hand over

Ask them to run `status()` (edit `RUN()`'s body to `return status();`, save,
Run) and read back what it says. Confirm:
- `hasApiKey: true`
- `models` shows two real ids
- `expenseRows` is climbing

Then tell them the four things they will actually want later:

- **Wrong categories?** Edit `CATS` and `SECTION` at the top of `expense-agent.gs`,
  then run `reclassify()`. It re-labels rows already in the sheet without
  touching Gmail, without re-reading a single PDF, and without spending Gmail
  quota. **Never wipe the sheet and re-scan** — extraction is the expensive part
  and it was already correct.
- **Yellow rows** are the ones the model was unsure about. That is the feature.
  Fix them by hand; nothing overwrites your edits.
- **Column O on the budget tabs** is theirs to fill with a plan. Rebuilds never
  overwrite it.
- **Missing something obvious?** The most likely cause is the keyword filter.
  Add their bank, accountant or supplier's wording to `KEYWORDS` in
  `expense-agent.gs`, then run `restartBackfill('2026-03-01')` to redo from
  that date. Safe — rows dedupe on Gmail message id.
- **Want a different cadence later?** Change `SCANS_PER_DAY` and run `setup()`
  again. It rebuilds the triggers and never touches data.

---

## Reference files

Read these only when relevant — do not dump them at the user.

- `reference/architecture.md` — how the pieces fit, and why there are up to
  three projects.
- `reference/categories.md` — the default chart of accounts and how to change it.
- `reference/troubleshooting.md` — every failure I have actually seen, and the fix.
