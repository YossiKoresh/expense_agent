# Troubleshooting

Every item here is a failure that actually happened, not a hypothetical.

---

## Setup

**`No API key. Project Settings > Script Properties...`**
The key is not saved, or it is saved under the wrong name. It must be exactly
`ANTHROPIC_API_KEY`, in **Script properties** (not User properties), in the
project you are running.

**`None of the fast/smart models responded`**
The model ids in `MODEL_CANDIDATES` are all unavailable to that key. Open
`expense-agent.gs`, put a model id the key can use at the front of the relevant list,
save, run `setup()` again. `setup()` probes them with a 4-token request, so it
costs nothing to retry.

**`Anthropic 401`** — the key is wrong or was revoked.
**`Anthropic 400: credit balance is too low`** — top up at console.anthropic.com.

**The Run dropdown is greyed out or won't change**
Known Apps Script flakiness. That is why `RUN()` is the first function in the
file — the editor defaults to whichever function comes first. Edit `RUN()`'s
body to call what you want and press Run. If the dropdown still shows something
stale, reload the editor tab.

**"This app isn't verified"**
It is your own unpublished script; Google says this about every one of them.
**Advanced → Go to (project name) → Allow**.

---

## Running

**`Service invoked too many times for one day: gmail`**
The Gmail daily quota is spent. Consumer Gmail accounts get far less than
Workspace ones. It resets at **midnight Pacific**, not local midnight.

Since v1.0.2 this is handled: the guard catches it, marks the day as spent,
skips further runs, and schedules a resume for 10 minutes after the reset. You
should see `gmail quota hit ... resuming <timestamp>` in the log and nothing
more until then. That is working as intended, not a failure.

If you are seeing the raw exception on a loop, you are on an older copy. The
symptom is unmistakable and worth describing, because it cost a real install an
entire day: a 5-minute backfill trigger blew the quota, then failed at the
*first* Gmail call on every subsequent run. The cursor never advanced, so it
retried 288 times that day, ingested nothing, and burned the next day's
allowance the moment it reset. Two changes fixed it — the quota guard, and
replacing the 5-minute trigger with the self-chaining `catchUp()`.

Steady-state cost is near zero regardless: every thread the script has *looked
at* gets labelled, and labelled threads are excluded from all future searches.

**Rows are missing for a period the script says it scanned**
Almost certainly the flip side of the same mechanism: threads were labelled in
an earlier pass whose rows were later deleted, so they are now permanently
skipped. The label is only a speed optimisation — the real duplicate guard is
the Gmail message id in the `Email ID` column, so re-scanning is always safe.

The clean fix is to point at a **new** label rather than delete the old one:
change `CONFIG.LABEL` to e.g. `ExpenseAgent/Scanned2`, set `BF_CURSOR` back to the
month you want to redo, save. Nothing is deleted and nothing duplicates.

**`Exceeded maximum execution time`**
A single message with an enormous PDF. Lower `MAX_PDF_MB`, or lower
`MAX_PER_RUN` so each execution does less.

**The backfill is stuck on the same month**
By design: the cursor only advances when a month completes with zero errors.
Open **Executions** in the left sidebar, expand the failing run, read the error.

**The backfill is not running at all**
Check the triggers. `catchUp` deletes its own trigger when it finishes, and
`finishBackfill()` does the same — so moving `BF_CURSOR` back by hand does
nothing, because the thing that reads it no longer exists. Use
`restartBackfill('2026-01-01')`, which rewinds *and* restarts the chain.

**I want it to check more/less often**
Change `SCANS_PER_DAY` (1, 2, 4 or 24) and run `setup()` again. On consumer
Gmail, stay at 1 or 2.

---

## Accuracy

**Invoices the business ISSUED are showing up as expenses**
The single most common failure. Add the giveaway to `BUSINESS_DESCRIPTION` —
naming your own trading names and your payment processor helps a lot — then run
`reclassify()`. If they keep coming through, add an explicit line to the rules
list in `triage()`.

**A payout is counted twice**
Processors often send both a per-transaction email and a daily settlement
summary. `triage()` has a rule for this, but it only works if the summary is
recognisable. Check the wording of your processor's summary email and add it to
the rule.

**Amounts land as 0 and the row goes yellow**
The model genuinely could not find a figure — usually a Hebrew, Japanese or
scanned-image invoice where the total is inside the image. The row is flagged
rather than guessed. Fill it in by hand; nothing overwrites your edit.

**Foreign-currency rows have a blank base-currency amount**
frankfurter.app has no rate for that date or that currency pair (it does not
cover every currency, and it has no weekend rates for some). Enter the figure
by hand, or swap the URL in `toBase()` for a provider that covers your pair.

---

## Budget tabs

**A category is missing from the budget**
The budget only rebuilds when the category list changes, and it rebuilds from
the *live* list. Run `buildBudgets()` to force it.

**A category is sitting under UNASSIGNED**
It exists in the sheet but has no section in `SECTION`. Add it there and run
`buildBudgets()`.

**My Allocation numbers disappeared**
They should not — a rebuild reads column O by row label and writes it back. It
will lose them if the row *label* changed, i.e. you renamed a category. Rename
the category, then re-enter that one allocation.

**Clicking a budget cell does nothing**
- The drill-down script is not installed, or is not bound to the sheet. It must
  be created from **Extensions → Apps Script** inside the sheet, not from
  script.google.com.
- The sheet was not reloaded after saving it.
- The cell is a spacer, a `% of revenue` row, or the NET row — those have no tag.

**Drill-down shows 0 rows but the cell shows a number**
`EXPENSE_TAB` / `INCOME_TAB` in `drilldown.gs` do not match `CONFIG.TAB` /
`CONFIG.TAB_IN` in `expense-agent.gs`.

**Drill-down shows fewer rows than the cell adds up to**
This was a real bug, fixed in v1.0.1, and it is worth understanding because the
same trap will bite you if you write your own helpers against this sheet.

Sheets stores a month key like `2026-03` as a real Date at **midnight in the
spreadsheet's own timezone**. Format that Date in any other zone and 1 March
becomes 28 February — so rows silently fall into the wrong month and vanish from
the drill-down without any error. `mkey()` now reads
`SpreadsheetApp.getActive().getSpreadsheetTimeZone()` rather than a constant.
If you copy that function anywhere, keep that behaviour.

---

## Two-mailbox mode

**`hub rejected: {"error":"unauthorized"}`**
`SHARED_SECRET` differs between the two files, or the hub was edited after
deploying. Apps Script serves the **deployed version**, not the saved one:
**Deploy → Manage deployments → pencil → Version: New version → Deploy**.

Use *Manage deployments*, never *New deployment* — a new deployment gets a new
URL and silently breaks the satellite.

**The satellite runs clean but nothing appears**
It is posting somewhere else. Re-copy the `/exec` URL and check `HUB_URL`.
Run `ping` against it to confirm which account answers.
