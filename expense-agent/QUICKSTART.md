# Quickstart — 10 minutes, start to finish

Nothing installs on your computer. There is no terminal, no npm, no Docker.
Everything runs inside your own Google account. If you have a browser and a
Google account, you have everything you need.

**Total time:** about 10 minutes, most of it waiting for Google's permission
screens.

---

## Before you start (2 minutes)

You need three things.

**1. A Google account** with the mailbox you want scanned. Personal Gmail is
fine. Workspace is better — it has a much higher daily quota.

**2. An Anthropic API key.** Go to
[console.anthropic.com](https://console.anthropic.com) → **API Keys** →
**Create Key**. Copy it somewhere for a moment. Add about $5 of credit — a
full year backfill of a busy mailbox costs a couple of dollars, and running it
day to day costs cents.

**3. A blank Google Sheet and a Drive folder.**
- Go to [sheets.new](https://sheets.new) — that's it, a blank sheet exists.
  Name it something like `Expenses`. Copy the URL.
- Go to [drive.google.com](https://drive.google.com) → **New → Folder** → call
  it `Invoices`. Open it and copy the URL.

Both must live in the same Google account as the mailbox.

---

## Step 1 — create the script (2 minutes)

1. Go to **[script.google.com](https://script.google.com)** → **New project**.
2. Click the title *Untitled project* at the top and rename it
   **`Expense Agent`**. (Not cosmetic — you will come back here.)
3. Click once in the code area, select all (**Cmd+A** on Mac, **Ctrl+A** on
   Windows), and paste the entire contents of `scripts/expense-agent.gs`.
4. **Cmd+S** / **Ctrl+S** to save.

---

## Step 2 — fill in the seven values (2 minutes)

Scroll to `SECTION 1 — CONFIG` near the top. Change these and nothing else:

| Setting | What to put |
|---|---|
| `SHEET_ID` | The long code in your Sheet URL, between `/d/` and `/edit` |
| `DRIVE_FOLDER_ID` | The code at the end of your folder URL, after `/folders/` |
| `BASE_CURRENCY` | `'USD'`, `'EUR'`, `'GBP'`, `'ILS'` … |
| `BUSINESS_DESCRIPTION` | One line about your business — see below |
| `BACKFILL_FROM` | How far back to scan, e.g. `'2026-01-01'` |
| `TZ` | `'America/New_York'`, `'Europe/London'`, `'Asia/Jerusalem'` … |
| `TRACK_INCOME` | `true` to also record payouts, `false` for expenses only |

**Spend thirty seconds on `BUSINESS_DESCRIPTION`.** It is read by the
classifier before every single decision and it is the difference between good
and mediocre results. Compare:

> ❌ `'my business'`
>
> ✅ `'Acme Ltd, a UK company selling handmade furniture online. We take card payments through Stripe, print catalogues with Northgate Print, and our accountant is Hartley & Cole. Groceries, home broadband and the family car are personal, not business.'`

The second one tells the model who your suppliers are, which processor to
expect payouts from, and what "personal" means for you. Save again.

---

## Step 3 — add your API key (1 minute)

1. Left sidebar → **⚙ Project Settings**.
2. Scroll to **Script Properties** → **Add script property**.
3. Property: `ANTHROPIC_API_KEY` — Value: your key.
4. **Save script properties**.

The key lives only in your own Google account. It is not in the code, so you
can share or publish your copy of the script safely.

---

## Step 4 — run it (2 minutes)

1. Back to **`< >` Editor**. The dropdown at the top should say **`RUN`**.
2. Click **Run**.
3. Google will show **"Authorization required"**. This is Google asking whether
   you trust your own script. Click **Review permissions** → choose your
   account → **"Google hasn't verified this app"** → **Advanced** → **Go to
   Expense Agent (unsafe)** → **Allow**.

   *That "unsafe" wording is what Google says about every unpublished script,
   including the one you just wrote. You are granting access to your own
   script, running in your own account.*

4. The **Execution log** should end with something like:

   ```
   models: claude-haiku-4-5 + claude-sonnet-4-5 | budgets rebuilt | backfill cursor at 2026-01-01
   ```

That's it. It is running.

---

## Step 5 — make the budget clickable (1 minute)

1. Open your **Google Sheet**.
2. **Extensions → Apps Script**. This opens a new project already attached to
   the sheet.
3. Select all, paste `scripts/drilldown.gs`, save.
4. If you changed any tab names in CONFIG, match them in the `DRILL` block at
   the top of that file. Nothing else in it needs touching.
5. Go back to the Sheet and reload the page.

---

## How to tell it's working

**After 1 minute** — open your Sheet. You should see new tabs: `Expenses`,
`Income`, `Budget 2026`, `Budget 2027`. They will be empty. That alone proves
the script can reach your sheet.

**After 5 minutes** — refresh. The `Expenses` tab should have rows in it, and
`Budget 2026` should have numbers in the January column. Check your Drive
folder: there should be a `2026` folder with month folders inside, containing
invoice PDFs with names like
`2026-01-14 Anthropic 20.00 USD #2180-6529.pdf`.

**After an hour** — most of a year of mail is usually done. It works through
one month every five minutes and stops by itself.

**To check on it any time:** go back to the script, change `RUN()`'s body to
`return status();`, save, and click Run. You want to see:

```
hasApiKey: true
models: two real model names
expenseRows: a number that goes up
cursor: a date that moves forward
```

**If something looks wrong:** left sidebar → **Executions**. Every run is
listed with its error. Then check `reference/troubleshooting.md`, which covers
every failure mode I have actually hit.

---

## Your first day with it

**Look at the yellow rows first.** Yellow means the model was not confident —
usually an amount it could not find, or a payout that did not state its fee.
It writes the row anyway rather than guessing a number into your books. Fix
them by hand; nothing will overwrite your edit.

**Check five rows against the real emails.** Click the Gmail link in each row.
This is the fastest way to find out whether your `BUSINESS_DESCRIPTION` is
doing its job.

**If categories are wrong,** don't re-scan. Edit `CATS` and `SECTION` at the
top of the script, then change `RUN()` to `return reclassify();` and run it.
That re-labels rows already in the sheet without opening Gmail or re-reading a
single PDF. Re-scanning is the slow, expensive, quota-burning way to fix a
labelling problem.

**Fill in column O on a budget tab** with what you *planned* to spend. Variance
and % of plan appear next to it automatically, and a rebuild will never
overwrite what you typed.

**Click a number on a budget tab,** then open the `Drill-down` tab — the exact
invoices behind that number are sitting there. It works on a single category,
a whole section, a whole month, a whole year, and the totals.

---

## Things worth knowing

- **It never deletes anything.** Not a row, not an email, not a file. The only
  thing it writes to Gmail is a label.
- **Re-running is always safe.** Every row carries its Gmail message id, so a
  message already in the sheet is never processed twice.
- **Consumer Gmail has a daily quota** that a full re-scan can exhaust. It
  resets at midnight Pacific. This is why `reclassify()` exists.
- **Your API key never leaves your Google account**, and no data goes anywhere
  except Google and the Anthropic API.

---

## Turning it off

- **Pause it:** script → **⏰ Triggers** in the left sidebar → delete them.
- **Remove it entirely:** delete the Apps Script project, and revoke its
  access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- Your Sheet, your Drive folder and your email are all untouched by either.
