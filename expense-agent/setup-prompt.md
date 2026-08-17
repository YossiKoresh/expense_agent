# Paste this into any agent

Use this if your agent doesn't pick up `SKILL.md` on its own — Codex, a plain
Claude chat, Cursor, whatever. Attach the whole `expense-agent` folder, then
paste everything below the line.

---

You are installing **Expense Agent** for me. It's an expense tracker that runs as
Google Apps Script inside my own Google account: it reads a Gmail mailbox, uses
Claude to identify real expenses, files invoice PDFs in Drive, writes a Google
Sheet ledger, and builds budget tabs I can click through to the underlying
invoices.

The files are attached. `scripts/expense-agent.gs` is the main script;
`scripts/drilldown.gs` is a small companion. Read `SKILL.md` for the full
procedure, and `reference/troubleshooting.md` if anything fails.

**Rules for you:**

- Never ask me for my Anthropic API key, and never offer to type it anywhere. I
  paste it into Apps Script Script Properties myself.
- Never ask for a Google password or try to drive a Google login.
- Do the configuration work yourself. Don't hand me a checklist and stop.

**Do this:**

1. Ask me all of these at once, not one at a time:
   - What does my business do? (one line — this is the highest-leverage answer,
     the classifier reads it before every decision)
   - Accounting currency?
   - Time zone?
   - How far back should the first scan go?
   - Track money coming in too, or expenses only?
   - One mailbox or two?
   - File invoice PDFs to Drive, or just keep the Gmail link?

2. Tell me to create a blank Google Sheet (and a Drive folder if I said yes to
   filing) and paste you both URLs. Extract the ids yourself:
   - `docs.google.com/spreadsheets/d/<ID>/edit`
   - `drive.google.com/drive/folders/<ID>`

3. Fill in the `CONFIG` block at the top of `expense-agent.gs` with my answers and give
   me the finished file **as a file**, not as a code block — it's ~44 KB and I
   have to paste it into an editor.

   For two mailboxes, generate two versions: one with `MODE: 'hub'` and one with
   `MODE: 'satellite'`, sharing a `SHARED_SECRET` you generate (32+ random
   characters). Leave the satellite's `HUB_URL` empty for now.

   Also set `EXPENSE_TAB` and `INCOME_TAB` in `drilldown.gs` to match.

4. Walk me through it, waiting for me to confirm each step:
   - script.google.com → New project → paste `expense-agent.gs` → save
   - Project Settings → Script properties → `ANTHROPIC_API_KEY` → my key → save
   - Editor → **Run** → authorize (Advanced → Go to project → Allow)
   - Read back what the execution log says

5. Then the drill-down: open my Sheet → **Extensions → Apps Script** → paste
   `drilldown.gs` → save → reload the sheet. It has to be created from inside
   the sheet, not from script.google.com, or the click trigger won't exist.

6. If I said two mailboxes, walk me through deploying the hub as a web app
   (Deploy → New deployment → Web app → Execute as Me, Access Anyone), then
   setting up the second account with the `/exec` URL as its `HUB_URL`. Tell me
   plainly what "Anyone" means before I click it.

7. Finally, have me run `status()` and confirm `hasApiKey: true`, two real model
   ids, and a row count that's climbing. Then tell me the four things I'll
   actually want later — how to change categories (`reclassify()`, never a
   re-scan), what the yellow rows mean, that column O on the budget tabs is mine
   to fill in, and how to fix something the keyword filter is missing.
